import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import St from "gi://St";
import Clutter from "gi://Clutter";
import GLib from "gi://GLib";
import type Gio from "gi://Gio";
import { TradenetWebSocket } from "./websocket.js";
import { TickerDatabase } from "./database.js";

type StockData = {
	symbol: string;
	price: number;
	isRealtime: boolean;
};

export default class GnomeShellExtension extends Extension {
	private _panelButton: PanelMenu.Button | null = null;
	private _label: St.Label | null = null;
	private _settings: Gio.Settings | null = null;
	private _settingsChangedId: number | null = null;
	private _sidChangedId: number | null = null;
	private _passwordChangedId: number | null = null;
	private _tickerPrices = new Map<
		string,
		{ price: number; isRealtime: boolean }
	>();
	private _isConnected = false;
	private _reconnectTimeoutId: number | null = null;
	private _reconnectDebounceMs = 1000;

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

		// Set up WebSocket price update callback
		TradenetWebSocket.addPriceUpdateCallback(
			(ticker: string, price: number) => {
				this._onPriceUpdate(ticker, price);
			},
		);

		// Initialize database and then connect
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
		// Initialize database first
		await TickerDatabase.initializeGlobal();

		// Load historical data for current tickers
		await this._loadHistoricalData();

		// Connect to WebSocket
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
				});
			}
			this._updateDisplay();
		} catch (error) {
			console.error("[Extension] Failed to load historical data:", error);
		}
	}

	private _debouncedReconnect() {
		// Clear existing timeout
		if (this._reconnectTimeoutId) {
			GLib.source_remove(this._reconnectTimeoutId);
		}

		// Set new timeout for debounced reconnection
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
			if (this._isConnected) {
				this._updateSubscriptions();
			}
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

		// Load historical data for any new tickers
		this._loadHistoricalData();
	}

	private _onPriceUpdate(ticker: string, price: number) {
		this._tickerPrices.set(ticker, { price, isRealtime: true });
		this._updateDisplay();
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
					? { symbol: ticker, price: data.price, isRealtime: data.isRealtime }
					: null;
			})
			.filter((stock): stock is NonNullable<typeof stock> => stock !== null);

		if (validStocks.length === 0) {
			this._label.set_text("Waiting for data...");
			return;
		}

		const displayText = validStocks
			.map((stock) => {
				// Use yellow color for historical data, green for real-time
				const priceColor = stock.isRealtime ? "#4ade80" : "#eab308";
				return `<span color="white">${stock.symbol}</span> <span color="${priceColor}">$${stock.price.toFixed(2)}</span>`;
			})
			.join(" · ");

		this._label.clutter_text.set_markup(displayText);
	}
}
