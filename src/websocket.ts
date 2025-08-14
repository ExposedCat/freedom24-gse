import GLib from "gi://GLib";
import Soup from "gi://Soup";
import { TickerDatabase } from "./database.js";

type PriceUpdateCallback = (ticker: string, price: number) => void;

type AuthResult = {
	SID?: string;
	error?: string;
};

type TradenetMessage = [string, unknown];

type UserDataPayload = {
	mode: string;
};

type QuotePayload = {
	c: string; // ticker symbol
	ltp?: number; // last traded price
	bbp?: number; // best bid price
	contract_multiplier?: number; // for options
};

export class TradenetWebSocket {
	private static instance: TradenetWebSocket | null = null;
	private session: Soup.Session | null = null;
	private connection: Soup.WebsocketConnection | null = null;
	private adminSID: string | null = null;
	private desiredSubscriptions = new Set<string>();
	private isIntentionallyDisconnected = false;
	private reconnectTimeoutId: number | null = null;
	private reconnectAttempts = 0;
	private maxReconnectAttempts = 5;
	private baseReconnectDelay = 1000;
	private priceUpdateCallbacks: PriceUpdateCallback[] = [];
	private isAuthenticated = false;

	private constructor() {
		this.session = new Soup.Session();
	}

	private async authenticateWithTradernet(
		login: string,
		password: string,
	): Promise<AuthResult> {
		return new Promise((resolve) => {
			try {
				// Create form data string
				const formData = `login=${encodeURIComponent(login)}&password=${encodeURIComponent(password)}`;

				const message = new Soup.Message({
					method: "POST",
					uri: GLib.Uri.parse(
						"https://tradernet.com/api/check-login-password",
						GLib.UriFlags.NONE,
					),
				});

				// Set content type and body
				message.request_headers.append(
					"Content-Type",
					"application/x-www-form-urlencoded",
				);
				message.set_request_body_from_bytes(
					"application/x-www-form-urlencoded",
					GLib.Bytes.new(new TextEncoder().encode(formData)),
				);

				// Send the request asynchronously to avoid blocking the shell
				if (!this.session) {
					resolve({ error: "Session not initialized" });
					return;
				}
				this.session.send_and_read_async(
					message,
					GLib.PRIORITY_DEFAULT,
					null, // cancellable
					// biome-ignore lint/suspicious/noExplicitAny: GJS async callback conflicts between @girs packages
					(source: any, result: any) => {
						try {
							if (!source) {
								resolve({ error: "Network error during authentication" });
								return;
							}
							const response = (source as Soup.Session).send_and_read_finish(
								result,
							);
							if (!response) {
								resolve({ error: "Network error during authentication" });
								return;
							}

							const responseData = new TextDecoder().decode(
								response.get_data(),
							);
							const parsedResult = JSON.parse(responseData);

							if (parsedResult.SID) {
								resolve({ SID: parsedResult.SID });
							} else {
								resolve({
									error: parsedResult.error || "Authentication failed",
								});
							}
						} catch (error) {
							console.error("[WS] Auth response error:", error);
							resolve({ error: "Error processing authentication response" });
						}
					},
				);
			} catch (error) {
				console.error("[WS] Auth setup error:", error);
				resolve({ error: "Network error during authentication" });
			}
		});
	}

	static getInstance(): TradenetWebSocket {
		if (!TradenetWebSocket.instance) {
			TradenetWebSocket.instance = new TradenetWebSocket();
		}
		return TradenetWebSocket.instance;
	}

	static addPriceUpdateCallback(callback: PriceUpdateCallback): void {
		const instance = TradenetWebSocket.getInstance();
		instance.priceUpdateCallbacks.push(callback);
	}

	static async authenticateAndConnect(
		login: string,
		password: string,
	): Promise<boolean> {
		const instance = TradenetWebSocket.getInstance();
		const authResult = await instance.authenticateWithTradernet(
			login,
			password,
		);

		if (authResult.error || !authResult.SID) {
			console.error("[WS] Authentication failed:", authResult.error);
			return false;
		}

		return instance.connectInstance(authResult.SID);
	}

	static async connect(sid: string): Promise<boolean> {
		const instance = TradenetWebSocket.getInstance();
		return instance.connectInstance(sid);
	}

	static async disconnect(): Promise<void> {
		const instance = TradenetWebSocket.getInstance();
		await instance.disconnectInstance();
	}

	static subscribeToTickers(tickers: string[]): void {
		const instance = TradenetWebSocket.getInstance();
		// Always update desired subscriptions, even if not connected yet
		instance.desiredSubscriptions = new Set(tickers);

		if (instance.isAuthenticated) {
			instance.sendQuotes(instance.desiredSubscriptions);
		}
	}

	static async getHistoricalPrices(
		tickers: string[],
	): Promise<Map<string, { price: number; isRealtime: boolean }>> {
		const historicalData = await TickerDatabase.getAllPrices(tickers);
		const result = new Map<string, { price: number; isRealtime: boolean }>();

		for (const [symbol, data] of historicalData) {
			result.set(symbol, {
				price: data.price,
				isRealtime: data.isRealtime,
			});
		}

		return result;
	}

	static isConnected(): boolean {
		const instance = TradenetWebSocket.getInstance();
		return instance.isConnectedInstance();
	}

