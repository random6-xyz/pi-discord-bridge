import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	formatCommandHelp,
	isBridgeCommand,
	isSupportedBuiltin,
	isUnsupportedBuiltin,
	parseSlashCommand,
	subcommandOf,
	THINKING_LEVELS,
	unknownCommandText,
	unsupportedCommandText,
	type ParsedSlashCommand,
	type SlashCommandKind,
} from "./commands.ts";
import { loadConfig, persistEnabled, type BridgeConfig } from "./config.ts";
import { DiscordGateway, type GatewayState } from "./gateway.ts";
import {
	acquireBridgeLock,
	BridgeLockedError,
	type BridgeLock,
} from "./lock.ts";
import {
	DiscordApiError,
	DiscordRest,
	type DiscordChannel,
	type DiscordMessage,
	type DiscordUser,
} from "./rest.ts";
import { summarizeText } from "./text.ts";

const THREAD_BINDING_ENTRY = "discord-bridge-thread";
const THREAD_NAME_LIMIT = 100;
const THREAD_ACTIVE_CACHE_MS = 60_000;
const THREAD_CHANNEL_TYPES = new Set([10, 11, 12]);
/** Fallback re-check while a send is in flight or Pi is busy without streaming. */
const FORWARD_RETRY_MS = 1_000;

export interface SendResult {
	channelId: string;
	messageIds: string[];
	count: number;
}

export interface AskAnswer {
	text: string;
	messageId: string;
	authorId: string;
	receivedAt: number;
	questionMessageIds: string[];
}

export interface AskOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
	/** Overrides config.mentionOnAsk for this question. */
	mentionUser?: boolean;
}

interface PendingAsk {
	id: string;
	question: string;
	createdAt: number;
	messageIds: string[];
	resolve: (answer: AskAnswer) => void;
	reject: (error: Error) => void;
	timer?: ReturnType<typeof setTimeout>;
	cleanup?: () => void;
}

type CommandLevel = "info" | "warning" | "error";

interface CommandReply {
	text: string;
	level: CommandLevel;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function formatApiError(error: unknown): string {
	if (error instanceof DiscordApiError) {
		if (error.status === 401) {
			return "Discord bot token is invalid. Check DISCORD_BOT_TOKEN.";
		}
		if (error.status === 403) {
			return (
				"Missing permission to access the Discord channel/thread. " +
				"View Channel, Send Messages, Create Public Threads, " +
				"Send Messages in Threads."
			);
		}
		if (error.status === 404) {
			return "Discord channel/thread not found. Check the channel ID and whether the bot has joined the server.";
		}
	}
	return errorMessage(error);
}

function botLabel(user: DiscordUser | undefined): string {
	if (!user) return "unknown";
	const discriminator = user.discriminator && user.discriminator !== "0"
		? `#${user.discriminator}`
		: "";
	return `${user.global_name || user.username}${discriminator}`;
}

export class DiscordBridge {
	private readonly pi: ExtensionAPI;
	private config: BridgeConfig;
	private ctx: ExtensionContext | undefined;
	private rest: DiscordRest | undefined;
	private gateway: DiscordGateway | undefined;
	private lock: BridgeLock | undefined;
	private botUser: DiscordUser | undefined;
	private parentChannel: DiscordChannel | undefined;
	private thread: DiscordChannel | undefined;
	private targetChannelId: string | undefined;
	private sessionId: string | undefined;
	private threadCheckedAt = 0;

	private active = false;
	private starting = false;
	private generation = 0;
	private state: GatewayState = "stopped";
	private lastError: string | undefined;
	private hasEverConnected = false;
	private firstErrorNotified = false;
	private warnedUsers = new Set<string>();
	private pendingAsk: PendingAsk | undefined;
	private inboundChain: Promise<void> = Promise.resolve();
	private forwardQueue: Array<{ text: string; messageId: string }> = [];
	private forwardInFlight = false;
	private forwardTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
		this.config = loadConfig();
	}

	private get isChildProcess(): boolean {
		return process.env.PI_SUBAGENT_CHILD === "1";
	}

	private debug(message: string): void {
		if (process.env.PI_DISCORD_BRIDGE_DEBUG === "1") {
			console.error(`[pi-discord-bridge] ${message}`);
		}
	}

	private notify(
		message: string,
		level: "info" | "warning" | "error" = "info",
	): void {
		try {
			if (this.ctx?.hasUI) this.ctx.ui.notify(message, level);
		} catch {
			// UI may be shutting down.
		}
	}

	/** Remove a status line left behind by an older version of this extension. */
	private clearLegacyStatus(ctx = this.ctx): void {
		try {
			if (ctx?.hasUI) ctx.ui.setStatus("pi-discord-bridge", undefined);
		} catch {
			// UI may be shutting down.
		}
	}

	start(ctx: ExtensionContext | undefined, configOverride?: BridgeConfig): void {
		if (ctx) this.ctx = ctx;
		const targetCtx = this.ctx;
		if (!targetCtx) {
			this.debug("Cannot start the bridge without a Pi session context.");
			return;
		}
		this.clearLegacyStatus(targetCtx);

		if (this.isChildProcess) {
			this.active = false;
			this.debug("Not starting the bridge in a subagent process.");
			return;
		}
		const headlessAllowed = process.env.PI_DISCORD_BRIDGE_ALLOW_HEADLESS === "1";
		if (
			!headlessAllowed &&
			targetCtx.mode !== "tui" &&
			targetCtx.mode !== "rpc"
		) {
			this.active = false;
			this.debug(`Not starting the bridge in one-shot mode (${targetCtx.mode}).`);
			return;
		}
		if (this.active || this.starting) return;

		this.config = configOverride ?? loadConfig();
		this.forwardQueue = [];
		this.forwardInFlight = false;
		this.clearForwardTimer();
		this.thread = undefined;
		this.targetChannelId = undefined;
		this.threadCheckedAt = 0;
		if (!this.config.enabled) {
			this.active = false;
			this.state = "stopped";
			return;
		}
		if (this.config.errors.length > 0) {
			this.active = false;
			this.state = "error";
			this.lastError = this.config.errors.join("\n");
			this.notify(
				`Discord bridge configuration error:\n${this.config.errors.join("\n")}`,
				"error",
			);
			return;
		}

		this.active = true;
		this.starting = true;
		this.hasEverConnected = false;
		this.firstErrorNotified = false;
		this.lastError = undefined;
		const generation = ++this.generation;
		this.state = "connecting";

		void this.connect(generation)
			.catch((error) => this.failStart(generation, error))
			.finally(() => {
				if (generation === this.generation) this.starting = false;
			});
	}

