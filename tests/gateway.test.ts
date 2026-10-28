import assert from "node:assert/strict";
import test from "node:test";
import {
	DiscordGateway,
	GATEWAY_INTENTS,
	type GatewayWebSocket,
} from "../src/gateway.ts";

class FakeSocket implements GatewayWebSocket {
	static instances: FakeSocket[] = [];

	readyState = 1;
	sent: Array<Record<string, any>> = [];
	closed = false;
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onerror: ((event: unknown) => void) | null = null;
	onclose: ((event: { code: number; reason: string }) => void) | null = null;
	readonly url: string;

	constructor(url: string) {
		this.url = url;
		FakeSocket.instances.push(this);
	}

	send(data: string): void {
		this.sent.push(JSON.parse(data) as Record<string, any>);
	}

	close(): void {
		this.closed = true;
		this.readyState = 3;
	}

	emit(payload: unknown): void {
		this.onmessage?.({ data: JSON.stringify(payload) });
	}
}

function createGateway(calls: {
	events: Array<{ event: string; data: unknown }>;
	states: string[];
	errors: Array<{ message: string; fatal: boolean }>;
}) {
	return new DiscordGateway({
		token: "test-token",
		WebSocketImpl: FakeSocket,
		onDispatch: (event, data) => calls.events.push({ event, data }),
		onState: (state) => calls.states.push(state),
		onError: (error, fatal) =>
			calls.errors.push({ message: error.message, fatal }),
	});
}

test("identifies, receives READY, and dispatches messages", () => {
	FakeSocket.instances = [];
	const calls = { events: [] as any[], states: [] as string[], errors: [] as any[] };
	const gateway = createGateway(calls);
	gateway.start();

	const socket = FakeSocket.instances[0];
	assert.ok(socket);
	assert.match(socket.url, /v=10/);
	assert.match(socket.url, /encoding=json/);

	socket.emit({ op: 10, d: { heartbeat_interval: 60_000 } });
	const identify = socket.sent.find((payload) => payload.op === 2);
	assert.ok(identify);
	assert.equal(identify.d.token, "test-token");
	assert.equal(identify.d.intents, GATEWAY_INTENTS);
	assert.ok((identify.d.intents & (1 << 15)) !== 0);

	socket.emit({
		op: 0,
		s: 1,
		t: "READY",
		d: {
			session_id: "session-1",
			resume_gateway_url: "wss://resume.example",
			user: { id: "bot-id", username: "pi", bot: true },
		},
	});
	assert.equal(gateway.currentState, "connected");
	assert.equal(gateway.botUser?.id, "bot-id");
	assert.equal(gateway.currentSessionId, "session-1");

	socket.emit({
		op: 0,
		s: 2,
		t: "MESSAGE_CREATE",
		d: {
			id: "message-1",
			channel_id: "channel-1",
			content: "hello",
			author: { id: "user-1", username: "user" },
		},
	});
	assert.equal(calls.events.at(-1)?.event, "MESSAGE_CREATE");
	assert.ok(calls.states.includes("connected"));

	gateway.stop();
	assert.equal(gateway.currentState, "stopped");
	assert.equal(socket.closed, true);
});

test("treats authentication failures as fatal", () => {
	FakeSocket.instances = [];
	const calls = { events: [] as any[], states: [] as string[], errors: [] as any[] };
	const gateway = createGateway(calls);
	gateway.start();

	const socket = FakeSocket.instances[0]!;
	socket.emit({ op: 10, d: { heartbeat_interval: 60_000 } });
	socket.onclose?.({ code: 4004, reason: "Authentication failed" });

	assert.equal(gateway.currentState, "error");
	assert.equal(calls.errors.at(-1)?.fatal, true);
	assert.match(calls.errors.at(-1)?.message ?? "", /4004/);
	gateway.stop();
});
