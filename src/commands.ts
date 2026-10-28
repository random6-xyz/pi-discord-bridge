/**
 * Slash command parsing and Discord-facing command metadata.
 *
 * Pi handles built-in slash commands in its interactive UI, so `pi.sendUserMessage()`
 * cannot dispatch them. The bridge implements a small, safe subset itself and clearly
 * refuses the commands that need the local terminal.
 */

export interface ParsedSlashCommand {
	/** Lowercased command name without the leading slash. */
	name: string;
	/** Everything after the command name, trimmed. May be empty. */
	args: string;
	/** Original text including the leading slash, used when forwarding. */
	raw: string;
}

export type SlashCommandKind =
	| "bridge"
	| "builtin"
	| "unsupported"
	| "extension";

/** Commands registered by this extension itself. */
export const BRIDGE_COMMANDS: readonly string[] = ["discord-bridge"];

/** Pi built-ins the bridge can emulate from Discord. */
export const SUPPORTED_BUILTINS: readonly string[] = [
	"help",
	"session",
	"name",
	"compact",
	"model",
	"thinking",
	"stop",
	"abort",
];

/** Pi built-ins that require the interactive terminal. */
export const UNSUPPORTED_BUILTINS: readonly string[] = [
	"settings",
	"tree",
	"scoped-models",
	"export",
	"import",
	"share",
	"bug",
	"copy",
	"changelog",
	"hotkeys",
	"fork",
	"clone",
	"trust",
	"login",
	"logout",
	"new",
	"resume",
	"reload",
	"quit",
];

export const THINKING_LEVELS: readonly string[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

const COMMAND_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9:_-]*$/;
const MAX_EXTENSION_COMMANDS = 30;

/**
 * Parse a Discord message that looks like a slash command.
 *
 * Returns `undefined` for plain text, a bare `/`, or path-like text such as
 * `/tmp/file is broken`, so only real commands are routed away from the model.
 */
export function parseSlashCommand(text: string): ParsedSlashCommand | undefined {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/") || trimmed.length < 2) return undefined;

	const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed.slice(1));
	if (!match) return undefined;

	const name = match[1]!;
	if (!COMMAND_NAME_PATTERN.test(name)) return undefined;

	return {
		name: name.toLowerCase(),
		args: (match[2] ?? "").trim(),
		raw: trimmed,
	};
}

/** First whitespace-delimited token of the arguments, lowercased. */
export function subcommandOf(args: string): string {
	return args.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
}

export function isBridgeCommand(name: string): boolean {
	return BRIDGE_COMMANDS.includes(name);
}

export function isSupportedBuiltin(name: string): boolean {
	return SUPPORTED_BUILTINS.includes(name);
}

export function isUnsupportedBuiltin(name: string): boolean {
	return UNSUPPORTED_BUILTINS.includes(name);
}

export function unsupportedCommandText(name: string): string {
	return (
		`❌ \`/${name}\` is not supported from Discord.\n` +
		"Run it in the local terminal where Pi is running."
	);
}

export function unknownCommandText(name: string): string {
	return (
		`❓ Unknown command: \`/${name}\`\n` +
		"Run `/help` to list available commands."
	);
}

export interface CommandHelpOptions {
	/** Names reported by `pi.getCommands()` (extensions, prompt templates, skills). */
	extensionCommands?: readonly string[];
	maxExtensionCommands?: number;
}

export function formatCommandHelp(options: CommandHelpOptions = {}): string {
	const limit = options.maxExtensionCommands ?? MAX_EXTENSION_COMMANDS;
	const reserved = new Set([
		...BRIDGE_COMMANDS,
		...SUPPORTED_BUILTINS,
		...UNSUPPORTED_BUILTINS,
	]);
	const extensionCommands = [
		...new Set(
			(options.extensionCommands ?? [])
				.map((name) => name.trim())
				.filter((name) => name.length > 0 && !reserved.has(name.toLowerCase())),
		),
	];
	const shown = extensionCommands.slice(0, limit);
	const hidden = extensionCommands.length - shown.length;

	const lines = [
		"🧭 **Discord slash commands**",
		"",
		"Bridge",
		"  `/discord-bridge status|on|off|reconnect|test|send`",
		"  `/help` This list",
		"",
		"Session control",
		"  `/session` Current session info",
		"  `/name <name>` Rename the session",
		"  `/compact [instructions]` Compact context (aborts in-flight work)",
		"  `/model [provider/id]` Show or change the model",
		`  \`/thinking [level]\` Show or change the thinking level (${THINKING_LEVELS.join(", ")})`,
		"  `/stop`, `/abort` Abort the current work",
	];

	if (shown.length > 0) {
		lines.push("", "Extensions / skills / templates");
		for (const name of shown) lines.push(`  \`/${name}\``);
		if (hidden > 0) lines.push(`  …and ${hidden} more`);
	}

	lines.push(
		"",
		`Not available from Discord (run locally): ${UNSUPPORTED_BUILTINS.map((name) => `\`/${name}\``).join(", ")}`,
		"Regular messages are forwarded to Pi with a `[Discord:user]` prefix.",
	);

	return lines.join("\n");
}