	private async connect(generation: number): Promise<void> {
		const config = this.config;
		const ctx = this.ctx;
		if (!ctx) {
			throw new Error("Cannot start the Discord bridge without a Pi session context.");
		}
		const sessionId = ctx.sessionManager.getSessionId();
		this.sessionId = sessionId;

		const lockKey =
			config.mode === "thread"
				? `thread:${config.channelId}:${sessionId}`
				: `channel:${config.channelId}`;
		let lock: BridgeLock | undefined;
		try {
			lock = acquireBridgeLock(lockKey, config.token);
		} catch (error) {
			if (error instanceof BridgeLockedError) {
				throw new Error(error.message);
			}
			throw error;
		}

		if (generation !== this.generation || !this.active) {
			lock.release();
			return;
		}
		this.lock = lock;

		const rest = new DiscordRest({ token: config.token });
		this.rest = rest;

		const [botUser, parentChannel] = await Promise.all([
			rest.getMe(),
			rest.getChannel(config.channelId),
		]);
		if (generation !== this.generation || !this.active) return;

		if (!botUser.bot) {
			throw new Error(
				"DISCORD_BOT_TOKEN is not a bot token. Use a Bot token from the Discord Developer Portal.",
			);
		}
		this.botUser = botUser;
		this.parentChannel = parentChannel;

		if (config.mode === "thread") {
			if (parentChannel.type !== 0) {
				throw new Error(
					"channelId must be a regular text channel in thread mode. " +
						"Each Pi session is created as a thread under that channel.",
				);
			}
			const thread = await this.resolveThread(
				rest,
				ctx,
				parentChannel,
				config,
				sessionId,
			);
			if (generation !== this.generation || !this.active) return;
			this.thread = thread;
			this.targetChannelId = thread.id;
			this.threadCheckedAt = Date.now();
			this.debug(`Session thread: ${thread.name ?? thread.id} (${thread.id})`);
		} else {
			this.thread = undefined;
			this.targetChannelId = parentChannel.id;
		}

		const gateway = new DiscordGateway({
			token: config.token,
			gatewayUrl: process.env.PI_DISCORD_GATEWAY_URL,
			onDispatch: (event, data) => {
				if (event === "MESSAGE_CREATE") {
					this.enqueueMessage(data as DiscordMessage, generation);
				}
			},
			onState: (state, detail) => this.handleGatewayState(state, detail, generation),
			onReady: (user) => {
				if (generation !== this.generation) return;
				this.botUser = user;
				this.hasEverConnected = true;
				this.firstErrorNotified = false;
				this.lastError = undefined;
				this.state = "connected";
			},
			onError: (error, fatal) =>
				this.handleGatewayError(error, fatal, generation),
			log: (message) => this.debug(message),
		});
		this.gateway = gateway;
		gateway.start();
		this.debug(
			`Gateway connection started (${this.targetChannelId} / ${
				this.parentChannel?.name ?? this.parentChannel?.id ?? "unknown"
			}).`,
		);
	}

	private shortSessionId(sessionId: string): string {
		return sessionId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "session";
	}

	private buildThreadName(ctx: ExtensionContext, config: BridgeConfig): string {
		const raw =
			config.threadName ||
			ctx.sessionManager.getSessionName() ||
			basename(ctx.cwd) ||
			"pi";
		const base =
			raw.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim() || "pi";
		const suffix = ` [${this.shortSessionId(ctx.sessionManager.getSessionId())}]`;
		const maxBase = Math.max(1, THREAD_NAME_LIMIT - suffix.length);
		const trimmedBase = Array.from(base)
			.slice(0, maxBase)
			.join("")
			.trim();
		return `${trimmedBase || "pi"}${suffix}`;
	}

