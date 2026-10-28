import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DiscordBridge } from "../src/bridge.ts";

const MODELS = [
	{ provider: "test-provider", id: "model-1", name: "Model One" },
	{ provider: "other-provider", id: "model-2", name: "Model Two" },
	{ provider: "test-provider", id: "model-2", name: "Shared Two" },
];

function createHarness() {
	const fakePi = {
		sent: [] as Array<{ content: string; options?: unknown }>,
		appended: [] as Array<{ type: string; data?: unknown }>,
		sessionName: undefined as string | undefined,
		thinkingLevel: "off",
		selectedModel: undefined as unknown,
		commands: [] as Array<{ name: string; description?: string }>,
		sendUserMessage(content: string, options?: unknown) {
			this.sent.push({ content, options });
		},
		appendEntry(type: string, data?: unknown) {
			this.appended.push({ type, data });
		},
		setSessionName(name: string) {
			this.sessionName = name;
		},
		getSessionName() {
			return this.sessionName;
		},
		getCommands() {
			return this.commands.map((command) => ({
				...command,
				source: "extension",
				sourceInfo: { path: "/tmp/extension.ts" },
			}));
		},
		async setModel(model: unknown) {
			this.selectedModel = model;
			return true;
		},
		getThinkingLevel() {
			return this.thinkingLevel;
		},
		setThinkingLevel(level: string) {
			this.thinkingLevel = level;
		},
	};
	const bridge = new DiscordBridge(fakePi as never) as any;
	const config = {
		enabled: true,
		channelId: "parent-1",
		mode: "thread",
		threadName: undefined as string | undefined,
		threadAutoArchiveMinutes: 10_080,
		allowedUserIds: ["user-1"],
		queueWhenBusy: true,
		delivery: "steer" as "steer" | "followUp",
		askTimeoutMs: 60_000,
		mentionOnAsk: false,
		autoReport: false,
		token: "token",
		configPath: "/tmp/does-not-matter.json",
		warnings: [] as string[],
		errors: [] as string[],
	};
	const sent: string[] = [];
	const compactCalls: Array<Record<string, unknown>> = [];
	const aborts: number[] = [];
	const ctx = {
		cwd: "/work/api",
		isIdle: () => true,
		hasPendingMessages: () => false,
		hasUI: false,
		model: { provider: "test-provider", id: "model-1", name: "Model One" },
		signal: undefined as AbortSignal | undefined,
		getContextUsage: () => ({
			tokens: 1_234,
			contextWindow: 200_000,
			percent: 0.617,
		}),
		modelRegistry: {
			getAvailable: () => MODELS,
			find: (provider: string, id: string) =>
				MODELS.find((model) => model.provider === provider && model.id === id),
		},
		compact: (options?: Record<string, unknown>) => {
			compactCalls.push(options ?? {});
		},
		abort: () => {
			aborts.push(Date.now());
		},
		sessionManager: {
			getSessionId: () => "session-1",
			getSessionName: () => "api",
			getBranch: () => [],
		},
		ui: { notify: () => undefined, setStatus: () => undefined },
	};

	bridge.config = config;
	bridge.active = true;
	bridge.generation = 1;
	bridge.botUser = { id: "bot-1", username: "pi", bot: true };
	bridge.ctx = ctx;
	bridge.parentChannel = {
		id: "parent-1",
		type: 0,
		name: "pi-bot",
		guild_id: "guild-1",
	};
	bridge.thread = {
		id: "thread-1",
		type: 11,
		name: "api [session1]",
		parent_id: "parent-1",
	};
	bridge.targetChannelId = "thread-1";
	bridge.sessionId = "session-1";
	bridge.send = async (content: string) => {
		sent.push(content);
		return {
			channelId: "thread-1",
			messageIds: [`question-${sent.length}`],
			count: 1,
		};
	};
	bridge.gateway = { isConnected: true, currentState: "connected" };
	bridge.rest = {};

	return {
		bridge,
		fakePi,
		config,
		sent,
		ctx,
		compactCalls,
		aborts,
	};
}

