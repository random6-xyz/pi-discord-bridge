import { splitDiscordMessage } from "./text.ts";

export const DISCORD_API_BASE = "https://discord.com/api/v10";

export interface DiscordUser {
	id: string;
	username: string;
	global_name?: string | null;
	discriminator?: string;
	bot?: boolean;
}

export interface DiscordThreadMetadata {
	archived?: boolean;
	auto_archive_duration?: number;
	archive_timestamp?: string;
	locked?: boolean;
	invitable?: boolean;
	create_timestamp?: string;
}

export interface DiscordChannel {
	id: string;
	type: number;
	name?: string | null;
	guild_id?: string | null;
	parent_id?: string | null;
	owner_id?: string | null;
	thread_metadata?: DiscordThreadMetadata;
}

export interface DiscordMessage {
	id: string;
	channel_id: string;
	content: string;
	timestamp?: string;
	author?: DiscordUser;
	webhook_id?: string;
	attachments?: unknown[];
}

export interface DiscordRestOptions {
	token: string;
	apiBase?: string;
	userAgent?: string;
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
}

export interface SendMessageOptions {
	mentionUserIds?: string[];
}

export interface SendMessageResult {
	messages: DiscordMessage[];
}

export class DiscordApiError extends Error {
	readonly status: number;
	readonly code: number | undefined;

	constructor(message: string, status: number, code?: number) {
		super(message);
		this.name = "DiscordApiError";
		this.status = status;
		this.code = code;
	}
}

interface RequestOptions {
	/** Retry ambiguous network failures. Disable for non-idempotent POSTs. */
	retryNetwork?: boolean;
	/** Retry HTTP 5xx responses. Disable for non-idempotent POSTs. */
	retryServerErrors?: boolean;
}

