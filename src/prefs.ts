import { ExtensionPreferences } from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";
import Gtk from "gi://Gtk";
import Gio from "gi://Gio";
import Adw from "gi://Adw";

export type SettingsWindow = Adw.PreferencesWindow & {
	_settings: Gio.Settings;
};

export type BuildNumberRowArgs = {
	settings: Gio.Settings;
	row: Adw.SpinRow;
	key: string;
	maxRow?: Adw.SpinRow | null;
	maxKey?: string;
	range?: [number, number, number];
};

export default class PreferencesManager extends ExtensionPreferences {
	fillPreferencesWindow(window: SettingsWindow) {
		window._settings = this.getSettings();

		const settings = window._settings;

		// Main page
		const page = new Adw.PreferencesPage({
			title: "General",
			icon_name: "preferences-other-symbolic",
		});
		window.add(page);

		// Stock Tickers Group
		const tickersGroup = new Adw.PreferencesGroup({
			title: "Stock Tickers",
		});
		page.add(tickersGroup);

		// Combined entry and add button row
		const entryRow = new Adw.EntryRow({
			title: "Add Ticker",
			text: "",
		});
		entryRow.add_suffix(this.createAddButton(entryRow, settings, tickersGroup));
		tickersGroup.add(entryRow);

		// Initialize ticker management
		this.setupTickerManagement(settings, entryRow, tickersGroup);
	}

	private createAddButton(
		entryRow: Adw.EntryRow,
		settings: Gio.Settings,
		tickersGroup: Adw.PreferencesGroup,
	): Gtk.Button {
		const addButton = new Gtk.Button({
			icon_name: "list-add-symbolic",
			valign: Gtk.Align.CENTER,
			halign: Gtk.Align.CENTER,
		});
		addButton.add_css_class("suggested-action");
		addButton.add_css_class("circular");

		const addTicker = () => {
			const raw = entryRow.text;
			const ticker = this.toTicker(raw);
			if (!ticker || !this.isValidTicker(ticker)) {
				entryRow.add_css_class("error");
				return;
			}
			entryRow.remove_css_class("error");

			const current = this.getTickers(settings);
			if (current.includes(ticker)) {
				entryRow.text = "";
				return;
			}

			const next = [...current, ticker];
			this.setTickers(settings, next);
			this.appendTickerRow(tickersGroup, settings, ticker);
			entryRow.text = "";
		};

		addButton.connect("clicked", addTicker);
		entryRow.connect("activate", addTicker);

		return addButton;
	}

	private setupTickerManagement(
		settings: Gio.Settings,
		entryRow: Adw.EntryRow,
		tickersGroup: Adw.PreferencesGroup,
	) {
		// Initial population
		const tickers = this.getTickers(settings);
		for (const ticker of tickers) {
			this.appendTickerRow(tickersGroup, settings, ticker);
		}
	}

	private toTicker(value: string): string {
		return value.trim().toUpperCase();
	}

	private isValidTicker(value: string): boolean {
		return (
			/^[A-Z0-9.-]+$/.test(value) && value.length >= 1 && value.length <= 10
		);
	}

	private getTickers(settings: Gio.Settings): string[] {
		return settings.get_strv("tickers");
	}

	private setTickers(settings: Gio.Settings, tickers: string[]) {
		settings.set_strv("tickers", tickers);
	}

	private appendTickerRow(
		tickersGroup: Adw.PreferencesGroup,
		settings: Gio.Settings,
		ticker: string,
	) {
		const row = new Adw.ActionRow({
			title: ticker,
		});

		const removeButton = new Gtk.Button({
			icon_name: "user-trash-symbolic",
			valign: Gtk.Align.CENTER,
			halign: Gtk.Align.CENTER,
		});
		removeButton.add_css_class("flat");
		removeButton.add_css_class("circular");
		removeButton.add_css_class("destructive-action");

		removeButton.connect("clicked", () => {
			const current = this.getTickers(settings);
			const next = current.filter((t) => t !== ticker);
			this.setTickers(settings, next);
			tickersGroup.remove(row);
		});

		row.add_suffix(removeButton);
		tickersGroup.add(row);
	}

	bindStringRow(settings: Gio.Settings, row: Adw.EntryRow, key: string) {
		settings.bind(key, row, "text", Gio.SettingsBindFlags.DEFAULT);
	}

	bindNumberRow(args: BuildNumberRowArgs) {
		const { row, range = [0, 500, 1], settings, key, maxKey, maxRow } = args;
		row.adjustment = new Gtk.Adjustment({
			lower: range[0],
			upper: range[1],
			step_increment: range[2],
		});
		row.value = settings.get_int(key);
		row.connect("notify::value", (spin) => {
			const newValue = spin.get_value();
			settings.set_int(key, newValue);
			if (maxKey) {
				const maxValue = settings.get_int(maxKey);
				if (maxValue < newValue) {
					settings.set_int(maxKey, newValue);
					if (maxRow) {
						maxRow.value = newValue;
					}
				}
			}
		});
	}
}
