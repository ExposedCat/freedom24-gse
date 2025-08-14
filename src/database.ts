import Gda5 from "gi://Gda?version=5.0";
import GLib from "gi://GLib";
import GObject from "gi://GObject";

export type PriceTrend = "up" | "down" | "same";

export type TickerData = {
	symbol: string;
	price: number;
	previousPrice?: number;
	timestamp: Date;
	isRealtime: boolean;
	trend?: PriceTrend;
};

export class TickerDatabase {
	private static instance: TickerDatabase | null = null;
	private connection: Gda5.Connection | null = null;
	private dbDir: string;

	private constructor() {
		const cacheDir = GLib.get_user_cache_dir();
		this.dbDir = GLib.build_filenamev([cacheDir, "panel-stocks"]);

		GLib.mkdir_with_parents(this.dbDir, 0o755);
	}

	static getInstance(): TickerDatabase {
		if (!TickerDatabase.instance) {
			TickerDatabase.instance = new TickerDatabase();
		}
		return TickerDatabase.instance;
	}

	async initialize(): Promise<boolean> {
		try {
			this.connection = new Gda5.Connection({
				provider: Gda5.Config.get_provider("SQLite"),
				cncString: `DB_DIR=${this.dbDir};DB_NAME=panel-stocks`,
			});

			this.connection.open();

			this.connection.execute_non_select_command(`
				CREATE TABLE IF NOT EXISTS ticker_prices (
					symbol TEXT NOT NULL PRIMARY KEY,
					price REAL NOT NULL,
					previous_price REAL,
					timestamp INTEGER NOT NULL,
					is_realtime INTEGER NOT NULL DEFAULT 1,
					trend TEXT DEFAULT 'same'
				);
			`);

			return true;
		} catch (error) {
			console.error("[DB] Failed to initialize database:", error);
			return false;
		}
	}

	async savePriceUpdate(
		symbol: string,
		price: number,
		isRealtime = true,
	): Promise<void> {
		if (!this.connection) return;

		try {
			const currentData = await this.getLatestPrice(symbol);
			const previousPrice = currentData?.price ?? price;

			let trend: PriceTrend = "same";
			if (price > previousPrice) {
				trend = "up";
			} else if (price < previousPrice) {
				trend = "down";
			}

			this.connection.execute_non_select_command(`
				INSERT OR REPLACE INTO ticker_prices (symbol, price, previous_price, timestamp, is_realtime, trend)
				VALUES ('${symbol}', ${price}, ${previousPrice}, ${Math.floor(Date.now() / 1000)}, ${Number(isRealtime)}, '${trend}')
			`);
		} catch (error) {
			console.error(`[DB] Failed to save price for ${symbol}:`, error);
		}
	}

	async getLatestPrice(symbol: string): Promise<TickerData | null> {
		if (!this.connection) return null;

		try {
			const builder = new Gda5.SqlBuilder({
				stmt_type: Gda5.SqlStatementType.SELECT,
			});

			builder.select_add_target("ticker_prices", "ticker_prices");
			builder.select_add_field("symbol", "ticker_prices", "symbol");
			builder.select_add_field("price", "ticker_prices", "price");
			builder.select_add_field(
				"previous_price",
				"ticker_prices",
				"previous_price",
			);
			builder.select_add_field("timestamp", "ticker_prices", "timestamp");
			builder.select_add_field("is_realtime", "ticker_prices", "is_realtime");
			builder.select_add_field("trend", "ticker_prices", "trend");
			const gval = new GObject.Value();
			gval.init(GObject.TYPE_STRING);
			gval.set_string(symbol);
			builder.set_where(
				builder.add_cond(
					Gda5.SqlOperatorType.EQ,
					builder.add_field_id("symbol", null),
					builder.add_expr_value(null, gval),
					0,
				),
			);

			const result = this.connection.statement_execute_select(
				builder.get_statement(),
				null,
			);
			const iterator = result.create_iter();

			if (iterator.move_next()) {
				return this.parseTickerFromIter(iterator);
			}
		} catch (error) {
			console.error(`[DB] Failed to get price for ${symbol}:`, error);
		}

		return null;
	}

