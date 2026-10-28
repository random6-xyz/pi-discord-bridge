import assert from "node:assert/strict";
import { existsSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireBridgeLock, BridgeLockedError } from "../src/lock.ts";

const CHANNEL = "123456789012345678";
const TOKEN = "test-token";

test("acquires and releases a lock", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-discord-lock-"));
	const lock = acquireBridgeLock(CHANNEL, TOKEN, dir);
	assert.equal(existsSync(lock.path), true);
	lock.release();
	assert.equal(existsSync(lock.path), false);
});

test("rejects a live lock owned by another process", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-discord-lock-"));
	const first = acquireBridgeLock(CHANNEL, TOKEN, dir);
	const path = first.path;
	first.release();
	const lockData = {
		pid: process.ppid,
		token: "other",
		acquiredAt: Date.now(),
		key: CHANNEL,
	};
	writeFileSync(path, JSON.stringify(lockData));
	try {
		assert.throws(
			() => acquireBridgeLock(CHANNEL, TOKEN, dir),
			(error: unknown) => error instanceof BridgeLockedError,
		);
	} finally {
		try {
			unlinkSync(path);
		} catch {
			// Ignore cleanup errors.
		}
	}
});

test("replaces a stale lock", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-discord-lock-"));
	const first = acquireBridgeLock(CHANNEL, TOKEN, dir);
	writeFileSync(
		first.path,
		JSON.stringify({
			pid: 999_999_999,
			token: "stale",
			acquiredAt: Date.now(),
			key: CHANNEL,
		}),
	);
	const second = acquireBridgeLock(CHANNEL, TOKEN, dir);
	assert.equal(existsSync(second.path), true);
	second.release();
});
