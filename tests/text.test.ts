import assert from "node:assert/strict";
import test from "node:test";
import { splitDiscordMessage, summarizeText } from "../src/text.ts";

test("returns an empty list for empty content", () => {
	assert.deepEqual(splitDiscordMessage(""), []);
});

test("keeps short messages unchanged", () => {
	assert.deepEqual(splitDiscordMessage("hello"), ["hello"]);
});

test("splits long messages below the Discord limit", () => {
	const chunks = splitDiscordMessage("a".repeat(5_000));
	assert.ok(chunks.length > 1);
	for (const chunk of chunks) assert.ok(chunk.length <= 1_900, String(chunk.length));
	assert.equal(chunks.join(""), "a".repeat(5_000));
});

test("closes and reopens fenced code blocks", () => {
	const content = `intro\n\`\`\`js\n${"const value = 1;\n".repeat(300)}\`\`\`\noutro`;
	const chunks = splitDiscordMessage(content);
	assert.ok(chunks.length > 1);
	for (const chunk of chunks) {
		const fences = (chunk.match(/^```/gm) ?? []).length;
		assert.equal(fences % 2, 0, chunk.slice(0, 80));
	}
});

test("summarizes long text on one line", () => {
	assert.equal(summarizeText("a\nb   c", 10), "a b c");
	assert.ok(summarizeText("x".repeat(100), 10).length <= 10);
});
