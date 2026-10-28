import type { DiscordUser } from "./rest.ts";

export const GATEWAY_INTENTS =
	(1 << 0) | // GUILDS
	(1 << 9) | // GUILD_MESSAGES
	(1 << 15); // MESSAGE_CONTENT

export const DEFAULT_GATEWAY_URL = "wss://gateway.discord.gg/";

export type GatewayState =
	| "stopped"
	| "connecting"
	| "connected"
	| "reconnecting"
	| "error";

export interface GatewayWebSocket {
	readyState: number;
	send(data: string): void;
	close(code?: number, reason?: string): void;
	onopen: (() => void) | null;
	onmessage: ((event: { data: unknown }) => void) | null;
	onerror: ((event: unknown) => void) | null;
	onclose: ((event: { code: number; reason: string }) => void) | null;
}

export type GatewayWebSocketConstructor = new (url: string) => GatewayWebSocket;

export interface DiscordGatewayOptions {
	token: string;
	intents?: number;
	gatewayUrl?: string;
	WebSocketImpl?: GatewayWebSocketConstructor;
	onDispatch?: (event: string, data: unknown, sequence: number | null) => void;
	onState?: (state: GatewayState, detail?: string) => void;
	onReady?: (user: DiscordUser, sessionId: string) => void;
	onError?: (error: Error, fatal: boolean) => void;
	log?: (message: string) => void;
}

interface GatewayPayload {
	op: number;
	d?: unknown;
	s?: number | null;
	t?: string | null;
}

const FATAL_CLOSE_CODES = new Set([
	4004, // authentication failed
	4010, // invalid shard
	4011, // sharding required
	4012, // invalid API version
	4013, // invalid intents
	4014, // disallowed intents
]);

function describeClose(code: number, reason: string): string {
	const trimmed = reason.trim();
	return `Gateway connection closed (code ${code}${trimmed ? `: ${trimmed}` : ""}).`;
}

function parsePayload(data: unknown): GatewayPayload | undefined {
	let text: string | undefined;
	if (typeof data === "string") {
		text = data;
	} else if (data instanceof ArrayBuffer) {
		text = new TextDecoder().decode(data);
	} else if (ArrayBuffer.isView(data)) {
		text = new TextDecoder().decode(data);
	}
	if (!text) return undefined;
	try {
		const parsed: unknown = JSON.parse(text);
		if (parsed && typeof parsed === "object" && "op" in parsed) {
			return parsed as GatewayPayload;
		}
	} catch {
		return undefined;
	}
	return undefined;
}

export class DiscordGateway {
	private readonly token: string;
	private readonly intents: number;
	private readonly gatewayUrl: string;
	private readonly WebSocketImpl: GatewayWebSocketConstructor;
	private readonly onDispatch?: DiscordGatewayOptions["onDispatch"];
	private readonly onState?: DiscordGatewayOptions["onState"];
	private readonly onReady?: DiscordGatewayOptions["onReady"];
	private readonly onError?: DiscordGatewayOptions["onError"];
	private readonly log: (message: string) => void;

	private socket: GatewayWebSocket | undefined;
	private heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private heartbeatAcknowledged = true;
	private sequence: number | null = null;
	private sessionId: string | null = null;
	private resumeUrl: string | null = null;
	private reconnectAttempt = 0;
	private stopped = true;
	private state: GatewayState = "stopped";
	private user: DiscordUser | undefined;

	constructor(options: DiscordGatewayOptions) {
		const WebSocketImpl =
			options.WebSocketImpl ??
			(globalThis as { WebSocket?: GatewayWebSocketConstructor }).WebSocket;
		if (!WebSocketImpl) {
			throw new Error(
				"This Node.js runtime has no WebSocket. Use Node.js 22 or newer.",
			);
		}
		this.token = options.token;
		this.intents = options.intents ?? GATEWAY_INTENTS;
		this.gatewayUrl = options.gatewayUrl ?? DEFAULT_GATEWAY_URL;
		this.WebSocketImpl = WebSocketImpl;
		this.onDispatch = options.onDispatch;
		this.onState = options.onState;
		this.onReady = options.onReady;
		this.onError = options.onError;
		this.log = options.log ?? (() => undefined);
	}

	get currentState(): GatewayState {
		return this.state;
	}

	get botUser(): DiscordUser | undefined {
		return this.user;
	}

	get isConnected(): boolean {
		return this.state === "connected" && this.socket?.readyState === 1;
	}

	get currentSessionId(): string | null {
		return this.sessionId;
	}