function message(id: string, content: string, authorId = "user-1") {
	return {
		id,
		channel_id: "thread-1",
		content,
		author: { id: authorId, username: "remote-user" },
	};
}

test("forwards allowed Discord messages to Pi", async () => {
	const { bridge, fakePi } = createHarness();
	await bridge.processMessage(message("m1", "hello\nworld"), 1);
	assert.equal(fakePi.sent.length, 1);
	assert.equal(fakePi.sent[0]!.content, "[Discord:remote-user] hello\nworld");
	assert.deepEqual(fakePi.sent[0]!.options, { deliverAs: "steer" });
	bridge.onAgentStart();
});

test("injects input into the running turn while Pi is streaming", async () => {
	const { bridge, fakePi, ctx } = createHarness();
	ctx.isIdle = () => false;
	ctx.signal = new AbortController().signal;
	await bridge.processMessage(message("m1", "queued"), 1);
	assert.equal(fakePi.sent.length, 1);
	assert.deepEqual(fakePi.sent[0]!.options, { deliverAs: "steer" });
	bridge.onAgentSettled();
});

test("honors input.delivery for busy input", async () => {
	const { bridge, fakePi, ctx } = createHarness();
	bridge.config.delivery = "followUp";
	ctx.isIdle = () => false;
	ctx.signal = new AbortController().signal;
	await bridge.processMessage(message("m1", "queued"), 1);
	assert.deepEqual(fakePi.sent[0]!.options, { deliverAs: "followUp" });
	bridge.onAgentSettled();
});

test("preserves order for a burst of idle messages", async () => {
	const { bridge, fakePi, ctx } = createHarness();
	await bridge.processMessage(message("m1", "one"), 1);
	await bridge.processMessage(message("m2", "two"), 1);
	assert.equal(fakePi.sent.length, 1);
	assert.match(fakePi.sent[0]!.content, /one/);

	ctx.isIdle = () => false;
	ctx.signal = new AbortController().signal;
	bridge.onAgentStart();
	assert.equal(fakePi.sent.length, 2);
	assert.match(fakePi.sent[1]!.content, /two/);
	assert.deepEqual(fakePi.sent[1]!.options, { deliverAs: "steer" });
	bridge.onAgentSettled();
});

test("rejects busy input when queueWhenBusy is false", async () => {
	const { bridge, fakePi, config, sent, ctx } = createHarness();
	config.queueWhenBusy = false;
	ctx.isIdle = () => false;
	ctx.signal = new AbortController().signal;
	await bridge.processMessage(message("m1", "drop me"), 1);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(fakePi.sent.length, 0);
	assert.match(sent.at(-1) ?? "", /were not delivered/);
});

test("holds input while Pi is compacting instead of losing it", async () => {
	const { bridge, fakePi, ctx } = createHarness();
	ctx.isIdle = () => false;
	ctx.signal = undefined; // compaction: busy but not streaming
	await bridge.processMessage(message("m1", "during compaction"), 1);
	assert.equal(fakePi.sent.length, 0);

	// Compaction finished and the next run starts.
	ctx.isIdle = () => false;
	ctx.signal = new AbortController().signal;
	bridge.onAgentStart();
	assert.equal(fakePi.sent.length, 1);
	assert.match(fakePi.sent[0]!.content, /during compaction/);
	bridge.onAgentSettled();
});

test("builds a stable session thread name", () => {
	const { bridge, ctx, config } = createHarness();
	assert.equal(bridge.buildThreadName(ctx, config), "api [session1]");
	config.threadName = "custom-name";
	assert.equal(bridge.buildThreadName(ctx, config), "custom-name [session1]");

	config.threadName = undefined;
	const longName = bridge.buildThreadName(
		{ ...ctx, sessionManager: { ...ctx.sessionManager, getSessionName: () => "x".repeat(200) } },
		config,
	);
	assert.ok(longName.length <= 100);
	assert.match(longName, /\[session1\]$/);
});

