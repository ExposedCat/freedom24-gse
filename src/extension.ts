import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import St from "gi://St";
import Clutter from "gi://Clutter";
import GLib from "gi://GLib";
import type Gio from "gi://Gio";

type StockData = {
	symbol: string;
	price: number;
};

export default class GnomeShellExtension extends Extension {
	private _panelButton: PanelMenu.Button | null = null;
	private _label: St.Label | null = null;
	private _updateTimeoutId: number | null = null;
	private _settings: Gio.Settings | null = null;
	private _settingsChangedId: number | null = null;

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
			this._updateDisplay();
		});

		this._updateDisplay();
		this._startUpdateLoop();
	}

	disable() {
		if (this._settingsChangedId && this._settings) {
			this._settings.disconnect(this._settingsChangedId);
			this._settingsChangedId = null;
		}

		if (this._updateTimeoutId) {
			GLib.source_remove(this._updateTimeoutId);
			this._updateTimeoutId = null;
		}

		if (this._panelButton) {
			this._panelButton.destroy();
			this._panelButton = null;
		}

		this._label = null;
		this._settings = null;
	}

	private async _fetchStockPrice(symbol: string): Promise<StockData | null> {
		return { symbol, price: 20.0 };
	}

	private async _updateDisplay() {
		if (!this._settings || !this._label) return;

		const tickers = this._settings.get_strv("tickers");

		if (tickers.length === 0) {
			this._label.set_text("No tickers");
			return;
		}

		try {
			const stockPromises = tickers.map((ticker) =>
				this._fetchStockPrice(ticker),
			);
			const results = await Promise.all(stockPromises);
			const validStocks = results.filter(
				(stock): stock is StockData => stock !== null,
			);

			if (validStocks.length === 0) {
				this._label.set_text("No data");
				return;
			}

			const displayText = validStocks
				.map(
					(stock) =>
						`<span color="white">${stock.symbol}</span> <span color="#4ade80">$${stock.price}</span>`,
				)
				.join(" · ");

			this._label.clutter_text.set_markup(displayText);
		} catch (error) {
			this._label.set_text("Error");
		}
	}

	private _startUpdateLoop() {
		this._updateTimeoutId = GLib.timeout_add_seconds(
			GLib.PRIORITY_DEFAULT,
			300,
			() => {
				this._updateDisplay();
				return GLib.SOURCE_CONTINUE;
			},
		);
	}
}