	start(): void {
		if (!this.stopped) return;
		this.stopped = false;
		this.sequence = null;
		this.sessionId = null;
		this.resumeUrl = null;
		this.reconnectAttempt = 0;
		this.connect(false);
	}

	stop(): void {
		this.stopped = true;
		this.clearTimers();
		this.detachSocket(1000, "shutdown");
		this.sequence = null;
		this.sessionId = null;
		this.resumeUrl = null;
		this.reconnectAttempt = 0;
		this.heartbeatAcknowledged = true;
		this.setState("stopped");
	}

	restart(): void {
		if (this.stopped) {
			this.start();
			return;
		}
		this.clearTimers();
		this.detachSocket(4000, "manual reconnect");
		this.sequence = null;
		this.sessionId = null;
		this.resumeUrl = null;
		this.reconnectAttempt = 0;
		this.setState("reconnecting", "manual reconnect");
		this.scheduleReconnect(false, 0);
	}

	private setState(state: GatewayState, detail?: string): void {
		this.state = state;
		try {
			this.onState?.(state, detail);
		} catch (error) {
			this.reportError(error, false);
		}
	}

	private reportError(error: unknown, fatal: boolean): void {
		const normalized = error instanceof Error ? error : new Error(String(error));
		this.log(normalized.message);
		try {
			this.onError?.(normalized, fatal);
		} catch (handlerError) {
			this.log(handlerError instanceof Error ? handlerError.message : String(handlerError));
		}
	}

	private buildUrl(base: string): string {
		const url = new URL(base);
		url.searchParams.set("v", "10");
		url.searchParams.set("encoding", "json");
		return url.toString();
	}

	private connect(resume: boolean): void {
		if (this.stopped) return;
		this.clearHeartbeat();
		this.detachSocket(4000, "reconnect");

		const canResume =
			resume && this.sessionId !== null && this.sequence !== null;
		const base = canResume ? (this.resumeUrl ?? this.gatewayUrl) : this.gatewayUrl;
		this.setState(canResume ? "reconnecting" : "connecting");

		let socket: GatewayWebSocket;
		try {
			socket = new this.WebSocketImpl(this.buildUrl(base));
		} catch (error) {
			this.reportError(error, false);
			this.scheduleReconnect(canResume);
			return;
		}

		this.socket = socket;

		socket.onopen = () => {
			if (this.socket !== socket) return;
			this.log("Gateway WebSocket opened. Waiting for Hello.");
		};

		socket.onmessage = (event) => {
			if (this.socket !== socket) return;
			const payload = parsePayload(event.data);
			if (!payload) {
				this.log("Received an unparsable payload from the gateway.");
				return;
			}
			this.handlePayload(payload);
		};

		socket.onerror = () => {
			if (this.socket !== socket) return;
			this.log("Gateway WebSocket error.");
		};

		socket.onclose = (event) => {
			this.handleSocketClose(socket, event?.code ?? 1006, event?.reason ?? "");
		};
	}

	private handleSocketClose(
		socket: GatewayWebSocket,
		code: number,
		reason: string,
	): void {
		if (this.socket !== socket) return;
		this.socket = undefined;
		this.clearHeartbeat();
		if (this.stopped) return;

		const message = describeClose(code, reason);
		if (FATAL_CLOSE_CODES.has(code)) {
			this.stopped = true;
			this.setState("error", message);
			this.reportError(new Error(message), true);
			return;
		}

		this.log(message);
		this.setState("reconnecting", message);
		this.scheduleReconnect(this.sessionId !== null && this.sequence !== null);
	}

