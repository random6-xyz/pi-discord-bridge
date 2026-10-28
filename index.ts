import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DiscordBridge } from "./src/bridge.ts";

const COMMAND_SUBCOMMANDS = ["status", "on", "off", "reconnect", "delete", "test", "send", "help"];

function toolError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

export default function discordBridgeExtension(pi: ExtensionAPI) {
	const bridge = new DiscordBridge(pi);

	pi.registerTool({
		name: "discord_send",
		label: "Discord Send",
		description:
			"Send an explicit message to the configured Discord channel. " +
			"Use this for requested status reports, completion notices, or decisions the user must see remotely. " +
			"Never use it to mirror routine logs, tool calls, or every assistant response.",
		promptSnippet: "Send an explicit update or report to the user on Discord",
		promptGuidelines: [
			"Use discord_send only when the user asked for a Discord report/notification or a remote update is genuinely useful.",
			"Do not send routine tool output, progress logs, or your final answer to Discord automatically.",
			"Messages prefixed with [Discord:...] came from the remote Discord user; when a reply is expected, answer with discord_send.",
		],
		parameters: Type.Object({
			message: Type.String({
				description:
					"Message text to post. Markdown is supported. Long messages are split at Discord's limit.",
			}),
		}),
		async execute(_toolCallId, params) {
			try {
				const result = await bridge.send(params.message);
				return {
					content: [
						{
							type: "text",
							text:
								`Sent to Discord (${result.count} message(s), id ${result.messageIds.join(", ")}).`,
						},
					],
					details: result,
				};
			} catch (error) {
				throw toolError(error);
			}
		},
	});

	pi.registerTool({
		name: "discord_ask",
		label: "Discord Ask",
		description:
			"Ask the user a question in the configured Discord channel and wait for their reply. " +
			"Use this when you need a decision or missing information before continuing. " +
			"Only one Discord question can be pending at a time.",
		promptSnippet: "Ask the user a question on Discord and wait for the answer",
		promptGuidelines: [
			"Use discord_ask when work cannot continue without a user decision or missing information.",
			"While discord_ask is waiting, the Discord user's next message becomes the answer; do not also forward that message as a new instruction.",
			"Keep questions concise and state the options when possible.",
		],
		parameters: Type.Object({
			question: Type.String({
				description: "Question text to post to Discord. Markdown is supported.",
			}),
			timeoutMs: Type.Optional(
				Type.Number({
					minimum: 1_000,
					maximum: 24 * 60 * 60 * 1_000,
					description:
						"How long to wait for an answer in milliseconds. Defaults to the bridge configuration (15 minutes).",
				}),
			),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, signal) {
			try {
				const answer = await bridge.ask(params.question, {
					signal,
					timeoutMs: params.timeoutMs,
				});
				return {
					content: [
						{
							type: "text",
							text: `Discord user answer: ${answer.text}`,
						},
					],
					details: answer,
				};
			} catch (error) {
				throw toolError(error);
			}
		},
	});

	pi.registerCommand("discord-bridge", {
		description: "Check, enable/disable, reconnect, and test the Discord bridge",
		getArgumentCompletions: (prefix) => {
			const normalized = prefix.toLowerCase();
			const matches = COMMAND_SUBCOMMANDS.filter((value) =>
				value.startsWith(normalized),
			);
			return matches.length > 0
				? matches.map((value) => ({ value, label: value }))
				: null;
		},
		handler: async (args, ctx) => {
			await bridge.handleCommand(args, ctx);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		bridge.start(ctx);
	});

	pi.on("agent_start", () => {
		bridge.onAgentStart();
	});

	pi.on("agent_settled", () => {
		bridge.onAgentSettled();
	});

	pi.on("session_shutdown", () => {
		bridge.stop();
	});
}
