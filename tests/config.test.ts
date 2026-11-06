import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.ts";

const TOKEN_KEY = "DISCORD_BOT_TOKEN";
const CHANNEL_KEY = "DISCORD_CHANNEL_ID";
const USERS_KEY = "DISCORD_ALLOWED_USER_IDS";
const CONFIG_KEY = "PI_DISCORD_BRIDGE_CONFIG";

function withEnv<T>(values: Record<string, string | undefined>, fn: () => T): T {
	const previous = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries(values)) {
		previous.set(key, process.env[key]);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		return fn();
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

test("loads the spec-shaped config file", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-discord-config-"));
	const path = join(dir, "discord-bridge.json");
	writeFileSync(
		path,
		JSON.stringify({
			discord: {
				enabled: true,
				mode: "thread",
				channelId: "123456789012345678",
				allowedUserIds: ["111111111111111111"],
				askTimeoutMs: 12345,
			},
			reporting: { autoReport: false },
			input: { queueWhenBusy: false },
		}),
	);

	const config = withEnv(
		{
			[TOKEN_KEY]: "test-token",
			[CHANNEL_KEY]: undefined,
			[USERS_KEY]: undefined,
			[CONFIG_KEY]: path,
		},
		() => loadConfig(),
	);

	assert.ok(
		config.warnings.some((warning) => warning.includes("discord.enabled is ignored")),
	);
	assert.equal(config.mode, "thread");
	assert.equal(config.threadAutoArchiveMinutes, 10_080);
	assert.equal(config.channelId, "123456789012345678");
	assert.deepEqual(config.allowedUserIds, ["111111111111111111"]);
	assert.equal(config.askTimeoutMs, 12_345);
	assert.equal(config.queueWhenBusy, false);
	assert.equal(config.delivery, "steer");
	assert.equal(config.token, "test-token");
	assert.deepEqual(config.errors, []);
});

test("ignores a missing enabled flag", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-discord-config-"));
	const path = join(dir, "discord-bridge.json");
	writeFileSync(
		path,
		JSON.stringify({
			discord: {
				channelId: "111111111111111111",
				allowedUserIds: ["222222222222222222"],
			},
		}),
	);

	const config = withEnv(
		{
			[TOKEN_KEY]: "test-token",
			[CHANNEL_KEY]: undefined,
			[USERS_KEY]: undefined,
			[CONFIG_KEY]: path,
		},
		() => loadConfig(),
	);

	assert.equal("enabled" in config, false);
	assert.deepEqual(config.warnings, []);
	assert.equal(config.mode, "thread");
});

test("environment variables override channel and users", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-discord-config-"));
	const path = join(dir, "discord-bridge.json");
	writeFileSync(
		path,
		JSON.stringify({
			discord: {
				enabled: true,
				channelId: "111111111111111111",
				allowedUserIds: ["222222222222222222"],
			},
		}),
	);

	const config = withEnv(
		{
			[TOKEN_KEY]: "Bot test-token",
			[CHANNEL_KEY]: "333333333333333333",
			[USERS_KEY]: "444444444444444444, 555555555555555555",
			["DISCORD_MODE"]: "channel",
			[CONFIG_KEY]: path,
		},
		() => loadConfig(),
	);

	assert.equal(config.channelId, "333333333333333333");
	assert.deepEqual(config.allowedUserIds, [
		"444444444444444444",
		"555555555555555555",
	]);
	assert.equal(config.token, "test-token");
	assert.equal(config.mode, "channel");
});

test("reports missing required settings", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-discord-config-"));
	const path = join(dir, "discord-bridge.json");
	const config = withEnv(
		{
			[TOKEN_KEY]: undefined,
			[CHANNEL_KEY]: undefined,
			[USERS_KEY]: undefined,
			[CONFIG_KEY]: path,
		},
		() => loadConfig(),
	);

	assert.ok(config.errors.some((error) => error.includes("DISCORD_BOT_TOKEN")));
	assert.ok(config.errors.some((error) => error.includes("channel ID")));
	assert.ok(config.errors.some((error) => error.includes("allowed user IDs")));
});

test("parses input.delivery and normalizes follow-up aliases", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-discord-config-"));
	const path = join(dir, "discord-bridge.json");
	writeFileSync(
		path,
		JSON.stringify({
			discord: {
				channelId: "111111111111111111",
				allowedUserIds: ["222222222222222222"],
			},
			input: { delivery: "follow-up" },
		}),
	);

	const config = withEnv(
		{
			[TOKEN_KEY]: "test-token",
			[CHANNEL_KEY]: undefined,
			[USERS_KEY]: undefined,
			[CONFIG_KEY]: path,
		},
		() => loadConfig(),
	);

	assert.equal(config.delivery, "followUp");
	assert.deepEqual(config.warnings, []);
});

test("warns and falls back to steer for invalid delivery values", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-discord-config-"));
	const path = join(dir, "discord-bridge.json");
	writeFileSync(
		path,
		JSON.stringify({
			discord: {
				channelId: "111111111111111111",
				allowedUserIds: ["222222222222222222"],
			},
			input: { delivery: "instant" },
		}),
	);

	const config = withEnv(
		{
			[TOKEN_KEY]: "test-token",
			[CHANNEL_KEY]: undefined,
			[USERS_KEY]: undefined,
			[CONFIG_KEY]: path,
		},
		() => loadConfig(),
	);

	assert.equal(config.delivery, "steer");
	assert.ok(
		config.warnings.some((warning) => warning.includes("input.delivery")),
	);
});

test("lets DISCORD_DELIVERY override the config file", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-discord-config-"));
	const path = join(dir, "discord-bridge.json");
	writeFileSync(
		path,
		JSON.stringify({
			discord: {
				channelId: "111111111111111111",
				allowedUserIds: ["222222222222222222"],
			},
			input: { delivery: "followUp" },
		}),
	);

	const config = withEnv(
		{
			[TOKEN_KEY]: "test-token",
			["DISCORD_DELIVERY"]: "steer",
			[CHANNEL_KEY]: undefined,
			[USERS_KEY]: undefined,
			[CONFIG_KEY]: path,
		},
		() => loadConfig(),
	);

	assert.equal(config.delivery, "steer");
});

