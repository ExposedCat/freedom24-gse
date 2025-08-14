import Gda5 from "gi://Gda?version=5.0";
import GLib from "gi://GLib";

type TickerData = {
	symbol: string;
	price: number;
	timestamp: Date;
	isRealtime: boolean;
};

export class TickerDatabase {
	private static instance: TickerDatabase | null = null;
	private connection: Gda5.Connection | null = null;
	private dbDir: string;

	private constructor() {
		// Store database in user's cache directory
		const cacheDir = GLib.get_user_cache_dir();
		this.dbDir = GLib.build_filenamev([cacheDir, "panel-stocks"]);

		// Ensure directory exists
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

			// Create table if not exists
			this.connection.execute_non_select_command(`
				CREATE TABLE IF NOT EXISTS ticker_prices (
					symbol TEXT NOT NULL PRIMARY KEY,
					price REAL NOT NULL,
					timestamp INTEGER NOT NULL,
					is_realtime INTEGER NOT NULL DEFAULT 1
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
			// Use raw SQL for INSERT OR REPLACE which is simpler in this case
			this.connection.execute_non_select_command(`
				INSERT OR REPLACE INTO ticker_prices (symbol, price, timestamp, is_realtime)
				VALUES ('${symbol}', ${price}, ${Math.floor(Date.now() / 1000)}, ${Number(isRealtime)})
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
			builder.select_add_field("timestamp", "ticker_prices", "timestamp");
			builder.select_add_field("is_realtime", "ticker_prices", "is_realtime");
			builder.set_where(
				builder.add_cond(
					Gda5.SqlOperatorType.EQ,
					builder.add_field_id("symbol", null),
					// biome-ignore lint/suspicious/noExplicitAny: GDA typing requires any for value expressions
					builder.add_expr_value(null, symbol as unknown as any),
					0,
				),
			);

			const result = this.connection.statement_execute_select(
				builder.get_statement(),
				null,
			);
			const iterator = result.create_iter();

			if (iterator.move_next()) {
				// GDA Value types need explicit conversion (GJS typing limitation)
				const symbolValue = iterator.get_value_for_field(
					"symbol",
				) as unknown as string;
				const priceValue = iterator.get_value_for_field(
					"price",
				) as unknown as number;
				const timestampValue = iterator.get_value_for_field(
					"timestamp",
				) as unknown as number;
				const isRealtimeValue = iterator.get_value_for_field(
					"is_realtime",
				) as unknown as number;

				return {
					symbol: symbolValue,
					price: priceValue,
					timestamp: new Date(timestampValue * 1000),
					isRealtime: Boolean(isRealtimeValue),
				};
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
			// For simplicity, get each symbol individually using the existing method
			for (const symbol of symbols) {
				const data = await this.getLatestPrice(symbol);
				if (data) {
					prices.set(symbol, data);
				}
			}
		} catch (error) {
			console.error("[DB] Failed to get all prices:", error);
		}

		return prices;
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
