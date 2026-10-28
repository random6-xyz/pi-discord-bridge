import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const DEFAULT_ASK_TIMEOUT_MS = 15 * 60 * 1_000;
export const DEFAULT_THREAD_AUTO_ARCHIVE_MINUTES = 10_080;
const MIN_ASK_TIMEOUT_MS = 1_000;
const MAX_ASK_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const THREAD_AUTO_ARCHIVE_MINUTES = new Set([60, 1_440, 4_320, 10_080]);

export type BridgeMode = "channel" | "thread";

/**
 * How Discord input is delivered while Pi is already working.
 *
 * - `steer`: inject after the current assistant turn, before the next LLM call.
 * - `followUp`: queue until the whole agent run settles.
 */
export type BridgeDelivery = "steer" | "followUp";

export interface BridgeConfig {
	enabled: boolean;
	/** Parent Discord channel. In thread mode, each Pi session gets a thread here. */
	channelId: string;
	mode: BridgeMode;
	threadName?: string;
	threadAutoArchiveMinutes: number;
	allowedUserIds: string[];
	queueWhenBusy: boolean;
	delivery: BridgeDelivery;
	askTimeoutMs: number;
	mentionOnAsk: boolean;
	/** Parsed for compatibility with the spec. v0.1 never sends automatic reports. */
	autoReport: boolean;
	token: string;
	configPath: string;
	warnings: string[];
	errors: string[];
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as JsonRecord)
		: undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const items = value
		.map((item) => (typeof item === "string" ? item.trim() : ""))
		.filter((item) => item.length > 0);
	return items.length > 0 ? items : undefined;
}

function env(name: string): string | undefined {
	return asString(process.env[name]);
}

function envBoolean(name: string): boolean | undefined {
	const raw = env(name)?.toLowerCase();
	if (!raw) return undefined;
	if (["1", "true", "yes", "on"].includes(raw)) return true;
	if (["0", "false", "no", "off"].includes(raw)) return false;
	return undefined;
}

function envNumber(name: string): number | undefined {
	const raw = env(name);
	if (!raw) return undefined;
	const value = Number(raw);
	return Number.isFinite(value) ? value : undefined;
}

export function getAgentDir(): string {
	const configured = process.env.PI_CODING_AGENT_DIR?.trim();
	return resolve(configured || join(homedir(), ".pi", "agent"));
}

export function getDefaultConfigPath(): string {
	return resolve(
		process.env.PI_DISCORD_BRIDGE_CONFIG?.trim() ||
			join(getAgentDir(), "discord-bridge.json"),
	);
}

function parseId(value: string | undefined, label: string, errors: string[]): string {
	const id = value?.trim() ?? "";
	if (!id) {
		errors.push(`Missing required setting: ${label}.`);
		return "";
	}
	if (!/^\d{1,25}$/.test(id)) {
		errors.push(`Invalid ${label}: ${id}`);
		return "";
	}
	return id;
}

function parseUserIds(
	values: string[] | undefined,
	label: string,
	errors: string[],
): string[] {
	const ids = [...new Set(values ?? [])];
	if (ids.length === 0) {
		errors.push(`Missing required setting: ${label}.`);
		return [];
	}
	const invalid = ids.filter((id) => !/^\d{1,25}$/.test(id));
	if (invalid.length > 0) {
		errors.push(`Invalid ${label}: ${invalid.join(", ")}`);
	}
	return ids.filter((id) => /^\d{1,25}$/.test(id));
}

function parseDelivery(
	value: string | undefined,
	warnings: string[],
): BridgeDelivery {
	const normalized = value?.toLowerCase();
	if (!normalized) return "steer";
	if (normalized === "steer") return "steer";
	if (normalized === "followup" || normalized === "follow-up") return "followUp";
	warnings.push(
		`input.delivery must be "steer" or "followUp". Using the default "steer": ${value}`,
	);
	return "steer";
}

function clampAskTimeout(value: number | undefined): number {
	const timeout = value ?? DEFAULT_ASK_TIMEOUT_MS;
	return Math.min(MAX_ASK_TIMEOUT_MS, Math.max(MIN_ASK_TIMEOUT_MS, Math.round(timeout)));
}

