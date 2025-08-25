import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";
import St from "gi://St";
import Clutter from "gi://Clutter";
import GLib from "gi://GLib";
import type Gio from "gi://Gio";
import {
	TradenetWebSocket,
	getMarketState,
	type PortfolioPosition,
} from "./websocket.js";
import { TickerDatabase, type PriceTrend } from "./database.js";
import {
	formatTicker,
	formatMoneyChange,
	formatPercentageChange,
	formatTimeLeft,
	formatPrice,
} from "./utils/format.js";

export default class GnomeShellExtension extends Extension {
	private _panelButton: PanelMenu.Button | null = null;
	private _label: St.Label | null = null;
	private _portfolioSection: PopupMenu.PopupMenuSection | null = null;
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

	private _connectionStateCallback: ((isConnected: boolean) => void) | null =
		null;
	private _portfolioUpdateCallback: ((tickers: string[]) => void) | null = null;
	private _portfolioTickers: string[] = [];
	private _portfolioPositions: PortfolioPosition[] = [];

	private _getPortfolioQuoteSymbols(): string[] {
		const symbols = new Set<string>();
		for (const position of this._portfolioPositions) {
			if (position.instrument) symbols.add(position.instrument);
			if (position.baseContractCode) symbols.add(position.baseContractCode);
		}
		return Array.from(symbols);
	}

	private async _preloadPortfolioBasePrices() {
		const baseSymbols = this._getPortfolioQuoteSymbols();
		if (baseSymbols.length === 0) return;
		try {
			const historicalData =
				await TradenetWebSocket.getHistoricalPrices(baseSymbols);
			for (const [ticker, data] of historicalData) {
				this._tickerPrices.set(ticker, {
					price: data.price,
					isRealtime: data.isRealtime,
					trend: data.trend,
				});
			}
		} catch {}
	}

	enable() {
		this._settings = this.getSettings();

		this._panelButton = new PanelMenu.Button(0.0, "Stock Tickers", false);

		this._label = new St.Label({
			text: "Loading...",
			y_align: Clutter.ActorAlign.CENTER,
			style_class: "freedom24-label",
		});
		this._label.clutter_text.use_markup = true;

		this._panelButton.add_child(this._label);

		this._portfolioSection = new PopupMenu.PopupMenuSection();
		const menuWithAdd: { addMenuItem: (item: unknown) => void } = this
			._panelButton.menu as unknown as { addMenuItem: (item: unknown) => void };
		menuWithAdd.addMenuItem(this._portfolioSection);
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

		this._portfolioUpdateCallback = (tickers: string[]) => {
			this._portfolioTickers = tickers;
			this._portfolioPositions = TradenetWebSocket.getPortfolioPositions();
			void this._preloadPortfolioBasePrices();
			this._updateSubscriptions();
			this._rebuildPortfolioMenu();
		};
		TradenetWebSocket.addPortfolioUpdateCallback(this._portfolioUpdateCallback);

		this._connectionStateCallback = (isConnected: boolean) => {
			this._isConnected = isConnected;
			this._updateDisplay();
		};
		TradenetWebSocket.addConnectionStateCallback(this._connectionStateCallback);

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

		if (this._connectionStateCallback) {
			TradenetWebSocket.removeConnectionStateCallback(
				this._connectionStateCallback,
			);
			this._connectionStateCallback = null;
		}

		TradenetWebSocket.disconnect();
		TickerDatabase.cleanupGlobal();

		if (this._panelButton) {
			this._panelButton.destroy();
			this._panelButton = null;
		}

		this._label = null;
		this._portfolioSection = null;
		this._settings = null;
		this._tickerPrices.clear();
		this._isConnected = false;
		if (this._portfolioUpdateCallback) {
			TradenetWebSocket.removePortfolioUpdateCallback(
				this._portfolioUpdateCallback,
			);
			this._portfolioUpdateCallback = null;
		}
	}

	private async _initializeAsync() {
		await TickerDatabase.initializeGlobal();

		await this._loadHistoricalData();

		this._connectWebSocket();

		this._portfolioTickers = TradenetWebSocket.getPortfolioTickers();
		this._portfolioPositions = TradenetWebSocket.getPortfolioPositions();
		this._rebuildPortfolioMenu();
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

		const userTickers = this._settings.get_strv("tickers");
		const portfolioSymbols = this._getPortfolioQuoteSymbols();
		const unique = Array.from(new Set([...userTickers, ...portfolioSymbols]));
		TradenetWebSocket.subscribeToTickers(unique);

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
		this._rebuildPortfolioMenu();
	}

	private _updateDisplay() {
		if (!this._settings || !this._label) return;

		const tickers = this._settings.get_strv("tickers");

		if (tickers.length === 0) {
			this._label.set_text("No tickers");
			return;
		}

		if (!TradenetWebSocket.isConnected()) {
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
				const displaySymbol = formatTicker(stock.symbol);
				return `<span foreground="white">${displaySymbol}</span> <span foreground="${priceColor}">$${stock.price.toFixed(2)}</span>`;
			})
			.join(" · ");

		this._label.clutter_text.set_markup(displayText);
		const state = getMarketState();
		this._label.opacity = state === "closed" ? 255 * 0.3 : 255;
	}

	private _rebuildPortfolioMenu() {
		if (!this._portfolioSection) return;
		this._portfolioSection.removeAll();
		if (this._portfolioPositions.length === 0) {
			const item = new PopupMenu.PopupMenuItem("No positions", {
				reactive: false,
			});
			this._portfolioSection.addMenuItem(item);
			return;
		}
		for (const position of this._portfolioPositions) {
			const text = this._formatPosition(position);
			const item = new PopupMenu.PopupMenuItem(text, { reactive: true });
			this._portfolioSection.addMenuItem(item);
		}
	}

	private _formatPosition(position: PortfolioPosition): string {
		const base = (position.baseContractCode || position.instrument).replace(
			/\.US$/,
			"",
		);
		const startPrice = position.priceA * position.faceValA * position.quantity;
		const marketOrClose =
			position.marketPrice !== null
				? position.marketPrice
				: position.closePrice !== null
					? position.closePrice
					: 0;
		const fallbackMultiplier =
			position.contractMultiplier ?? position.faceValA ?? 1;
		const liveEntry = this._tickerPrices.get(position.instrument);
		const perContractValue = liveEntry
			? liveEntry.price
			: marketOrClose * fallbackMultiplier;
		const currentPrice = perContractValue * position.quantity;
		const profit = currentPrice - startPrice;
		const percent = startPrice !== 0 ? (profit / startPrice) * 100 : 0;
		const stateIcon = profit > 0 ? "🟢" : profit < 0 ? "🔴" : "⚪";
		const firstLine = `${stateIcon} ${base} ${formatMoneyChange(profit)} ${formatPercentageChange(percent)}`;

		const baseSymbol = position.baseContractCode || position.instrument;
		const basePriceEntry = this._tickerPrices.get(baseSymbol);
		const baseTickerPrice = basePriceEntry
			? basePriceEntry.price
			: marketOrClose;
		const strikeMatch = position.instrument.split("C").at(-1);
		const strike = strikeMatch ? Number(strikeMatch) : 0;
		const strikeChange = baseTickerPrice - strike;
		const timeFromNow = formatTimeLeft(new Date(), new Date(position.maturity));
		const secondLine = `${formatPrice(currentPrice)} · ${formatPrice(baseTickerPrice)} (${formatMoneyChange(strikeChange)}) · ${timeFromNow}`;

		const openOrderLine = "";
		return `${firstLine}\n${secondLine}${openOrderLine}`;
	}
}
