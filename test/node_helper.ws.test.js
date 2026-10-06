"use strict";

// WebSocket lifecycle of node_helper against a fake Home Assistant server:
// handshake, snapshot, live events, reconnect backoff, heartbeat, terminal
// auth failure, single connection across repeated config, and cleanup.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const { TOKEN, DOOR, DELIVERIES, makeHelper, doorState, deliveriesState, startFakeHa, waitFor } = require("./support/ha-fake");

/**
 * @returns {Promise<number>} A TCP port that nothing is listening on.
 */
function freePort () {
	return new Promise((resolve) => {
		const s = net.createServer();
		s.listen(0, "127.0.0.1", () => {
			const { port } = s.address();
			s.close(() => resolve(port));
		});
	});
}

test("connects, authenticates, snapshots, subscribes, and relays live changes", async () => {
	const srv = await startFakeHa({ states: [doorState({ since: "s1" }), deliveriesState()] });
	const ctx = makeHelper();
	try {
		ctx.configure({ haUrl: srv.url });
		await waitFor(() => ctx.last() && ctx.last().connected && ctx.last().door?.state === "present");
		assert.deepEqual(srv.authTokens, [TOKEN]);
		const types = srv.received.map((m) => m.type);
		assert.deepEqual(types.slice(0, 3), ["auth", "get_states", "subscribe_events"]);
		assert.equal(srv.received.find((m) => m.type === "subscribe_events").event_type, "state_changed");
		assert.equal(ctx.last().arriving.length, 1);
		assert.equal(ctx.last().error, null);

		srv.push(doorState({ since: "s2" }, null));
		srv.push({ entity_id: "light.noise", state: "on", attributes: {} });
		srv.push({ ...doorState({ since: "s3" }), state: "clear" });
		await waitFor(() => ctx.last().door.state === "clear");
		assert.equal(ctx.last().door.since, "s3");
		assert.ok(!JSON.stringify(ctx.sent).includes(TOKEN));
	} finally {
		ctx.stop();
		await srv.close();
	}
});

test("repeated config and a browser reload keep a single connection", async () => {
	const srv = await startFakeHa({ states: [doorState(), deliveriesState()] });
	const ctx = makeHelper();
	try {
		ctx.configure({ haUrl: srv.url });
		ctx.configure({ haUrl: srv.url });
		// connected is set at auth_ok, before the get_states snapshot fills in the door
		await waitFor(() => ctx.last() && ctx.last().connected && ctx.last().door?.state === "present");
		ctx.clear();
		ctx.configure({ haUrl: srv.url });
		assert.equal(ctx.last().connected, true);
		assert.equal(ctx.last().door.state, "present");
		await new Promise((r) => setTimeout(r, 100));
		assert.equal(srv.connections, 1);
	} finally {
		ctx.stop();
		await srv.close();
	}
});

test("a wrong token is terminal: auth error, no reconnect attempts", async () => {
	const srv = await startFakeHa({ acceptToken: "other-token" });
	const ctx = makeHelper();
	try {
		ctx.configure({ haUrl: srv.url, reconnectInterval: 20 });
		await waitFor(() => ctx.last() && ctx.last().error && ctx.last().error.kind === "auth");
		assert.equal(ctx.last().error.terminal, true);
		await new Promise((r) => setTimeout(r, 250));
		assert.equal(srv.connections, 1);
		assert.equal(ctx.helper.ha.reconnectTimer, null);
		assert.ok(!JSON.stringify(ctx.sent).includes(TOKEN));
	} finally {
		ctx.stop();
		await srv.close();
	}
});

test("reconnects with backoff after the server drops, then recovers", async () => {
	const srv = await startFakeHa({ states: [doorState(), deliveriesState()] });
	const ctx = makeHelper();
	try {
		ctx.configure({ haUrl: srv.url, reconnectInterval: 20 });
		await waitFor(() => ctx.last() && ctx.last().connected);
		srv.dropAll();
		await waitFor(() => ctx.last().connected === false);
		await waitFor(() => srv.connections === 2 && ctx.last().connected);
		assert.equal(ctx.last().door.state, "present");
		assert.equal(ctx.helper.ha.failures, 0);
	} finally {
		ctx.stop();
		await srv.close();
	}
});

test("an unreachable HA is reported as a non-terminal connection error after repeated failures", async () => {
	const port = await freePort();
	const ctx = makeHelper();
	try {
		ctx.configure({ haUrl: `http://127.0.0.1:${port}`, reconnectInterval: 5 });
		await waitFor(() => ctx.last() && ctx.last().error && ctx.last().error.kind === "connection", 8000);
		assert.equal(ctx.last().error.terminal, false);
		assert.equal(ctx.last().connected, false);
		assert.ok(ctx.helper.ha.failures >= 3);
		// backoff: delay grows with failures and is capped
		ctx.helper.ha.cfg.reconnectInterval = 5000;
		ctx.helper.ha.failures = 10;
		clearTimeout(ctx.helper.ha.reconnectTimer);
		ctx.helper.ha.reconnectTimer = null;
		ctx.helper._scheduleReconnect();
		assert.ok(ctx.helper.ha.reconnectTimer);
	} finally {
		ctx.stop();
	}
});