export function loadConfig(configPath = getDefaultConfigPath()): BridgeConfig {
	const warnings: string[] = [];
	const errors: string[] = [];
	let root: JsonRecord = {};

	if (existsSync(configPath)) {
		try {
			const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
			root = asRecord(parsed) ?? {};
			if (!asRecord(parsed)) warnings.push(`Config file is not a JSON object: ${configPath}`);
		} catch (error) {
			errors.push(
				`Cannot read the config file (${configPath}): ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	} else {
		warnings.push(`Config file not found. Using defaults: ${configPath}`);
	}

	const discord = asRecord(root.discord) ?? {};
	const input = asRecord(root.input) ?? {};
	const reporting = asRecord(root.reporting) ?? {};

	const enabled =
		asBoolean(discord.enabled) ?? asBoolean(root.enabled) ?? false;

	const channelId = parseId(
		env("DISCORD_CHANNEL_ID") ??
			asString(discord.channelId) ??
			asString(root.channelId),
		"Discord channel ID",
		errors,
	);

	const modeValue = (
		env("DISCORD_MODE") ??
		asString(discord.mode) ??
		asString(root.mode) ??
		"thread"
	).toLowerCase();
	let mode: BridgeMode = "thread";
	if (modeValue === "thread" || modeValue === "channel") {
		mode = modeValue;
	} else {
		errors.push(
			`discord.mode must be "thread" or "channel": ${modeValue}`,
		);
	}

	const threadName =
		env("DISCORD_THREAD_NAME") ??
		asString(discord.threadName) ??
		asString(root.threadName);

	const rawThreadAutoArchiveMinutes =
		envNumber("DISCORD_THREAD_AUTO_ARCHIVE_MINUTES") ??
		asNumber(discord.threadAutoArchiveMinutes) ??
		asNumber(root.threadAutoArchiveMinutes) ??
		DEFAULT_THREAD_AUTO_ARCHIVE_MINUTES;
	let threadAutoArchiveMinutes = DEFAULT_THREAD_AUTO_ARCHIVE_MINUTES;
	if (THREAD_AUTO_ARCHIVE_MINUTES.has(rawThreadAutoArchiveMinutes)) {
		threadAutoArchiveMinutes = rawThreadAutoArchiveMinutes;
	} else {
		warnings.push(
			`threadAutoArchiveMinutes must be one of 60, 1440, 4320, 10080. ` +
				`Using the default ${DEFAULT_THREAD_AUTO_ARCHIVE_MINUTES}.`,
		);
	}

	const allowedUserIds = parseUserIds(
		env("DISCORD_ALLOWED_USER_IDS")
			? env("DISCORD_ALLOWED_USER_IDS")!
					.split(",")
					.map((id) => id.trim())
					.filter(Boolean)
			: asStringArray(discord.allowedUserIds) ?? asStringArray(root.allowedUserIds),
		"Discord allowed user IDs",
		errors,
	);

	const token = (env("DISCORD_BOT_TOKEN") ?? env("PI_DISCORD_BOT_TOKEN") ?? "")
		.replace(/^bot\s+/i, "")
		.trim();
	if (!token) {
		errors.push("Environment variable DISCORD_BOT_TOKEN is not set.");
	} else if (/^https?:\/\//i.test(token)) {
		errors.push("DISCORD_BOT_TOKEN contains a webhook URL. Use a bot token.");
	}

	const queueWhenBusy =
		envBoolean("DISCORD_QUEUE_WHEN_BUSY") ??
		asBoolean(input.queueWhenBusy) ??
		asBoolean(discord.queueWhenBusy) ??
		true;

	const delivery = parseDelivery(
		env("DISCORD_DELIVERY") ??
			asString(input.delivery) ??
			asString(discord.delivery),
		warnings,
	);

	const askTimeoutMs = clampAskTimeout(
		envNumber("DISCORD_ASK_TIMEOUT_MS") ??
			asNumber(root.askTimeoutMs) ??
			asNumber(discord.askTimeoutMs),
	);

	const mentionOnAsk =
		envBoolean("DISCORD_MENTION_ON_ASK") ??
		asBoolean(discord.mentionOnAsk) ??
		false;

	const autoReport =
		asBoolean(reporting.autoReport) ?? asBoolean(root.autoReport) ?? false;

	if (autoReport) {
		warnings.push(
			"reporting.autoReport is not supported in v0.1. Only explicit discord_send calls send messages.",
		);
	}

	return {
		enabled,
		channelId,
		mode,
		threadName,
		threadAutoArchiveMinutes,
		allowedUserIds,
		queueWhenBusy,
		delivery,
		askTimeoutMs,
		mentionOnAsk,
		autoReport,
		token,
		configPath,
		warnings,
		errors,
	};
}

export function persistEnabled(
	config: BridgeConfig,
	enabled: boolean,
): { ok: true } | { ok: false; error: string } {
	try {
		let root: JsonRecord = {};
		const hadConfigFile = existsSync(config.configPath);
		if (hadConfigFile) {
			const parsed: unknown = JSON.parse(readFileSync(config.configPath, "utf8"));
			const record = asRecord(parsed);
			if (!record) throw new Error("The top-level config value is not a JSON object.");
			root = record;
		}

		const discord = asRecord(root.discord) ?? {};
		if (hadConfigFile) {
			// Only update enabled on an existing file; env overrides must not be written back.
			root.discord = { ...discord, enabled };
		} else {
			root.discord = {
				enabled,
				...(config.channelId ? { channelId: config.channelId } : {}),
				mode: config.mode,
				...(config.threadName ? { threadName: config.threadName } : {}),
				threadAutoArchiveMinutes: config.threadAutoArchiveMinutes,
				...(config.allowedUserIds.length > 0
					? { allowedUserIds: config.allowedUserIds }
					: {}),
				askTimeoutMs: config.askTimeoutMs,
				mentionOnAsk: config.mentionOnAsk,
			};
			root.reporting = { autoReport: false };
			root.input = {
				queueWhenBusy: config.queueWhenBusy,
				delivery: config.delivery,
			};
		}

		mkdirSync(dirname(config.configPath), { recursive: true });
		const tempPath = `${config.configPath}.${process.pid}.tmp`;
		writeFileSync(tempPath, `${JSON.stringify(root, null, 2)}\n`, "utf8");
		renameSync(tempPath, config.configPath);
		return { ok: true };
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}