	async getAllLatestPrices(
		symbols: string[],
	): Promise<Map<string, TickerData>> {
		const prices = new Map<string, TickerData>();

		if (!this.connection || symbols.length === 0) return prices;

		try {
			const builder = new Gda5.SqlBuilder({
				stmt_type: Gda5.SqlStatementType.SELECT,
			});
			builder.select_add_target("ticker_prices", "ticker_prices");
			builder.select_add_field("symbol", "ticker_prices", "symbol");
			builder.select_add_field("price", "ticker_prices", "price");
			builder.select_add_field(
				"previous_price",
				"ticker_prices",
				"previous_price",
			);
			builder.select_add_field("timestamp", "ticker_prices", "timestamp");
			builder.select_add_field("is_realtime", "ticker_prices", "is_realtime");
			builder.select_add_field("trend", "ticker_prices", "trend");

			let whereId: number | null = null;
			for (const symbol of symbols) {
				const gval = new GObject.Value();
				gval.init(GObject.TYPE_STRING);
				gval.set_string(symbol);
				const eqId = builder.add_cond(
					Gda5.SqlOperatorType.EQ,
					builder.add_field_id("symbol", null),
					builder.add_expr_value(null, gval),
					0,
				);
				if (whereId === null) {
					whereId = eqId;
				} else {
					whereId = builder.add_cond(Gda5.SqlOperatorType.OR, whereId, eqId, 0);
				}
			}
			if (whereId !== null) builder.set_where(whereId);

			const result = this.connection.statement_execute_select(
				builder.get_statement(),
				null,
			);
			const iterator = result.create_iter();
			while (iterator.move_next()) {
				const parsed = this.parseTickerFromIter(iterator);
				prices.set(parsed.symbol, parsed);
			}
		} catch (error) {
			console.error("[DB] Failed to get all prices:", error);
		}

		return prices;
	}

	private getValue<T>(iterator: Gda5.DataModelIter, field: string): T {
		return iterator.get_value_for_field(field) as unknown as T;
	}

	private parseTickerFromIter(iterator: Gda5.DataModelIter): TickerData {
		const symbolValue = this.getValue<string>(iterator, "symbol");
		const priceValue = this.getValue<number>(iterator, "price");
		const previousPriceValue = this.getValue<number>(
			iterator,
			"previous_price",
		);
		const timestampValue = this.getValue<number>(iterator, "timestamp");
		const isRealtimeValue = this.getValue<number>(iterator, "is_realtime");
		const trendValue = this.getValue<string>(iterator, "trend");

		return {
			symbol: symbolValue,
			price: priceValue,
			previousPrice: previousPriceValue || undefined,
			timestamp: new Date(timestampValue * 1000),
			isRealtime: Boolean(isRealtimeValue),
			trend: (trendValue as PriceTrend) || "same",
		};
	}

	async cleanup(): Promise<void> {
		if (this.connection) {
			this.connection.close();
			this.connection = null;
		}
	}

	static async initializeGlobal(): Promise<void> {
		const db = TickerDatabase.getInstance();
		await db.initialize();
	}

	static async savePrice(
		symbol: string,
		price: number,
		isRealtime = true,
	): Promise<void> {
		const db = TickerDatabase.getInstance();
		await db.savePriceUpdate(symbol, price, isRealtime);
	}

	static async getPrice(symbol: string): Promise<TickerData | null> {
		const db = TickerDatabase.getInstance();
		return db.getLatestPrice(symbol);
	}

	static async getAllPrices(
		symbols: string[],
	): Promise<Map<string, TickerData>> {
		const db = TickerDatabase.getInstance();
		return db.getAllLatestPrices(symbols);
	}

	static async cleanupGlobal(): Promise<void> {
		const db = TickerDatabase.getInstance();
		await db.cleanup();
	}
}
