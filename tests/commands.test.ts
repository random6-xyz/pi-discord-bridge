import assert from "node:assert/strict";
import test from "node:test";
import {
	formatCommandHelp,
	parseSlashCommand,
	SUPPORTED_BUILTINS,
	UNSUPPORTED_BUILTINS,
} from "../src/commands.ts";

test("parses a slash command with arguments", () => {
	assert.deepEqual(parseSlashCommand("/name deploy window"), {
		name: "name",
		args: "deploy window",
		raw: "/name deploy window",
	});
});

test("parses a bare command", () => {
	assert.deepEqual(parseSlashCommand("/help"), {
		name: "help",
		args: "",
		raw: "/help",
	});
});

test("normalizes the command name", () => {
	const parsed = parseSlashCommand("/Model gpt");
	assert.equal(parsed?.name, "model");
	assert.equal(parsed?.args, "gpt");
});

test("keeps multi-line arguments", () => {
	const parsed = parseSlashCommand("/compact\nline one\nline two");
	assert.equal(parsed?.name, "compact");
	assert.equal(parsed?.args, "line one\nline two");
});

test("parses namespaced skill commands", () => {
	const parsed = parseSlashCommand("/skill:ctx-index now");
	assert.equal(parsed?.name, "skill:ctx-index");
	assert.equal(parsed?.args, "now");
});

test("does not treat plain text, bare slash, or paths as commands", () => {
	assert.equal(parseSlashCommand("hello world"), undefined);
	assert.equal(parseSlashCommand("/"), undefined);
	assert.equal(parseSlashCommand("/ tmp/file"), undefined);
	assert.equal(parseSlashCommand("/tmp/file is broken"), undefined);
	assert.equal(parseSlashCommand("  "), undefined);
});

test("formatCommandHelp lists supported and unsupported commands", () => {
	const help = formatCommandHelp({
		extensionCommands: ["custom", "discord-bridge", "help", "skill:ctx-index"],
	});

	for (const name of SUPPORTED_BUILTINS) {
		assert.match(help, new RegExp(`/${name}`), name);
	}
	assert.match(help, /Not available from Discord/);
	assert.match(help, /`\/new`/);
	assert.match(help, /`\/custom`/);
	assert.match(help, /`\/skill:ctx-index`/);
	// Bridge/subcommand names are not listed twice as extension commands.
	assert.equal(help.match(/`\/discord-bridge status/g)?.length, 1);
	assert.equal(help.match(/`\/help`/g)?.length, 1);
});

test("unsupported built-ins stay out of the supported list", () => {
	for (const name of UNSUPPORTED_BUILTINS) {
		assert.equal(SUPPORTED_BUILTINS.includes(name), false, name);
	}
});