	private readStoredThread(
		ctx: ExtensionContext,
		config: BridgeConfig,
		sessionId: string,
	): { threadId: string; threadName?: string } | undefined {
		let stored: { threadId: string; threadName?: string } | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== THREAD_BINDING_ENTRY) {
				continue;
			}
			const data = entry.data as Record<string, unknown> | undefined;
			if (
				!data ||
				data.parentChannelId !== config.channelId ||
				data.sessionId !== sessionId ||
				typeof data.threadId !== "string"
			) {
				continue;
			}
			stored = {
				threadId: data.threadId,
				threadName:
					typeof data.threadName === "string" ? data.threadName : undefined,
			};
		}
		return stored;
	}

	private storeThread(
		ctx: ExtensionContext,
		config: BridgeConfig,
		sessionId: string,
		thread: DiscordChannel,
	): void {
		try {
			this.pi.appendEntry(THREAD_BINDING_ENTRY, {
				parentChannelId: config.channelId,
				sessionId,
				threadId: thread.id,
				threadName: thread.name,
				boundAt: Date.now(),
			});
		} catch (error) {
			this.debug(`Failed to store the thread binding: ${errorMessage(error)}`);
		}
	}

	private async findThreadByName(
		rest: DiscordRest,
		parent: DiscordChannel,
		name: string,
	): Promise<DiscordChannel | undefined> {
		const find = (threads: DiscordChannel[]) =>
			threads.find(
				(thread) => thread.parent_id === parent.id && thread.name === name,
			);

		if (parent.guild_id) {
			try {
				const active = find(await rest.listActiveThreads(parent.guild_id));
				if (active) return active;
			} catch (error) {
				this.debug(`Failed to list active threads: ${errorMessage(error)}`);
			}
		}

		try {
			const archived = find(await rest.listArchivedPublicThreads(parent.id));
			if (archived) {
				try {
					return await rest.unarchiveThread(archived.id);
				} catch (error) {
					this.debug(`Failed to unarchive the thread: ${errorMessage(error)}`);
				}
			}
		} catch (error) {
			this.debug(`Failed to list archived threads: ${errorMessage(error)}`);
		}

		return undefined;
	}

	private async resolveThread(
		rest: DiscordRest,
		ctx: ExtensionContext,
		parent: DiscordChannel,
		config: BridgeConfig,
		sessionId: string,
	): Promise<DiscordChannel> {
		const stored = this.readStoredThread(ctx, config, sessionId);
		if (stored) {
			try {
				const existing = await rest.getChannel(stored.threadId);
				if (
					existing.parent_id === parent.id &&
					THREAD_CHANNEL_TYPES.has(existing.type)
				) {
					try {
						const active = await rest.ensureThreadActive(existing.id);
						this.debug(
							`Using the stored session thread: ${active.name ?? active.id}`,
						);
						return active;
					} catch (error) {
						if (
							error instanceof DiscordApiError &&
							(error.status === 403 || error.status === 404)
						) {
							this.debug(
								`Cannot open the stored thread; creating a new one: ${error.message}`,
							);
						} else {
							throw error;
						}
					}
				}
			} catch (error) {
				if (!(error instanceof DiscordApiError && error.status === 404)) throw error;
				this.debug("The stored session thread was deleted.");
			}
		}

		const name = this.buildThreadName(ctx, config);
		const found = await this.findThreadByName(rest, parent, name);
		if (found) {
			this.storeThread(ctx, config, sessionId, found);
			this.debug(`Found the session thread by name: ${found.name ?? found.id}`);
			return found;
		}

		const created = await rest.createPublicThread(
			parent.id,
			name,
			config.threadAutoArchiveMinutes,
		);
		this.storeThread(ctx, config, sessionId, created);
		this.debug(`Created a new session thread: ${created.name ?? created.id}`);
		return created;
	}

	private failStart(generation: number, error: unknown): void {
		if (generation !== this.generation) return;
		this.active = false;
		this.starting = false;
		this.state = "error";
		this.rest = undefined;
		this.gateway = undefined;
		this.lock?.release();
		this.lock = undefined;
		this.lastError = formatApiError(error);
		this.parentChannel = undefined;
		this.thread = undefined;
		this.targetChannelId = undefined;
		this.sessionId = undefined;
		this.threadCheckedAt = 0;
		this.notify(`Failed to start the Discord bridge:\n${this.lastError}`, "error");
		this.debug(`Start failed: ${this.lastError}`);
	}

	stop(): void {
		this.generation += 1;
		this.active = false;
		this.starting = false;
		this.state = "stopped";
		this.forwardQueue = [];
		this.forwardInFlight = false;
		this.clearForwardTimer();

		const pending = this.pendingAsk;
		if (pending) {
			this.settlePending(
				pending,
				new Error("The Discord bridge stopped, so waiting for a reply was cancelled."),
			);
		}

		this.gateway?.stop();
		this.gateway = undefined;
		this.rest = undefined;
		this.botUser = undefined;
		this.parentChannel = undefined;
		this.thread = undefined;
		this.targetChannelId = undefined;
		this.sessionId = undefined;
		this.threadCheckedAt = 0;
		this.lock?.release();
		this.lock = undefined;
		this.clearLegacyStatus();
		this.debug("Bridge stopped.");
	}

	async setEnabled(enabled: boolean, ctx?: ExtensionContext): Promise<void> {
		if (ctx) this.ctx = ctx;
		const targetCtx = this.ctx;
		if (!targetCtx) {
			this.notify("Cannot toggle the Discord bridge without a Pi session context.", "error");
			return;
		}
		const previous = this.config;
		const persisted = persistEnabled(previous, enabled);
		if (!persisted.ok) {
			this.notify(
				`Failed to save the Discord bridge configuration: ${persisted.error}`,
				"warning",
			);
		}

		this.stop();
		if (enabled) {
			// Re-read the file so a changed token/channel is validated and a failed
			// persistence still starts with the in-memory enabled flag.
			this.config = { ...loadConfig(), enabled: true };
			this.start(targetCtx, this.config);
			this.notify("Discord bridge enabled.", "info");
		} else {
			this.config = { ...previous, enabled: false };
			this.notify("Discord bridge disabled.", "info");
		}
	}

	async reconnect(ctx?: ExtensionContext): Promise<void> {
		if (ctx) this.ctx = ctx;
		if (!this.config.enabled) {
			await this.setEnabled(true, ctx);
			return;
		}
		const targetCtx = this.ctx;
		if (!targetCtx) {
			this.notify("Cannot reconnect the Discord bridge without a Pi session context.", "error");
			return;
		}
		if (!this.active || !this.gateway || this.config.mode === "thread") {
			this.stop();
			this.config = loadConfig();
			this.config.enabled = true;
			this.start(targetCtx, this.config);
			this.notify(
				this.config.mode === "thread"
					? "Discord bridge reconnecting and re-checking the thread."
					: "Discord bridge reconnecting.",
				"info",
			);
			return;
		}
		this.lastError = undefined;
		this.gateway.restart();
		this.notify("Discord bridge reconnecting.", "info");
	}

	private describeDelivery(): string {
		if (!this.config.queueWhenBusy) return "reject";
		return this.config.delivery === "steer"
			? "steer queue (injected after the current turn)"
			: "followUp queue (after the run ends)";
	}

	statusText(): string {
		const lines: string[] = [];
		const enabled = this.config.enabled;
		const state =
			this.active || this.starting
				? this.state === "connected"
					? "connected"
					: this.state === "connecting"
						? "connecting"
						: this.state === "reconnecting"
							? "reconnecting"
							: this.state === "error"
								? "error"
								: "idle"
				: enabled
					? "stopped"
					: "disabled";

		lines.push(`Discord bridge: ${state}`);
		lines.push(`Enabled: ${enabled ? "yes" : "no"}`);
		lines.push(
			`Mode: ${this.config.mode === "thread" ? "thread" : "channel"}`,
		);
		lines.push(
			`Parent channel: ${this.config.channelId || "not set"}${
				this.parentChannel?.name ? ` (#${this.parentChannel.name})` : ""
			}`,
		);
		if (this.config.mode === "thread") {
			lines.push(
				`Session thread: ${
					this.thread
						? `${this.thread.name ?? this.thread.id} (${this.thread.id})`
						: "not connected"
				}`,
			);
			if (this.thread && this.parentChannel?.guild_id) {
				lines.push(
					`Thread link: https://discord.com/channels/${this.parentChannel.guild_id}/${this.thread.id}`,
				);
			}
		}
		if (this.sessionId) {
			lines.push(`Session ID: ${this.shortSessionId(this.sessionId)}`);
		}
		lines.push(
			`Bot: ${this.botUser ? `${botLabel(this.botUser)} (${this.botUser.id})` : "not connected"}`,
		);
		lines.push(`Allowed users: ${this.config.allowedUserIds.length}`);
		lines.push(`Token: ${this.config.token ? "set" : "not set"}`);
		lines.push(`Busy input: ${this.describeDelivery()}`);
		lines.push(
			`Pending question: ${
				this.pendingAsk
					? `${Math.round((Date.now() - this.pendingAsk.createdAt) / 1_000)}s ago`
					: "none"
			}`,
		);
		lines.push(`Config file: ${this.config.configPath}`);
		if (this.pendingAsk) {
			lines.push(`Question: ${summarizeText(this.pendingAsk.question)}`);
		}
		if (this.lastError) lines.push(`Last error: ${this.lastError}`);
		if (this.config.errors.length > 0) {
			lines.push(`Config errors: ${this.config.errors.join(" / ")}`);
		}
		if (this.config.warnings.length > 0) {
			lines.push(`Warnings: ${this.config.warnings.join(" / ")}`);
		}
		if (this.isChildProcess) {
			lines.push("Disabled in subagent processes.");
		}
		return lines.join("\n");
	}

	async send(
		content: string,
		options: { mentionUserIds?: string[] } = {},
	): Promise<SendResult> {
		const config = this.requireConfigForSend();
		const rest = this.rest;
		if (!rest) {
			throw new Error(
				"The Discord bridge is not connected yet. Run /discord-bridge status to check.",
			);
		}
		const text = content.trim();
		if (!text) throw new Error("Cannot send an empty message to Discord.");

		const allowed = new Set(config.allowedUserIds);
		const mentionUserIds = (options.mentionUserIds ?? []).filter((id) =>
			allowed.has(id),
		);

		const sendOnce = async (): Promise<{ messages: DiscordMessage[] }> => {
			const target = this.targetChannelId;
			if (!target) throw new Error("No Discord target thread/channel.");
			return rest.sendMessage(target, text, { mentionUserIds });
		};

		let result: { messages: DiscordMessage[] };
		try {
			await this.ensureTargetActive();
			result = await sendOnce();
		} catch (error) {
			if (
				config.mode === "thread" &&
				error instanceof DiscordApiError &&
				(error.status === 400 || error.status === 403 || error.status === 404)
			) {
				this.debug(
					`Thread send failed (${error.status}); re-checking thread state.`,
				);
				this.threadCheckedAt = 0;
				try {
					await this.ensureTargetActive();
					result = await sendOnce();
				} catch (retryError) {
					throw new Error(formatApiError(retryError));
				}
			} else {
				throw new Error(formatApiError(error));
			}
		}
		return {
			channelId: this.targetChannelId ?? config.channelId,
			messageIds: result.messages.map((message) => message.id),
			count: result.messages.length,
		};
	}

	private async ensureTargetActive(): Promise<void> {
		if (this.config.mode !== "thread" || !this.thread || !this.rest) return;
		if (Date.now() - this.threadCheckedAt < THREAD_ACTIVE_CACHE_MS) return;

		const ctx = this.ctx;
		const parent = this.parentChannel;
		const sessionId = this.sessionId;
		if (!ctx || !parent || !sessionId) return;

		try {
			const active = await this.rest.ensureThreadActive(this.thread.id);
			this.thread = active;
			this.targetChannelId = active.id;
			this.threadCheckedAt = Date.now();
		} catch (error) {
			if (
				error instanceof DiscordApiError &&
				(error.status === 403 || error.status === 404)
			) {
				this.debug(
					`Cannot verify the session thread; creating a new one: ${error.message}`,
				);
				const thread = await this.resolveThread(
					this.rest,
					ctx,
					parent,
					this.config,
					sessionId,
				);
				this.thread = thread;
				this.targetChannelId = thread.id;
				this.threadCheckedAt = Date.now();
				return;
			}
			throw error;
		}
	}

	async deleteCurrentThread(ctx?: ExtensionContext): Promise<void> {
		if (ctx) this.ctx = ctx;
		const targetCtx = this.ctx;
		if (!targetCtx) {
			this.notify("Cannot delete the thread without a Pi session context.", "error");
			return;
		}

		const config = this.config.enabled ? this.config : loadConfig();
		if (config.mode !== "thread") {
			this.notify(
				"Session threads can only be deleted in thread mode. " +
					"Manage the channel directly in channel mode.",
				"warning",
			);
			return;
		}

		const sessionId = targetCtx.sessionManager.getSessionId();
		const stored = this.readStoredThread(targetCtx, config, sessionId);
		let threadId: string | undefined = this.thread?.id ?? stored?.threadId;
		let threadName: string =
			this.thread?.name ?? stored?.threadName ?? threadId ?? "unknown";

		if (!config.token) {
			this.notify("Cannot delete the thread without DISCORD_BOT_TOKEN.", "error");
			return;
		}
		const rest = this.rest ?? new DiscordRest({ token: config.token });

		if (!threadId) {
			try {
				const parent =
					this.parentChannel ?? (await rest.getChannel(config.channelId));
				const found = await this.findThreadByName(
					rest,
					parent,
					this.buildThreadName(targetCtx, config),
				);
				if (found) {
					threadId = found.id;
					threadName = found.name ?? this.buildThreadName(targetCtx, config);
				}
			} catch (error) {
				this.debug(`Failed to look up the thread: ${errorMessage(error)}`);
			}
		}

		if (!threadId) {
			this.notify(
				"No Discord thread is linked to the current session. Run /discord-bridge on and try again.",
				"warning",
			);
			return;
		}

		if (targetCtx.hasUI) {
			const confirmed = await targetCtx.ui.confirm(
				"Delete Discord thread",
				`Delete the current session thread and all messages, then disconnect Discord?\n\n${threadName}`,
			);
			if (!confirmed) {
				this.notify("Cancelled Discord thread deletion.", "info");
				return;
			}
		}

		try {
			await rest.deleteChannel(threadId);
		} catch (error) {
			if (error instanceof DiscordApiError && error.status === 404) {
				this.debug("The thread is already deleted.");
			} else if (error instanceof DiscordApiError && error.status === 403) {
				this.notify(
					"Missing permission to delete the thread. Grant Manage Threads to the bot.",
					"error",
				);
				return;
			} else {
				this.notify(
					`Failed to delete the Discord thread: ${formatApiError(error)}`,
					"error",
				);
				return;
			}
		}

		const persisted = persistEnabled(this.config, false);
		if (!persisted.ok) {
			this.notify(
				`Failed to save the Discord bridge configuration: ${persisted.error}`,
				"warning",
			);
		}
		const previous = this.config;
		this.stop();
		this.config = { ...previous, enabled: false };
		this.notify(
			`Deleted the Discord thread and disconnected: ${threadName}`,
			"info",
		);
	}

	private requireConfigForSend(): BridgeConfig {
		if (this.isChildProcess) {
			throw new Error("The Discord bridge is unavailable in subagent processes.");
		}
		if (!this.config.enabled) {
			throw new Error("The Discord bridge is disabled. Run /discord-bridge on.");
		}
		if (this.config.errors.length > 0) {
			throw new Error(`Discord bridge configuration error: ${this.config.errors.join(" / ")}`);
		}
		return this.config;
	}

	async ask(question: string, options: AskOptions = {}): Promise<AskAnswer> {
		const config = this.requireConfigForSend();
		const text = question.trim();
		if (!text) throw new Error("Cannot ask an empty question on Discord.");
		if (this.pendingAsk) {
			throw new Error(
				"Another question is already waiting for a Discord reply. Only one at a time is supported.",
			);
		}
		if (!this.rest) {
			throw new Error("The Discord bridge is not connected yet.");
		}
		if (!this.gateway?.isConnected) {
			throw new Error(
				"The Discord gateway is not connected, so replies cannot be received. Try again shortly.",
			);
		}

		const timeoutMs = Math.min(
			24 * 60 * 60 * 1_000,
			Math.max(1_000, options.timeoutMs ?? config.askTimeoutMs),
		);
		const pending = {
			id: randomUUID(),
			question: text,
			createdAt: Date.now(),
			messageIds: [] as string[],
		} as PendingAsk;

		if (options.signal?.aborted) {
			throw new Error("Waiting for a Discord reply was cancelled.");
		}

		const answerPromise = new Promise<AskAnswer>((resolve, reject) => {
			pending.resolve = resolve;
			pending.reject = reject;
		});
		// Keep an early rejection from looking unhandled while the question is being posted.
		void answerPromise.catch(() => undefined);

		this.pendingAsk = pending;

		const onAbort = () => {
			this.settlePending(
				pending,
				new Error("Waiting for a Discord reply was cancelled."),
			);
		};
		if (options.signal) {
			options.signal.addEventListener("abort", onAbort, { once: true });
			pending.cleanup = () =>
				options.signal?.removeEventListener("abort", onAbort);
		}
		pending.timer = setTimeout(() => {
			this.settlePending(
				pending,
				new Error(
					`No Discord reply within ${Math.round(timeoutMs / 1_000)}s.`,
				),
			);
		}, timeoutMs);

		const mention =
			(options.mentionUser ?? config.mentionOnAsk)
				? config.allowedUserIds[0]
				: undefined;
		const prefix = mention ? `<@${mention}> ` : "";
		const content =
			`${prefix}❓ **Question from Pi**\n${text}\n\n` +
			"Reply to this message or post your answer in this channel.";

		try {
			const sent = await this.send(content, {
				mentionUserIds: mention ? [mention] : [],
			});
			pending.messageIds = sent.messageIds;
		} catch (error) {
			this.settlePending(pending, new Error(formatApiError(error)));
			throw error;
		}

		const answer = await answerPromise;
		return { ...answer, questionMessageIds: [...pending.messageIds] };
	}

	private enqueueMessage(message: DiscordMessage, generation: number): void {
		const run = () => this.processMessage(message, generation);
		this.inboundChain = this.inboundChain.then(run, run);
	}

	private async processMessage(
		message: DiscordMessage,
		generation: number,
	): Promise<void> {
		try {
			if (generation !== this.generation || !this.active) return;
			if (!this.targetChannelId || message.channel_id !== this.targetChannelId) {
				return;
			}

			const author = message.author;
			if (!author || author.bot || message.webhook_id) return;
			if (!this.config.allowedUserIds.includes(author.id)) {
				if (!this.warnedUsers.has(author.id)) {
					this.warnedUsers.add(author.id);
					this.notify(
						`Ignored a message from a non-allowed Discord user: ${author.username} (${author.id})`,
						"warning",
					);
				}
				return;
			}

			const content = this.normalizeContent(message.content ?? "");
			const command = content ? parseSlashCommand(content) : undefined;
			const commandKind = command
				? this.resolveCommandKind(command.name)
				: undefined;

			// Commands the bridge understands always execute, even while a discord_ask
			// question is pending: an explicit command is not an answer.
			if (command && commandKind) {
				await this.handleSlashCommand(command, commandKind);
				return;
			}

			const pending = this.pendingAsk;
			if (pending) {
				if (!content) {
					if (Array.isArray(message.attachments) && message.attachments.length > 0) {
						await this.safeSend(
							"v0.1 supports text answers only. Please answer the question in text.",
						);
					}
					return;
				}
				this.settlePending(pending, undefined, {
					text: content,
					messageId: message.id,
					authorId: author.id,
					receivedAt: Date.now(),
					questionMessageIds: [...pending.messageIds],
				});
				return;
			}

			if (!content) {
				if (Array.isArray(message.attachments) && message.attachments.length > 0) {
					await this.safeSend(
						"v0.1 supports text messages only. Attachments are not forwarded to Pi.",
					);
				}
				return;
			}

			if (command) {
				await this.safeSend(unknownCommandText(command.name));
				return;
			}

			await this.forwardToPi(content, author, message);
		} catch (error) {
			this.lastError = errorMessage(error);
			this.debug(`Failed to process the message: ${this.lastError}`);
		}
	}

	private normalizeContent(content: string): string {
		const botId = this.botUser?.id;
		let text = content.replace(/\r\n/g, "\n");
		if (botId) {
			text = text.replace(new RegExp(`<@!?${botId}>`, "g"), " ");
		}
		return text
			.replace(/[\t ]+/g, " ")
			.replace(/\n{3,}/g, "\n\n")
			.trim();
	}

	private resolveCommandKind(name: string): SlashCommandKind | undefined {
		if (isBridgeCommand(name)) return "bridge";
		if (isSupportedBuiltin(name)) return "builtin";
		if (isUnsupportedBuiltin(name)) return "unsupported";
		if (this.findExtensionCommand(name)) return "extension";
		return undefined;
	}

	private findExtensionCommand(name: string) {
		try {
			return this.pi
				.getCommands()
				.find((command) => command.name.toLowerCase() === name);
		} catch (error) {
			this.debug(`Failed to list available commands: ${errorMessage(error)}`);
			return undefined;
		}
	}

	private commandHelpText(): string {
		let extensionCommands: string[] = [];
		try {
			extensionCommands = this.pi.getCommands().map((command) => command.name);
		} catch (error) {
			this.debug(`Failed to list available commands: ${errorMessage(error)}`);
		}
		return formatCommandHelp({ extensionCommands });
	}

	private async handleSlashCommand(
		command: ParsedSlashCommand,
		kind: SlashCommandKind,
	): Promise<void> {
		switch (kind) {
			case "bridge":
				await this.handleBridgeCommandFromDiscord(command);
				return;
			case "builtin":
				await this.handleBuiltinCommandFromDiscord(command);
				return;
			case "unsupported":
				await this.safeSend(unsupportedCommandText(command.name));
				return;
			case "extension":
				await this.forwardCommandToPi(command);
				return;
		}
	}

	private async handleBridgeCommandFromDiscord(
		command: ParsedSlashCommand,
	): Promise<void> {
		const ctx = this.ctx;
		if (!ctx) {
			await this.safeSend("Cannot run the command without a Pi session context.");
			return;
		}

		const subcommand = subcommandOf(command.args);
		if (
			subcommand === "on" ||
			subcommand === "off" ||
			subcommand === "reconnect"
		) {
			// Reply before running: these restart or stop the bridge, which drops the
			// REST client the reply would need.
			await this.safeSend(`▶️ Running \`/discord-bridge ${subcommand}\`.`);
			await this.runCommand(command.args, ctx, { interactive: false });
			return;
		}

		const reply = await this.runCommand(command.args, ctx, { interactive: false });
		if (reply) await this.safeSend(reply.text);
	}

	private async handleBuiltinCommandFromDiscord(
		command: ParsedSlashCommand,
	): Promise<void> {
		switch (command.name) {
			case "help": {
				await this.safeSend(this.commandHelpText());
				return;
			}
			case "session": {
				await this.safeSend(this.sessionSummary());
				return;
			}
			case "name": {
				if (!command.args) {
					await this.safeSend("Usage: `/name <session-name>`");
					return;
				}
				this.pi.setSessionName(command.args);
				await this.safeSend(`Session name changed to **${command.args}**`);
				return;
			}
			case "compact": {
				await this.startCompactionFromDiscord(command.args);
				return;
			}
			case "model": {
				await this.safeSend(await this.applyModelCommand(command.args));
				return;
			}
			case "thinking": {
				await this.safeSend(this.applyThinkingCommand(command.args));
				return;
			}
			case "stop":
			case "abort": {
				const ctx = this.ctx;
				if (!ctx) {
					await this.safeSend("Cannot abort without a Pi session context.");
					return;
				}
				ctx.abort();
				await this.safeSend("⏹️ Requested abort of the current work.");
				return;
			}
		}
	}

	private async startCompactionFromDiscord(instructions: string): Promise<void> {
		const ctx = this.ctx;
		if (!ctx) {
			await this.safeSend("Cannot start compaction without a Pi session context.");
			return;
		}
		if (!ctx.model) {
			await this.safeSend("Cannot compact the context without a selected model.");
			return;
		}

		try {
			ctx.compact({
				customInstructions: instructions || undefined,
				onComplete: (result) => {
					const after =
						result.estimatedTokensAfter === undefined
							? ""
							: ` → ${result.estimatedTokensAfter.toLocaleString("en-US")}`;
					void this.safeSend(
						`✅ Context compaction complete: ${result.tokensBefore.toLocaleString("en-US")}${after} tokens`,
					);
				},
				onError: (error) => {
					void this.safeSend(`❌ Context compaction failed: ${errorMessage(error)}`);
				},
			});
		} catch (error) {
			await this.safeSend(`Failed to start context compaction: ${errorMessage(error)}`);
			return;
		}
		await this.safeSend(
			"🗜️ Context compaction started. In-flight work will be aborted.",
		);
	}

	private async applyModelCommand(args: string): Promise<string> {
		const ctx = this.ctx;
		if (!ctx) return "No Pi session context.";

		const registry = ctx.modelRegistry;
		const current = ctx.model
			? `${ctx.model.provider}/${ctx.model.id}`
			: "none";

		if (!args) {
			const available = registry
				.getAvailable()
				.map((model) => `${model.provider}/${model.id}`);
			const lines = [`🤖 Current model: \`${current}\``];
			if (available.length > 0) {
				const shown = available.slice(0, 20);
				lines.push("", "Available models:");
				lines.push(...shown.map((name) => `  \`${name}\``));
				if (available.length > shown.length) {
					lines.push(`  …and ${available.length - shown.length} more`);
				}
			} else {
				lines.push(
					"",
					"No authenticated models. Run `/login` in the local terminal.",
				);
			}
			return lines.join("\n");
		}

		const matches = this.findModels(args);
		if (matches.length === 0) {
			return (
				`Model not found: \`${args}\`\n` +
				"Run `/model` to list available models."
			);
		}
		if (matches.length > 1) {
			const shown = matches.slice(0, 20);
			const lines = [
				`Multiple model matches: \`${args}\``,
				...shown.map((model) => `  \`${model.provider}/${model.id}\``),
			];
			if (matches.length > shown.length) {
				lines.push(`  …and ${matches.length - shown.length} more`);
			}
			lines.push("", "Specify the model exactly with `/model <provider/id>`.");
			return lines.join("\n");
		}

		const model = matches[0]!;
		let changed = false;
		try {
			changed = await this.pi.setModel(model);
		} catch (error) {
			return `Failed to change the model: ${errorMessage(error)}`;
		}
		if (!changed) {
			return (
				`Failed to change the model: \`${model.provider}/${model.id}\`\n` +
				"No credentials for this provider. Run `/login` in the local terminal."
			);
		}
		return `🤖 Model changed to \`${model.provider}/${model.id}\``;
	}

	private findModels(query: string) {
		const ctx = this.ctx;
		if (!ctx) return [];

		const registry = ctx.modelRegistry;
		const normalized = query.toLowerCase();
		if (query.includes("/")) {
			const separator = query.indexOf("/");
			const exact = registry.find(
				query.slice(0, separator),
				query.slice(separator + 1),
			);
			if (exact) return [exact];
		}

		return registry.getAvailable().filter((model) => {
			const label = `${model.provider}/${model.id}`.toLowerCase();
			return (
				label === normalized ||
				model.id.toLowerCase() === normalized ||
				(model.name ?? "").toLowerCase() === normalized
			);
		});
	}

	private applyThinkingCommand(args: string): string {
		const level = args.trim().toLowerCase();
		let current: string;
		try {
			current = this.pi.getThinkingLevel();
		} catch (error) {
			current = `unknown (${errorMessage(error)})`;
		}

		if (!level) {
			return (
				`🧠 Current thinking level: \`${current}\`\n` +
				`Change: \`/thinking <${THINKING_LEVELS.join("|")}>\``
			);
		}
		if (!THINKING_LEVELS.includes(level)) {
			return (
				`Invalid thinking level: \`${level}\`\n` +
				`Available: ${THINKING_LEVELS.join(", ")}`
			);
		}

		this.pi.setThinkingLevel(
			level as Parameters<ExtensionAPI["setThinkingLevel"]>[0],
		);
		let applied = level;
		try {
			applied = this.pi.getThinkingLevel();
		} catch {
			// Ignore: the requested level is still a reasonable answer.
		}
		return applied === level
			? `🧠 Thinking level set to \`${applied}\`.`
			: `🧠 Requested thinking level \`${level}\`; the model applied \`${applied}\` instead.`;
	}

	private sessionSummary(): string {
		const ctx = this.ctx;
		if (!ctx) return "No Pi session context.";

		try {
			const lines = ["🗂️ **Pi session**"];
			const name = ctx.sessionManager.getSessionName() || this.pi.getSessionName();
			lines.push(`Name: ${name || "(none)"}`);
			lines.push(`ID: ${this.shortSessionId(ctx.sessionManager.getSessionId())}`);
			lines.push(`cwd: ${ctx.cwd}`);
			lines.push(
				`Model: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "(none)"}`,
			);
			lines.push(`Thinking level: ${this.pi.getThinkingLevel()}`);
			const usage = ctx.getContextUsage();
			if (usage) {
				const tokens =
					usage.tokens === null ? "?" : usage.tokens.toLocaleString("en-US");
				const percent =
					usage.percent === null ? "?" : `${Math.round(usage.percent)}%`;
				lines.push(
					`Context: ${tokens} / ${usage.contextWindow.toLocaleString("en-US")} (${percent})`,
				);
			}
			lines.push(`Work state: ${ctx.isIdle() ? "idle" : "running"}`);
			lines.push(`Pi queue: ${ctx.hasPendingMessages() ? "has messages" : "empty"}`);
			lines.push(`Discord queue: ${this.forwardQueue.length}`);
			lines.push(`Pending question: ${this.pendingAsk ? "yes" : "no"}`);
			if (this.thread && this.parentChannel?.guild_id) {
				lines.push(
					`Thread: https://discord.com/channels/${this.parentChannel.guild_id}/${this.thread.id}`,
				);
			}
			return lines.join("\n");
		} catch (error) {
			return `Failed to read session info: ${errorMessage(error)}`;
		}
	}

	private async forwardCommandToPi(command: ParsedSlashCommand): Promise<void> {
		const ctx = this.ctx;
		if (!ctx) {
			await this.safeSend("Cannot run the command without a Pi session context.");
			return;
		}
		if (!ctx.model) {
			await this.safeSend("Cannot run the command without a selected model.");
			return;
		}

		this.debug(`Forwarding a Discord command to Pi: /${command.name}`);
		this.pi.sendUserMessage(command.raw, {
			expandPromptTemplates: true,
			deliverAs: this.config.delivery,
		});
		await this.safeSend(
			`▶️ Ran \`/${command.name}\`.\nOutput is shown in the local Pi terminal.`,
		);
	}

	private async forwardToPi(
		content: string,
		author: DiscordUser,
		message: DiscordMessage,
	): Promise<void> {
		const ctx = this.ctx;
		if (!ctx) {
			this.notify("Cannot forward the Discord message without a Pi session context.", "error");
			return;
		}

		const authorLabel = author.global_name || author.username || author.id;
		const text = `[Discord:${authorLabel}] ${content}`;
		if (!ctx.model) {
			await this.safeSend(
				"Cannot process the Discord message without a selected model.",
			);
			return;
		}
		this.debug(
			`Queueing the Discord message for Pi (author ${author.id}, message ${message.id}).`,
		);
		this.forwardQueue.push({ text, messageId: message.id });
		this.pumpForwardQueue();
	}

	/** Called from Pi's agent_start event. */
	onAgentStart(): void {
		this.forwardInFlight = false;
		this.clearForwardTimer();
		this.pumpForwardQueue();
	}

	/** Called from Pi's agent_settled event, after retries and compaction are done. */
	onAgentSettled(): void {
		this.forwardInFlight = false;
		this.clearForwardTimer();
		this.pumpForwardQueue();
	}

	private pumpForwardQueue(): void {
		if (this.forwardQueue.length === 0) return;
		const ctx = this.ctx;
		if (!ctx) {
			this.forwardQueue = [];
			return;
		}

		if (!ctx.isIdle()) {
			if (this.isStreaming(ctx)) {
				// Pi is mid-run: deliver as steer (default) so the message is consumed
				// right after the current turn instead of after the run settles.
				void this.flushForwardQueueAsQueued();
				return;
			}
			// Compaction, retry, or another post-run phase: prompt() rejects input
			// here, so keep the queue and re-check shortly instead of dropping it.
			if (this.forwardInFlight) return;
			this.debug("Pi is busy with a non-streaming phase; holding delivery briefly.");
			this.forwardInFlight = true;
			this.clearForwardTimer();
			this.forwardTimer = setTimeout(() => {
				this.forwardTimer = undefined;
				this.forwardInFlight = false;
				this.pumpForwardQueue();
			}, FORWARD_RETRY_MS);
			this.forwardTimer.unref?.();
			return;
		}
		if (this.forwardInFlight) return;

		const item = this.forwardQueue.shift()!;
		this.forwardInFlight = true;
		this.clearForwardTimer();
		this.forwardTimer = setTimeout(() => {
			this.forwardTimer = undefined;
			this.forwardInFlight = false;
			this.pumpForwardQueue();
		}, FORWARD_RETRY_MS);
		this.forwardTimer.unref?.();

		try {
			// Always pass deliverAs: the session may become busy between this check
			// and prompt() running, and prompt() requires it while streaming.
			this.debug(
				`Delivering the Discord message to Pi (message ${item.messageId}, ${this.config.delivery}).`,
			);
			this.pi.sendUserMessage(item.text, { deliverAs: this.config.delivery });
		} catch (error) {
			const detail = errorMessage(error);
			this.lastError = detail;
			this.forwardInFlight = false;
			this.clearForwardTimer();
			this.notify(`Failed to deliver the Discord message to Pi: ${detail}`, "error");
			void this.safeSend(`Failed to forward the message to Pi: ${detail}`);
			this.pumpForwardQueue();
		}
	}

	private isStreaming(ctx: ExtensionContext): boolean {
		try {
			return ctx.signal !== undefined;
		} catch {
			return false;
		}
	}

	private async flushForwardQueueAsQueued(): Promise<void> {
		const items = this.forwardQueue;
		if (items.length === 0) return;
		this.forwardQueue = [];

		if (!this.config.queueWhenBusy) {
			await this.safeSend(
				`Pi is busy, so ${items.length} message(s) were not delivered. ` +
					"Send them again after the run finishes.",
			);
			return;
		}
		if (!this.ctx?.model) {
			await this.safeSend("Cannot process the Discord message without a selected model.");
			return;
		}

		for (const item of items) {
			try {
				this.debug(
					`Queueing the Discord message as ${this.config.delivery} (message ${item.messageId}).`,
				);
				this.pi.sendUserMessage(item.text, {
					deliverAs: this.config.delivery,
				});
			} catch (error) {
				const detail = errorMessage(error);
				this.lastError = detail;
				this.notify(`Failed to queue the Discord message: ${detail}`, "error");
				void this.safeSend(`Failed to forward the message to Pi: ${detail}`);
			}
		}
	}

	private clearForwardTimer(): void {
		if (!this.forwardTimer) return;
		clearTimeout(this.forwardTimer);
		this.forwardTimer = undefined;
	}

	private async safeSend(content: string): Promise<void> {
		try {
			await this.send(content);
		} catch (error) {
			this.lastError = formatApiError(error);
			this.debug(`Failed to send the Discord notice: ${this.lastError}`);
		}
	}

	private settlePending(
		pending: PendingAsk,
		error?: Error,
		answer?: AskAnswer,
	): void {
		if (this.pendingAsk !== pending) return;
		this.pendingAsk = undefined;
		if (pending.timer) {
			clearTimeout(pending.timer);
			pending.timer = undefined;
		}
		pending.cleanup?.();
		pending.cleanup = undefined;
		if (error) {
			pending.reject(error);
		} else if (answer) {
			pending.resolve(answer);
		} else {
			pending.reject(new Error("Waiting for a Discord reply ended."));
		}
	}

	private handleGatewayState(
		state: GatewayState,
		_detail: string | undefined,
		generation: number,
	): void {
		if (generation !== this.generation) return;
		this.state = state;
	}

	private handleGatewayError(
		error: Error,
		fatal: boolean,
		generation: number,
	): void {
		if (generation !== this.generation) return;
		this.lastError = fatal ? formatApiError(error) : error.message;
		if (fatal) {
			this.state = "error";
			const pending = this.pendingAsk;
			if (pending) {
				this.settlePending(
					pending,
					new Error(
						`The Discord gateway disconnected, so replies cannot be received: ${this.lastError}`,
					),
				);
			}
			this.notify(`Discord bridge error:\n${this.lastError}`, "error");
			return;
		}
		if (!this.hasEverConnected && !this.firstErrorNotified) {
			this.firstErrorNotified = true;
			this.notify(
				`Failed to connect to the Discord gateway. Retrying automatically: ${error.message}`,
				"warning",
			);
		}
	}

	async sendTest(): Promise<SendResult> {
		return this.send(
			"✅ **Pi Discord bridge test**\n" +
				"The Pi session and Discord channel are connected.",
		);
	}

	async handleCommand(args: string | undefined, ctx: ExtensionContext): Promise<void> {
		const reply = await this.runCommand(args, ctx, { interactive: true });
		if (reply) this.notify(reply.text, reply.level);
	}

	/**
	 * Execute a `/discord-bridge` subcommand.
	 *
	 * Returns the reply for the caller, or `undefined` when the command already
	 * reported its result (thread deletion, enable/disable, reconnect).
	 */
	async runCommand(
		args: string | undefined,
		ctx: ExtensionContext,
		options: { interactive: boolean } = { interactive: true },
	): Promise<CommandReply | undefined> {
		const input = (args ?? "").trim() || "status";
		const [subcommand = "status", ...rest] = input.split(/\s+/);
		const value = rest.join(" ").trim();

		switch (subcommand.toLowerCase()) {
			case "delete": {
				if (!options.interactive) {
					return {
						text:
							"Threads cannot be deleted from Discord.\n" +
							"Run `/discord-bridge delete` in the local Pi terminal.",
						level: "warning",
					};
				}
				await this.deleteCurrentThread(ctx);
				return undefined;
			}
			case "on": {
				await this.setEnabled(true, ctx);
				return undefined;
			}
			case "off": {
				await this.setEnabled(false, ctx);
				return undefined;
			}
			case "reconnect": {
				await this.reconnect(ctx);
				return undefined;
			}
			case "test": {
				try {
					const result = await this.sendTest();
					return {
						text: `Sent the Discord test message (${result.count}).`,
						level: "info",
					};
				} catch (error) {
					return {
						text: `Discord test failed: ${formatApiError(error)}`,
						level: "error",
					};
				}
			}
			case "send": {
				if (!value) {
					return {
						text: "Usage: /discord-bridge send <message>",
						level: "warning",
					};
				}
				try {
					const result = await this.send(value);
					return {
						text: `Sent to Discord (${result.count}, id ${result.messageIds.join(", ")}).`,
						level: "info",
					};
				} catch (error) {
					return {
						text: `Failed to send to Discord: ${formatApiError(error)}`,
						level: "error",
					};
				}
			}
			case "status": {
				const level: CommandLevel =
					this.config.errors.length > 0 ? "error" : "info";
				return { text: this.statusText(), level };
			}
			case "help": {
				return {
					text: [
						"Usage: /discord-bridge <command>",
						"  status         Show the current status",
						"  on|off         Enable/disable the bridge (persisted to the config file)",
						"  reconnect      Reconnect the Discord gateway",
						"  delete         Delete the current session thread and disconnect (local only)",
						"  test           Send a test message to Discord",
						"  send <message> Send a message to Discord",
					].join("\n"),
					level: "info",
				};
			}
			default: {
				return {
					text: `Unknown command: ${subcommand}\nRun /discord-bridge help.`,
					level: "warning",
				};
			}
		}
	}
}
