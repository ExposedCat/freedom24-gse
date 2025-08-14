import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import St from "gi://St";
import Clutter from "gi://Clutter";
import GLib from "gi://GLib";
import type Gio from "gi://Gio";
import { TradenetWebSocket } from "./websocket.js";
import { TickerDatabase, type PriceTrend } from "./database.js";

export default class GnomeShellExtension extends Extension {
	private _panelButton: PanelMenu.Button | null = null;
	private _label: St.Label | null = null;
	private _settings: Gio.Settings | null = null;
	private _settingsChangedId: number | null = null;
	private _sidChangedId: number | null = null;
	private _passwordChangedId: number | null = null;
	private _tickerPrices = new Map<
		string,
		{ price: number; isRealtime: boolean; trend: PriceTrend }
	>();
	private _isConnected = false;
	private _reconnectTimeoutId: number | null = null;
	private _reconnectDebounceMs = 1000;
	private _persistTimeoutId: number | null = null;
	private _persistDebounceMs = 3000;
	private _pendingPersist = new Set<string>();

	enable() {
		this._settings = this.getSettings();

		this._panelButton = new PanelMenu.Button(0.0, "Stock Tickers", false);

		this._label = new St.Label({
			text: "Loading...",
			y_align: Clutter.ActorAlign.CENTER,
			style_class: "panel-stocks-label",
		});
		this._label.clutter_text.use_markup = true;

		this._panelButton.add_child(this._label);
		Main.panel.addToStatusArea("stock-tickers", this._panelButton, 1, "left");

		this._settingsChangedId = this._settings.connect("changed::tickers", () => {
			this._updateSubscriptions();
		});

		this._sidChangedId = this._settings.connect(
			"changed::tradernet-login",
			() => {
				this._debouncedReconnect();
			},
		);

		this._passwordChangedId = this._settings.connect(
			"changed::tradernet-password",
			() => {
				this._debouncedReconnect();
			},
		);

		TradenetWebSocket.addPriceUpdateCallback(
			(ticker: string, price: number) => {
				this._onPriceUpdate(ticker, price);
			},
		);

		this._initializeAsync();
	}

	disable() {
		if (this._settingsChangedId && this._settings) {
			this._settings.disconnect(this._settingsChangedId);
			this._settingsChangedId = null;
		}

		if (this._sidChangedId && this._settings) {
			this._settings.disconnect(this._sidChangedId);
			this._sidChangedId = null;
		}

		if (this._passwordChangedId && this._settings) {
			this._settings.disconnect(this._passwordChangedId);
			this._passwordChangedId = null;
		}

		if (this._reconnectTimeoutId) {
			GLib.source_remove(this._reconnectTimeoutId);
			this._reconnectTimeoutId = null;
		}

		if (this._persistTimeoutId) {
			GLib.source_remove(this._persistTimeoutId);
			this._persistTimeoutId = null;
		}

		TradenetWebSocket.disconnect();
		TickerDatabase.cleanupGlobal();

		if (this._panelButton) {
			this._panelButton.destroy();
			this._panelButton = null;
		}

		this._label = null;
		this._settings = null;
		this._tickerPrices.clear();
		this._isConnected = false;
	}

	private async _initializeAsync() {
		await TickerDatabase.initializeGlobal();

		await this._loadHistoricalData();

		this._connectWebSocket();
	}

	private async _loadHistoricalData() {
		if (!this._settings) return;

		const tickers = this._settings.get_strv("tickers");
		if (tickers.length === 0) return;

		try {
			const historicalData =
				await TradenetWebSocket.getHistoricalPrices(tickers);
			for (const [ticker, data] of historicalData) {
				this._tickerPrices.set(ticker, {
					price: data.price,
					isRealtime: data.isRealtime,
					trend: data.trend,
				});
			}
			this._updateDisplay();
		} catch (error) {
			console.error("[Extension] Failed to load historical data:", error);
		}
	}

	private _debouncedReconnect() {
		if (this._reconnectTimeoutId) {
			GLib.source_remove(this._reconnectTimeoutId);
		}

		this._reconnectTimeoutId = GLib.timeout_add(
			GLib.PRIORITY_DEFAULT,
			this._reconnectDebounceMs,
			() => {
				this._connectWebSocket();
				this._reconnectTimeoutId = null;
				return GLib.SOURCE_REMOVE;
			},
		);
	}

	private async _connectWebSocket() {
		if (!this._settings) return;

		const login = this._settings.get_string("tradernet-login");
		const password = this._settings.get_string("tradernet-password");

		if (!login || !password) {
			this._isConnected = false;
			this._updateDisplay();
			return;
		}

		try {
			this._isConnected = await TradenetWebSocket.authenticateAndConnect(
				login,
				password,
			);
			if (this._isConnected) this._updateSubscriptions();
			this._updateDisplay();
		} catch (error) {
			console.error("[Extension] WebSocket connection failed:", error);
			this._isConnected = false;
			this._updateDisplay();
		}
	}

	private _updateSubscriptions() {
		if (!this._settings) return;

		const tickers = this._settings.get_strv("tickers");
		TradenetWebSocket.subscribeToTickers(tickers);

		this._loadHistoricalData();
	}

	private _onPriceUpdate(ticker: string, price: number) {
		const previous = this._tickerPrices.get(ticker);
		let trend: PriceTrend = "same";
		if (previous) {
			if (price > previous.price) trend = "up";
			else if (price < previous.price) trend = "down";
		}
		this._tickerPrices.set(ticker, { price, isRealtime: true, trend });
		this._updateDisplay();

		this._pendingPersist.add(ticker);
		this._schedulePersist();
	}

	private _schedulePersist() {
		if (this._persistTimeoutId) {
			GLib.source_remove(this._persistTimeoutId);
		}
		this._persistTimeoutId = GLib.timeout_add(
			GLib.PRIORITY_DEFAULT,
			this._persistDebounceMs,
			() => {
				this._flushPersist();
				this._persistTimeoutId = null;
				return GLib.SOURCE_REMOVE;
			},
		);
	}

	private async _flushPersist() {
		const tickersToSave = Array.from(this._pendingPersist);
		this._pendingPersist.clear();
		for (const symbol of tickersToSave) {
			const data = this._tickerPrices.get(symbol);
			if (!data) continue;

			TickerDatabase.savePrice(symbol, data.price, true).catch((error) => {
				console.error(`[Extension] Failed to persist ${symbol}:`, error);
			});
		}
	}

	private _updateDisplay() {
		if (!this._settings || !this._label) return;

		const tickers = this._settings.get_strv("tickers");

		if (tickers.length === 0) {
			this._label.set_text("No tickers");
			return;
		}

		if (!this._isConnected) {
			this._label.set_text("Disconnected");
			return;
		}

		const validStocks = tickers
			.map((ticker) => {
				const data = this._tickerPrices.get(ticker);
				return data !== undefined
					? {
							symbol: ticker,
							price: data.price,
							isRealtime: data.isRealtime,
							trend: data.trend,
						}
					: null;
			})
			.filter((stock): stock is NonNullable<typeof stock> => stock !== null);

		if (validStocks.length === 0) {
			this._label.set_text("Waiting for data...");
			return;
		}

		const displayText = validStocks
			.map((stock) => {
				let priceColor = "white";
				if (stock.trend === "up") {
					priceColor = "#30d475";
				} else if (stock.trend === "down") {
					priceColor = "#f66151";
				}
				return `<span color="white">${stock.symbol}</span> <span color="${priceColor}">$${stock.price.toFixed(2)}</span>`;
			})
			.join(" · ");

		this._label.clutter_text.set_markup(displayText);
	}
}
