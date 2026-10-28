import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface LockFile {
	pid: number;
	token: string;
	acquiredAt: number;
	key: string;
}

export interface BridgeLock {
	readonly path: string;
	release(): void;
}

export class BridgeLockedError extends Error {
	readonly ownerPid: number;
	readonly lockPath: string;

	constructor(ownerPid: number, lockPath: string) {
		super(
			`Another Pi process is already using the Discord bridge (PID ${ownerPid}). ` +
				`Two Pi processes cannot connect to the same session/channel at once.`,
		);
		this.name = "BridgeLockedError";
		this.ownerPid = ownerPid;
		this.lockPath = lockPath;
	}
}

function readLock(path: string): LockFile | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!parsed || typeof parsed !== "object") return undefined;
		const record = parsed as Record<string, unknown>;
		if (
			typeof record.pid !== "number" ||
			typeof record.token !== "string" ||
			typeof record.acquiredAt !== "number" ||
			typeof record.key !== "string"
		) {
			return undefined;
		}
		return {
			pid: record.pid,
			token: record.token,
			acquiredAt: record.acquiredAt,
			key: record.key,
		};
	} catch {
		return undefined;
	}
}

function processIsAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (
			error instanceof Error &&
			"code" in error &&
			(error as NodeJS.ErrnoException).code === "EPERM"
		);
	}
}

function isStale(lock: LockFile): boolean {
	return !processIsAlive(lock.pid);
}

function createLockFile(path: string, data: LockFile): boolean {
	let fileDescriptor: number;
	try {
		fileDescriptor = openSync(path, "wx", 0o600);
	} catch (error) {
		if (
			error instanceof Error &&
			"code" in error &&
			(error as NodeJS.ErrnoException).code === "EEXIST"
		) {
			return false;
		}
		throw error;
	}

	try {
		writeFileSync(fileDescriptor, `${JSON.stringify(data)}\n`, {
			encoding: "utf8",
		});
	} catch (error) {
		try {
			closeSync(fileDescriptor);
		} catch {
			// Ignore close errors while cleaning up a failed lock write.
		}
		try {
			unlinkSync(path);
		} catch {
			// The lock may already be gone.
		}
		throw error;
	}

	closeSync(fileDescriptor);
	return true;
}

export function acquireBridgeLock(
	lockKey: string,
	botToken: string,
	lockDir = tmpdir(),
): BridgeLock {
	const key = createHash("sha256")
		.update(`${botToken}\u0000${lockKey}`)
		.digest("hex")
		.slice(0, 16);
	const path = join(lockDir, `pi-discord-bridge-${key}.lock`);
	const token = randomUUID();
	const data: LockFile = {
		pid: process.pid,
		token,
		acquiredAt: Date.now(),
		key: lockKey,
	};

	const makeLock = (): BridgeLock => {
		let released = false;
		return {
			path,
			release() {
				if (released) return;
				released = true;
				const current = existsSync(path) ? readLock(path) : undefined;
				if (!current || current.token !== token) return;
				try {
					unlinkSync(path);
				} catch {
					// The lock may already have been removed.
				}
			},
		};
	};

	for (let attempt = 0; attempt < 5; attempt += 1) {
		if (!existsSync(path)) {
			if (createLockFile(path, data)) return makeLock();
			continue;
		}

		const existing = readLock(path);
		if (!existing) {
			// A crashed writer left an empty or malformed lock file.
			try {
				unlinkSync(path);
			} catch {
				// Another process may be handling it.
			}
			continue;
		}

		if (existing.pid === process.pid) {
			// A reload in the same process may replace an earlier lock.
			const temporary = `${path}.${process.pid}.tmp`;
			writeFileSync(temporary, `${JSON.stringify(data)}\n`, {
				encoding: "utf8",
				mode: 0o600,
			});
			renameSync(temporary, path);
			return makeLock();
		}

		if (!isStale(existing)) {
			throw new BridgeLockedError(existing.pid, path);
		}

		try {
			unlinkSync(path);
		} catch {
			// Another process may have removed it first.
		}
	}

	throw new Error(`Failed to acquire the Discord bridge lock file: ${path}`);
}