test("ignores messages in the parent channel when a thread is bound", async () => {
	const { bridge, fakePi } = createHarness();
	const parentMessage = message("m1", "parent channel message");
	parentMessage.channel_id = "parent-1";
	await bridge.processMessage(parentMessage, 1);
	assert.equal(fakePi.sent.length, 0);
});

test("ignores unauthorized users", async () => {
	const { bridge, fakePi } = createHarness();
	await bridge.processMessage(message("m1", "nope", "user-2"), 1);
	assert.equal(fakePi.sent.length, 0);
});

test("resolves discord_ask with the next allowed message", async () => {
	const { bridge, sent } = createHarness();
	const first = bridge.ask("Proceed with deployment?");
	await new Promise((resolve) => setTimeout(resolve, 0));

	assert.equal(sent.length, 1);
	assert.match(sent[0]!, /Proceed with deployment/);
	await assert.rejects(bridge.ask("Another question?"), /already waiting/);

	await bridge.processMessage(message("answer-1", "yes, proceed"), 1);
	const answer = await first;
	assert.equal(answer.text, "yes, proceed");
	assert.deepEqual(answer.questionMessageIds, ["question-1"]);
});

test("rejects old-generation messages after a restart", async () => {
	const { bridge, fakePi } = createHarness();
	bridge.generation = 2;
	await bridge.processMessage(message("m1", "stale"), 1);
	assert.equal(fakePi.sent.length, 0);
});

test("deletes the current thread and disconnects", async () => {
	const { bridge, config, ctx } = createHarness();
	const dir = mkdtempSync(join(tmpdir(), "pi-discord-delete-"));
	config.configPath = join(dir, "discord-bridge.json");
	const deleted: string[] = [];
	let gatewayStopped = false;

	bridge.rest = {
		deleteChannel: async (id: string) => {
			deleted.push(id);
		},
	};
	bridge.gateway = {
		isConnected: true,
		currentState: "connected",
		stop: () => {
			gatewayStopped = true;
		},
	};

	await bridge.deleteCurrentThread(ctx);

	assert.deepEqual(deleted, ["thread-1"]);
	assert.equal(gatewayStopped, true);
	assert.equal(bridge.active, false);
	assert.equal(bridge.thread, undefined);
	assert.equal(bridge.targetChannelId, undefined);
	assert.equal(bridge.config.enabled, false);

	const saved = JSON.parse(readFileSync(config.configPath, "utf8")) as {
		discord: { enabled: boolean; mode: string };
	};
	assert.equal(saved.discord.enabled, false);
	assert.equal(saved.discord.mode, "thread");
});

test("runs /discord-bridge status from Discord and replies with status text", async () => {
	const { bridge, fakePi, sent } = createHarness();
	await bridge.processMessage(message("m1", "/discord-bridge status"), 1);
	assert.equal(fakePi.sent.length, 0);
	assert.match(sent.at(-1) ?? "", /Discord bridge:/);
	assert.match(sent.at(-1) ?? "", /steer queue/);
});

test("refuses /discord-bridge delete from Discord", async () => {
	const { bridge, sent } = createHarness();
	const deleted: string[] = [];
	bridge.rest = {
		deleteChannel: async (id: string) => {
			deleted.push(id);
		},
	};
	await bridge.processMessage(message("m1", "/discord-bridge delete"), 1);
	assert.deepEqual(deleted, []);
	assert.equal(bridge.active, true);
	assert.match(sent.at(-1) ?? "", /local Pi terminal/);
});