function sleep(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isRetryableStatus(status: number): boolean {
	return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

export class DiscordRest {
	private readonly token: string;
	private readonly apiBase: string;
	private readonly userAgent: string;
	private readonly timeoutMs: number;
	private readonly fetchImpl: typeof fetch;
	private sendChain: Promise<unknown> = Promise.resolve();

	constructor(options: DiscordRestOptions) {
		this.token = options.token;
		this.apiBase = (options.apiBase ?? DISCORD_API_BASE).replace(/\/+$/, "");
		this.userAgent = options.userAgent ?? "pi-discord-bridge (0.1.0)";
		this.timeoutMs = options.timeoutMs ?? 15_000;
		this.fetchImpl = options.fetchImpl ?? fetch;
	}

	private async request<T>(
		path: string,
		init: RequestInit = {},
		options: RequestOptions = {},
	): Promise<T> {
		const url = `${this.apiBase}${path}`;
		let lastError: Error | undefined;

		for (let attempt = 0; attempt < 4; attempt += 1) {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), this.timeoutMs);
			const signal = init.signal
				? AbortSignal.any([init.signal, controller.signal])
				: controller.signal;

			try {
				const response = await this.fetchImpl(url, {
					...init,
					signal,
					headers: {
						Authorization: `Bot ${this.token}`,
						"Content-Type": "application/json",
						"User-Agent": this.userAgent,
						...init.headers,
					},
				});

				if (response.status === 429) {
					const retryAfter = await this.readRetryAfter(response);
					await sleep(retryAfter);
					lastError = new DiscordApiError(
						`Discord API request was rate limited (retry ${attempt + 1}/4).`,
						429,
					);
					continue;
				}

				if (
					isRetryableStatus(response.status) &&
					response.status !== 429 &&
					options.retryServerErrors !== false &&
					attempt < 3
				) {
					lastError = new DiscordApiError(
						`Discord API server error (HTTP ${response.status}).`,
						response.status,
					);
					await sleep(500 * 2 ** attempt);
					continue;
				}

				if (!response.ok) {
					throw await this.toApiError(response);
				}

				if (response.status === 204) return undefined as T;
				return (await response.json()) as T;
			} catch (error) {
				if (error instanceof DiscordApiError) throw error;
				const normalized = controller.signal.aborted
					? new Error(
							`Discord API request timed out (${Math.round(this.timeoutMs / 1_000)}s).`,
						)
					: error instanceof Error
						? error
						: new Error(String(error));
				lastError = normalized;
				if (options.retryNetwork !== false && attempt < 3) {
					await sleep(300 * 2 ** attempt);
					continue;
				}
				throw normalized;
			} finally {
				clearTimeout(timer);
			}
		}

		throw lastError ?? new Error("Discord API request failed.");
	}

	private async readRetryAfter(response: Response): Promise<number> {
		try {
			const body = (await response.json()) as { retry_after?: unknown };
			if (typeof body.retry_after === "number" && Number.isFinite(body.retry_after)) {
				return Math.max(250, Math.ceil(body.retry_after * 1_000) + 250);
			}
		} catch {
			// Fall through to the header or a conservative default.
		}
		const header = Number(response.headers.get("retry-after"));
		if (Number.isFinite(header) && header > 0) {
			return Math.max(250, Math.ceil(header * 1_000) + 250);
		}
		return 1_500;
	}

	private async toApiError(response: Response): Promise<DiscordApiError> {
		const text = await response.text().catch(() => "");
		let body: { message?: unknown; code?: unknown } | undefined;
		try {
			body = JSON.parse(text) as { message?: unknown; code?: unknown };
		} catch {
			body = undefined;
		}
		const detail =
			typeof body?.message === "string" && body.message
				? body.message
				: text.slice(0, 300) || response.statusText;
		const code = typeof body?.code === "number" ? body.code : undefined;
		return new DiscordApiError(
			`Discord API error (HTTP ${response.status}${code ? `, code ${code}` : ""}): ${detail}`,
			response.status,
			code,
		);
	}

	async getMe(): Promise<DiscordUser> {
		return this.request<DiscordUser>("/users/@me");
	}

	async getChannel(channelId: string): Promise<DiscordChannel> {
		return this.request<DiscordChannel>(`/channels/${encodeURIComponent(channelId)}`);
	}

	async createPublicThread(
		parentChannelId: string,
		name: string,
		autoArchiveDuration: number,
	): Promise<DiscordChannel> {
		return this.request<DiscordChannel>(
			`/channels/${encodeURIComponent(parentChannelId)}/threads`,
			{
				method: "POST",
				body: JSON.stringify({
					name,
					type: 11,
					auto_archive_duration: autoArchiveDuration,
				}),
			},
		);
	}

	async unarchiveThread(threadId: string): Promise<DiscordChannel> {
		return this.request<DiscordChannel>(
			`/channels/${encodeURIComponent(threadId)}`,
			{
				method: "PATCH",
				body: JSON.stringify({ archived: false }),
			},
		);
	}

	async ensureThreadActive(threadId: string): Promise<DiscordChannel> {
		const channel = await this.getChannel(threadId);
		if (channel.thread_metadata?.archived) {
			return this.unarchiveThread(threadId);
		}
		return channel;
	}

	async listActiveThreads(guildId: string): Promise<DiscordChannel[]> {
		const data = await this.request<{ threads?: DiscordChannel[] }>(
			`/guilds/${encodeURIComponent(guildId)}/threads/active`,
		);
		return data.threads ?? [];
	}

	async listArchivedPublicThreads(
		parentChannelId: string,
		limit = 100,
	): Promise<DiscordChannel[]> {
		const data = await this.request<{ threads?: DiscordChannel[] }>(
			`/channels/${encodeURIComponent(parentChannelId)}/threads/archived/public?limit=${limit}`,
		);
		return data.threads ?? [];
	}

	async deleteChannel(channelId: string): Promise<void> {
		await this.request<unknown>(
			`/channels/${encodeURIComponent(channelId)}`,
			{ method: "DELETE" },
		);
	}

	private enqueue<T>(task: () => Promise<T>): Promise<T> {
		const run = this.sendChain.then(task, task);
		this.sendChain = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	async sendMessage(
		channelId: string,
		content: string,
		options: SendMessageOptions = {},
	): Promise<SendMessageResult> {
		const chunks = splitDiscordMessage(content);
		if (chunks.length === 0) {
			throw new Error("Cannot send an empty message to Discord.");
		}

		return this.enqueue(async () => {
			const messages: DiscordMessage[] = [];
			for (const [index, chunk] of chunks.entries()) {
				const mentionUserIds =
					index === 0 ? [...new Set(options.mentionUserIds ?? [])] : [];
				const payload: Record<string, unknown> = {
					content: chunk,
					allowed_mentions:
						mentionUserIds.length > 0
							? { parse: [], users: mentionUserIds }
							: { parse: [] },
				};
				const message = await this.request<DiscordMessage>(
					`/channels/${encodeURIComponent(channelId)}/messages`,
					{
						method: "POST",
						body: JSON.stringify(payload),
					},
					{ retryNetwork: false, retryServerErrors: false },
				);
				messages.push(message);
			}
			return { messages };
		});
	}

	async deleteMessage(channelId: string, messageId: string): Promise<void> {
		await this.request<void>(
			`/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`,
			{ method: "DELETE" },
		);
	}
}