	private scheduleReconnect(resume: boolean, delay?: number): void {
		if (this.stopped) return;
		this.clearReconnectTimer();
		const attempt = this.reconnectAttempt;
		this.reconnectAttempt = Math.min(this.reconnectAttempt + 1, 8);
		const wait =
			delay ??
			Math.min(60_000, 1_000 * 2 ** Math.min(attempt, 6)) +
				Math.floor(Math.random() * 500);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined;
			this.connect(resume);
		}, wait);
	}

	private handlePayload(payload: GatewayPayload): void {
		if (typeof payload.s === "number") this.sequence = payload.s;

		switch (payload.op) {
			case 0: {
				this.handleDispatch(payload);
				return;
			}
			case 1: {
				this.sendHeartbeat();
				return;
			}
			case 7: {
				this.log("Discord requested a gateway reconnect.");
				this.clearTimers();
				this.detachSocket(4000, "server requested reconnect");
				this.setState("reconnecting", "reconnect requested by server");
				this.scheduleReconnect(
					this.sessionId !== null && this.sequence !== null,
					0,
				);
				return;
			}
			case 9: {
				const resumable = payload.d === true;
				if (!resumable) {
					this.sessionId = null;
					this.sequence = null;
					this.resumeUrl = null;
				}
				this.log(
					`Gateway session invalidated (${resumable ? "resumable" : "new session required"}).`,
				);
				this.clearTimers();
				this.detachSocket(4000, "invalid session");
				this.setState("reconnecting", "session invalidated");
				this.scheduleReconnect(
					resumable && this.sessionId !== null && this.sequence !== null,
					1_000 + Math.floor(Math.random() * 4_000),
				);
				return;
			}
			case 10: {
				const interval = (payload.d as { heartbeat_interval?: unknown } | undefined)
					?.heartbeat_interval;
				if (typeof interval !== "number" || interval <= 0) {
					this.reportError(
						new Error("Gateway Hello is missing heartbeat_interval."),
						true,
					);
					this.stop();
					return;
				}
				this.heartbeatAcknowledged = true;
				this.beginHeartbeat(interval);
				if (this.sessionId !== null && this.sequence !== null) {
					this.sendPayload({
						op: 6,
						d: {
							token: this.token,
							session_id: this.sessionId,
							seq: this.sequence,
						},
					});
				} else {
					this.sendIdentify();
				}
				return;
			}
			case 11: {
				this.heartbeatAcknowledged = true;
				return;
			}
			default:
				return;
		}
	}

	private handleDispatch(payload: GatewayPayload): void {
		const event = payload.t ?? "";
		const data = payload.d;

		if (event === "READY") {
			const ready = data as {
				session_id?: unknown;
				resume_gateway_url?: unknown;
				user?: DiscordUser;
			};
			if (typeof ready.session_id === "string") this.sessionId = ready.session_id;
			if (typeof ready.resume_gateway_url === "string") {
				this.resumeUrl = ready.resume_gateway_url;
			}
			if (ready.user) this.user = ready.user;
			this.reconnectAttempt = 0;
			this.setState("connected");
			try {
				if (ready.user && typeof ready.session_id === "string") {
					this.onReady?.(ready.user, ready.session_id);
				}
			} catch (error) {
				this.reportError(error, false);
			}
		} else if (event === "RESUMED") {
			this.reconnectAttempt = 0;
			this.setState("connected");
		}

		try {
			this.onDispatch?.(event, data, this.sequence);
		} catch (error) {
			this.reportError(error, false);
		}
	}

	private beginHeartbeat(interval: number): void {
		this.clearHeartbeat();
		this.heartbeatAcknowledged = true;
		const firstDelay = Math.floor(Math.random() * interval * 0.9);

		const beat = () => {
			if (this.stopped || !this.socket) return;
			if (!this.heartbeatAcknowledged) {
				this.log("No gateway heartbeat ACK. Reconnecting.");
				this.detachSocket(4000, "heartbeat timeout");
				this.scheduleReconnect(
					this.sessionId !== null && this.sequence !== null,
					0,
				);
				return;
			}
			this.sendHeartbeat();
			this.heartbeatTimer = setTimeout(beat, interval);
		};

		this.heartbeatTimer = setTimeout(beat, firstDelay);
	}

	private sendHeartbeat(): void {
		this.heartbeatAcknowledged = false;
		this.sendPayload({ op: 1, d: this.sequence });
	}

	private sendIdentify(): void {
		this.sendPayload({
			op: 2,
			d: {
				token: this.token,
				intents: this.intents,
				properties: {
					os: process.platform,
					browser: "pi-coding-agent",
					device: "pi-discord-bridge",
				},
			},
		});
	}

	private sendPayload(payload: GatewayPayload): void {
		if (this.socket?.readyState !== 1) {
			this.log("Gateway is not open; payload not sent.");
			return;
		}
		try {
			this.socket.send(JSON.stringify(payload));
		} catch (error) {
			this.reportError(error, false);
		}
	}

	private detachSocket(code: number, reason: string): void {
		const socket = this.socket;
		this.socket = undefined;
		if (!socket) return;
		socket.onopen = null;
		socket.onmessage = null;
		socket.onerror = null;
		socket.onclose = null;
		try {
			socket.close(code, reason.slice(0, 123));
		} catch {
			// The socket may already be closed.
		}
	}

	private clearHeartbeat(): void {
		if (this.heartbeatTimer) {
			clearTimeout(this.heartbeatTimer);
			this.heartbeatTimer = undefined;
		}
	}

	private clearReconnectTimer(): void {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = undefined;
		}
	}

	private clearTimers(): void {
		this.clearHeartbeat();
		this.clearReconnectTimer();
	}
}
