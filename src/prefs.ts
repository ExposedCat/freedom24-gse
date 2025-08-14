import { ExtensionPreferences } from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";
import Gtk from "gi://Gtk";
import Gio from "gi://Gio";
import Adw from "gi://Adw";
import Gdk from "gi://Gdk";
import GObject from "gi://GObject";

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
	private _tickerRows = new Map<string, Adw.ActionRow>();
	fillPreferencesWindow(window: SettingsWindow) {
		window._settings = this.getSettings();

		const settings = window._settings;

		const page = new Adw.PreferencesPage({
			title: "General",
			icon_name: "preferences-other-symbolic",
		});
		window.add(page);

		const authGroup = new Adw.PreferencesGroup({
			title: "Authentication",
			description: "Tradernet WebSocket authentication settings",
		});
		page.add(authGroup);

		const loginRow = new Adw.EntryRow({
			title: "Login",
			text: settings.get_string("tradernet-login"),
		});
		this.bindStringRow(settings, loginRow, "tradernet-login");
		authGroup.add(loginRow);

		const passwordRow = new Adw.PasswordEntryRow({
			title: "Password",
			text: settings.get_string("tradernet-password"),
		});
		this.bindStringRow(settings, passwordRow, "tradernet-password");
		authGroup.add(passwordRow);

		const tickersGroup = new Adw.PreferencesGroup({
			title: "Stock Tickers",
		});
		page.add(tickersGroup);

		const entryRow = new Adw.EntryRow({
			title: "Add Ticker",
			text: "",
		});
		entryRow.add_suffix(this.createAddButton(entryRow, settings, tickersGroup));
		tickersGroup.add(entryRow);

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
		this._tickerRows.clear();
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
		if (this._tickerRows.has(ticker)) return;
		const row = new Adw.ActionRow({
			title: ticker,
		});

		const dragHandle = new Gtk.Button({
			icon_name: "list-drag-handle-symbolic",
			valign: Gtk.Align.CENTER,
			tooltip_text: "Drag to reorder",
		});
		dragHandle.add_css_class("flat");
		dragHandle.add_css_class("circular");
		row.add_prefix(dragHandle);

		const removeButton = new Gtk.Button({
			icon_name: "user-trash-symbolic",
			valign: Gtk.Align.CENTER,
			tooltip_text: "Remove ticker",
		});
		removeButton.add_css_class("flat");
		removeButton.add_css_class("circular");
		removeButton.add_css_class("destructive-action");
		removeButton.connect("clicked", () => {
			this.removeTicker(settings, ticker, tickersGroup);
		});

		row.add_suffix(removeButton);

		const dragSource = new Gtk.DragSource();
		dragSource.set_actions(Gdk.DragAction.MOVE);

		dragSource.connect("prepare", () => {
			const value = new GObject.Value();
			value.init(GObject.TYPE_STRING);
			value.set_string(ticker);
			return Gdk.ContentProvider.new_for_value(value);
		});

		dragHandle.add_controller(dragSource);

		const rowDropTarget = new Gtk.DropTarget();
		rowDropTarget.set_gtypes([GObject.TYPE_STRING]);
		rowDropTarget.set_actions(Gdk.DragAction.MOVE);
		rowDropTarget.connect("drop", (_target, value) => {
			const draggedTicker = value as unknown as string;
			if (!draggedTicker || draggedTicker === ticker) return false;

			const current = this.getTickers(settings);
			const fromIndex = current.indexOf(draggedTicker);
			const toIndex = current.indexOf(ticker);
			if (fromIndex === -1 || toIndex === -1) return false;

			const reordered = [...current];
			reordered.splice(fromIndex, 1);

			let insertAt: number;
			if (fromIndex < toIndex) {
				insertAt = toIndex === fromIndex + 1 ? toIndex : toIndex - 1;
			} else {
				insertAt = toIndex;
			}

			reordered.splice(insertAt, 0, draggedTicker);

			this.setTickers(settings, reordered);
			this.rebuildTickerList(settings, tickersGroup);
			return true;
		});
		row.add_controller(rowDropTarget);

		tickersGroup.add(row);
		this._tickerRows.set(ticker, row);
	}

	private removeTicker(
		settings: Gio.Settings,
		ticker: string,
		tickersGroup: Adw.PreferencesGroup,
	) {
		const current = this.getTickers(settings);
		const next = current.filter((t) => t !== ticker);
		this.setTickers(settings, next);
		const row = this._tickerRows.get(ticker);
		if (row) {
			tickersGroup.remove(row);
			this._tickerRows.delete(ticker);
		}
	}

	private rebuildTickerList(
		settings: Gio.Settings,
		tickersGroup: Adw.PreferencesGroup,
	) {
		for (const row of this._tickerRows.values()) {
			tickersGroup.remove(row);
		}
		this._tickerRows.clear();
		const tickers = this.getTickers(settings);
		for (const ticker of tickers) {
			this.appendTickerRow(tickersGroup, settings, ticker);
		}
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