	private async connectInstance(sid: string): Promise<boolean> {
		return new Promise((resolve) => {
			this.adminSID = sid;
			this.isIntentionallyDisconnected = false;
			const wsUrl = `wss://wss.tradernet.com/?SID=${sid}`;

			const message = new Soup.Message({
				method: "GET",
				uri: GLib.Uri.parse(wsUrl, GLib.UriFlags.NONE),
			});

			const timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10000, () => {
				if (this.connection) {
					this.connection.close(Soup.WebsocketCloseCode.NORMAL, null);
				}
				resolve(false);
				return GLib.SOURCE_REMOVE;
			});

			if (!this.session) {
				resolve(false);
				return;
			}
			this.session.websocket_connect_async(
				message,
				null, // origin
				[], // protocols
				GLib.PRIORITY_DEFAULT, // priority
				null, // cancellable
				(source, result) => {
					try {
						if (!source) {
							GLib.source_remove(timeoutId);
							resolve(false);
							return;
						}
						this.connection = source.websocket_connect_finish(result);
						this.setupHandlers();
						GLib.source_remove(timeoutId);
						resolve(true);
					} catch (error) {
						console.error("[WS] Connection failed:", error);
						GLib.source_remove(timeoutId);
						resolve(false);
					}
				},
			);
		});
	}

	private setupHandlers(): void {
		if (!this.connection) return;

		this.connection.connect(
			"message",
			(
				_conn: Soup.WebsocketConnection,
				type: Soup.WebsocketDataType,
				data: GLib.Bytes,
			) => {
				if (type === Soup.WebsocketDataType.TEXT) {
					const bytes = data.get_data();
					if (bytes) {
						const rawMessage = new TextDecoder().decode(bytes);
						this.handleMessage(rawMessage);
					}
				}
			},
		);

		this.connection.connect("closed", () => {
			this.isAuthenticated = false;

			if (!this.isIntentionallyDisconnected && this.adminSID) {
				this.scheduleReconnection();
			}
		});

		this.connection.connect(
			"error",
			(_conn: Soup.WebsocketConnection, error: GLib.Error) => {
				console.error("[WS] Error:", error.message);
				this.isAuthenticated = false;
			},
		);
	}

	private handleMessage(rawMessage: string): void {
		try {
			const message: TradenetMessage = JSON.parse(rawMessage);

			if (Array.isArray(message) && message.length >= 2) {
				const [type, payload] = message;

				if (type === "userData") {
					const userPayload = payload as UserDataPayload;
					if (userPayload.mode === "prod") {
						this.reconnectAttempts = 0;
						this.isAuthenticated = true;
						// Send initial subscription for all desired tickers
						this.sendQuotes(this.desiredSubscriptions);
					}
				} else if (type === "q") {
					const quotePayload = payload as QuotePayload;
					if (quotePayload.c && quotePayload.ltp !== undefined) {
						const ticker = quotePayload.c;
						const isOption = ticker.startsWith("+");
						const multiplier = isOption
							? quotePayload.contract_multiplier || 100
							: 1;
						const bestBidOrLast =
							typeof quotePayload.bbp === "number" && quotePayload.bbp > 0
								? quotePayload.bbp
								: quotePayload.ltp;
						const price = bestBidOrLast * multiplier;

						if (price > 0) {
							// Save to database as real-time data
							TickerDatabase.savePrice(ticker, price, true);
							this.notifyPriceUpdate(ticker, price);
						}
					}
				}
			}
		} catch (error) {
			console.error("[WS] Error processing message:", error);
		}
	}

	private sendQuotes(subscriptions: Iterable<string>): void {
		if (!this.isConnectedInstance()) {
			return;
		}
		const list = Array.from(subscriptions);
		if (list.length === 0) {
			return;
		}
		if (this.connection) {
			this.connection.send_text(JSON.stringify(["quotes", list]));
		}
	}

	private setDesiredSubscriptionsAndSend(newSubscriptions: Set<string>): void {
		this.desiredSubscriptions = newSubscriptions;
		this.sendQuotes(this.desiredSubscriptions);
	}

	private scheduleReconnection(): void {
		if (this.reconnectAttempts >= this.maxReconnectAttempts) {
			return;
		}

		if (this.reconnectTimeoutId) {
			GLib.source_remove(this.reconnectTimeoutId);
		}

		const delay = this.baseReconnectDelay * 2 ** this.reconnectAttempts;
		this.reconnectAttempts++;

		this.reconnectTimeoutId = GLib.timeout_add(
			GLib.PRIORITY_DEFAULT,
			delay,
			() => {
				if (this.adminSID && !this.isIntentionallyDisconnected) {
					this.connectInstance(this.adminSID).then((success) => {
						if (!success) {
							this.scheduleReconnection();
						}
					});
				}
				return GLib.SOURCE_REMOVE;
			},
		);
	}

	private async disconnectInstance(): Promise<void> {
		this.isIntentionallyDisconnected = true;
		this.isAuthenticated = false;

		if (this.reconnectTimeoutId) {
			GLib.source_remove(this.reconnectTimeoutId);
			this.reconnectTimeoutId = null;
		}

		if (this.connection) {
			this.connection.close(Soup.WebsocketCloseCode.NORMAL, null);
			this.connection = null;
		}

		this.adminSID = null;
		this.desiredSubscriptions.clear();
		this.reconnectAttempts = 0;
	}

	private isConnectedInstance(): boolean {
		return (
			this.connection !== null &&
			this.connection.get_state() === Soup.WebsocketState.OPEN &&
			this.isAuthenticated
		);
	}

	private notifyPriceUpdate(ticker: string, price: number): void {
		for (const callback of this.priceUpdateCallbacks) {
			try {
				callback(ticker, price);
			} catch (error) {
				console.error(`[WS] Error in price callback for ${ticker}:`, error);
			}
		}
	}
}