test("handles built-in session commands from Discord", async () => {
	const { bridge, fakePi, sent, ctx, compactCalls, aborts } = createHarness();

	await bridge.processMessage(message("m1", "/session"), 1);
	assert.match(sent.at(-1) ?? "", /Pi session/);
	assert.match(sent.at(-1) ?? "", /test-provider\/model-1/);
	assert.match(sent.at(-1) ?? "", /Context: 1,234/);

	await bridge.processMessage(message("m2", "/name deploy window"), 1);
	assert.equal(fakePi.sessionName, "deploy window");
	assert.match(sent.at(-1) ?? "", /Session name changed/);

	await bridge.processMessage(message("m3", "/thinking high"), 1);
	assert.equal(fakePi.thinkingLevel, "high");
	assert.match(sent.at(-1) ?? "", /Thinking level set to/);

	await bridge.processMessage(message("m4", "/compact tighten tests"), 1);
	assert.equal(compactCalls.length, 1);
	assert.equal(compactCalls[0]!.customInstructions, "tighten tests");
	assert.match(sent.at(-1) ?? "", /compaction started/);

	await bridge.processMessage(message("m5", "/stop"), 1);
	assert.equal(aborts.length, 1);
	assert.match(sent.at(-1) ?? "", /Requested abort/);

	ctx.isIdle = () => true;
});

test("handles /model lookups and changes from Discord", async () => {
	const { bridge, fakePi, sent } = createHarness();

	await bridge.processMessage(message("m1", "/model"), 1);
	assert.match(sent.at(-1) ?? "", /Current model/);
	assert.match(sent.at(-1) ?? "", /test-provider\/model-1/);

	await bridge.processMessage(message("m2", "/model test-provider/model-1"), 1);
	assert.deepEqual(fakePi.selectedModel, {
		provider: "test-provider",
		id: "model-1",
		name: "Model One",
	});
	assert.match(sent.at(-1) ?? "", /Model changed to/);

	await bridge.processMessage(message("m3", "/model model-2"), 1);
	assert.match(sent.at(-1) ?? "", /Multiple model matches/);

	await bridge.processMessage(message("m4", "/model does-not-exist"), 1);
	assert.match(sent.at(-1) ?? "", /Model not found/);
});

test("refuses unsupported built-ins and unknown commands", async () => {
	const { bridge, fakePi, sent } = createHarness();

	await bridge.processMessage(message("m1", "/new"), 1);
	assert.equal(fakePi.sent.length, 0);
	assert.match(sent.at(-1) ?? "", /not supported from Discord/);

	await bridge.processMessage(message("m2", "/definitely-not-a-command"), 1);
	assert.equal(fakePi.sent.length, 0);
	assert.match(sent.at(-1) ?? "", /Unknown command/);
});

test("forwards extension commands with template expansion", async () => {
	const { bridge, fakePi, sent } = createHarness();
	fakePi.commands = [{ name: "custom", description: "Custom command" }];

	await bridge.processMessage(message("m1", "/custom do it"), 1);
	assert.equal(fakePi.sent.length, 1);
	assert.equal(fakePi.sent[0]!.content, "/custom do it");
	assert.deepEqual(fakePi.sent[0]!.options, {
		expandPromptTemplates: true,
		deliverAs: "steer",
	});
	assert.match(sent.at(-1) ?? "", /Ran/);
});

test("prefers commands over discord_ask answers", async () => {
	const { bridge, sent } = createHarness();
	const answer = bridge.ask("Which branch?");
	await new Promise((resolve) => setTimeout(resolve, 0));

	await bridge.processMessage(message("m1", "/session"), 1);
	assert.match(sent.at(-1) ?? "", /Pi session/);

	await bridge.processMessage(message("m2", "main"), 1);
	assert.equal((await answer).text, "main");
});

test("treats path-like text as a normal message", async () => {
	const { bridge, fakePi } = createHarness();
	await bridge.processMessage(message("m1", "/tmp/file is broken"), 1);
	assert.equal(fakePi.sent.length, 1);
	assert.match(fakePi.sent[0]!.content, /^\[Discord:remote-user\] \/tmp\/file/);
	bridge.onAgentStart();
});