test("the connection error clears after HA comes back", async () => {
	const port = await freePort();
	const ctx = makeHelper();
	let srv;
	try {
		ctx.configure({ haUrl: `http://127.0.0.1:${port}`, reconnectInterval: 5 });
		await waitFor(() => ctx.last() && ctx.last().error && ctx.last().error.kind === "connection", 8000);
		srv = await new Promise((resolve) => {
			// bring a fake HA up on the same port
			const { WebSocketServer } = require("ws");
			const wss = new WebSocketServer({ port, host: "127.0.0.1" });
			wss.on("connection", (ws) => {
				ws.send(JSON.stringify({ type: "auth_required" }));
				ws.on("message", (d) => {
					const m = JSON.parse(d.toString());
					if (m.type === "auth") ws.send(JSON.stringify({ type: "auth_ok" }));
					if (m.type === "get_states") ws.send(JSON.stringify({ id: m.id, type: "result", success: true, result: [doorState(), deliveriesState()] }));
				});
			});
			wss.on("listening", () => resolve(wss));
		});
		await waitFor(() => ctx.last().connected && ctx.last().error === null, 8000);
	} finally {
		ctx.stop();
		if (srv) {
			for (const c of srv.clients) c.terminate();
			await new Promise((r) => srv.close(() => r()));
		}
	}
});

test("heartbeat pings HA, and a missing pong forces a reconnect", async () => {
	const srv = await startFakeHa({ states: [doorState(), deliveriesState()], respondPing: false });
	const ctx = makeHelper();
	try {
		ctx.configure({ haUrl: srv.url, heartbeatInterval: 30, reconnectInterval: 20 });
		await waitFor(() => ctx.last() && ctx.last().connected);
		await waitFor(() => srv.received.some((m) => m.type === "ping"));
		await waitFor(() => srv.connections >= 2, 5000);
	} finally {
		ctx.stop();
		await srv.close();
	}
});

test("heartbeat with a responsive server keeps one connection", async () => {
	const srv = await startFakeHa({ states: [doorState(), deliveriesState()] });
	const ctx = makeHelper();
	try {
		ctx.configure({ haUrl: srv.url, heartbeatInterval: 30 });
		await waitFor(() => srv.received.filter((m) => m.type === "ping").length >= 3);
		assert.equal(srv.connections, 1);
	} finally {
		ctx.stop();
		await srv.close();
	}
});

test("missing HA entities over a real socket: connected with a non-terminal entities error", async () => {
	const srv = await startFakeHa({ states: [{ entity_id: "light.x", state: "on", attributes: {} }] });
	const ctx = makeHelper();
	try {
		ctx.configure({ haUrl: srv.url });
		await waitFor(() => ctx.last() && ctx.last().connected && ctx.last().error);
		assert.equal(ctx.last().error.kind, "entities");
		assert.equal(ctx.last().error.terminal, false);
		// The package gets installed later and the entities appear.
		srv.push(doorState());
		srv.push(deliveriesState());
		await waitFor(() => ctx.last().error === null);
		assert.equal(ctx.last().door.state, "present");
		assert.equal(DOOR.length > 0 && DELIVERIES.length > 0, true);
	} finally {
		ctx.stop();
		await srv.close();
	}
});

test("stop() cleans up: socket closed, timers cleared, no reconnect afterwards", async () => {
	const srv = await startFakeHa({ states: [doorState(), deliveriesState()] });
	const ctx = makeHelper();
	try {
		ctx.configure({ haUrl: srv.url, reconnectInterval: 10, heartbeatInterval: 20 });
		await waitFor(() => ctx.last() && ctx.last().connected);
		ctx.stop();
		const ha = ctx.helper.ha;
		assert.equal(ha.ws, null);
		assert.equal(ha.heartbeatTimer, null);
		assert.equal(ha.reconnectTimer, null);
		assert.equal(ha.started, false);
		await waitFor(() => srv.clients.size === 0);
		await new Promise((r) => setTimeout(r, 150));
		assert.equal(srv.connections, 1);
	} finally {
		ctx.stop();
		await srv.close();
	}
});

test("a changed config replaces the connection rather than adding one", async () => {
	const srv = await startFakeHa({ states: [doorState(), deliveriesState()] });
	const ctx = makeHelper();
	try {
		ctx.configure({ haUrl: srv.url });
		await waitFor(() => ctx.last() && ctx.last().connected);
		ctx.configure({ haUrl: srv.url, doorEntity: "sensor.something_else" });
		await waitFor(() => srv.connections === 2);
		await waitFor(() => srv.clients.size === 1);
		await waitFor(() => ctx.last().error && ctx.last().error.kind === "entities");
	} finally {
		ctx.stop();
		await srv.close();
	}
});
