"use strict";

// Shared test utilities: a fake Home Assistant WebSocket server and a helper
// factory that records every notification the node_helper sends.

require("./mm-stubs");

const { WebSocketServer } = require("ws");
const NodeHelperClass = require("../../node_helper");

const TOKEN = "SECRET-LONG-LIVED-TOKEN-123";
const DOOR = "sensor.front_door_package";
const DELIVERIES = "sensor.package_deliveries";

/**
 * @param {object} opts Options: config overrides, connect (false stubs the real connection).
 * @returns {object} The helper plus a log of sent notifications.
 */
function makeHelper (opts = {}) {
	const helper = new NodeHelperClass();
	helper.name = "MMM-PackageAlert";
	const sent = [];
	helper.sendSocketNotification = (notification, payload) => {
		sent.push({ notification, payload });
	};
	helper.start();
	let connects = 0;
	if (opts.connect === false) helper._connect = () => { connects += 1; };
	const ctx = {
		helper,
		sent,
		connects: () => connects,
		states: () => sent.filter((n) => n.notification === "PACKAGE_STATE").map((n) => n.payload),
		last: () => ctx.states().at(-1),
		clear: () => { sent.length = 0; },
		configure (cfg = {}) {
			helper.socketNotificationReceived("PACKAGE_CONFIG", { haUrl: "http://ha.example.test:8123/", haToken: TOKEN, ...opts.config, ...cfg });
		},
		send (obj) {
			helper._handleMessage(JSON.stringify(obj));
		},
		stop () {
			helper.stop();
		}
	};
	return ctx;
}

/**
 * @param {object} extra Attribute overrides.
 * @returns {object} A door entity state.
 */
function doorState (extra = {}) {
	return {
		entity_id: DOOR,
		state: "present",
		attributes: { since: "2026-10-01T10:00:00-04:00", source: "camera", description: "Brown box", carrier: null, last_check: "2026-10-01T10:00:05-04:00", last_check_result: "package", checks_today: 3, ...extra }
	};
}

/**
 * @param {object} attrs Attribute overrides.
 * @param {string} state The sensor state.
 * @returns {object} A deliveries entity state.
 */
function deliveriesState (attrs = {}, state = "1") {
	return {
		entity_id: DELIVERIES,
		state,
		attributes: {
			out_for_delivery: [{ carrier: "ups", tracking: "1Z999AA10123456784", subject: "Out for delivery", received: "2026-10-01T08:00:00-04:00" }],
			delivered: [],
			...attrs
		}
	};
}

/**
 * Start a fake HA WebSocket server that speaks the auth handshake.
 * @param {object} opts Options: states (get_states result), acceptToken, respondPing.
 * @returns {Promise<object>} Server controls.
 */
function startFakeHa (opts = {}) {
	return new Promise((resolve) => {
		const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
		const srv = {
			wss,
			states: opts.states || [],
			acceptToken: opts.acceptToken || TOKEN,
			respondPing: opts.respondPing !== false,
			clients: new Set(),
			connections: 0,
			received: [],
			authTokens: [],
			get url () { return `http://127.0.0.1:${wss.address().port}`; },
			push (state, old = null) {
				for (const c of srv.clients) {
					c.send(JSON.stringify({ id: 2, type: "event", event: { event_type: "state_changed", data: { entity_id: state.entity_id, new_state: state, old_state: old } } }));
				}
			},
			dropAll () {
				for (const c of srv.clients) c.terminate();
			},
			close () {
				for (const c of srv.clients) c.terminate();
				return new Promise((r) => wss.close(() => r()));
			}
		};
		wss.on("connection", (ws) => {
			srv.connections += 1;
			srv.clients.add(ws);
			ws.on("close", () => srv.clients.delete(ws));
			ws.send(JSON.stringify({ type: "auth_required", ha_version: "2026.9.3" }));
			ws.on("message", (data) => {
				const m = JSON.parse(data.toString());
				srv.received.push(m);
				if (m.type === "auth") {
					srv.authTokens.push(m.access_token);
					if (m.access_token === srv.acceptToken) {
						ws.send(JSON.stringify({ type: "auth_ok", ha_version: "2026.9.3" }));
					} else {
						ws.send(JSON.stringify({ type: "auth_invalid", message: "Invalid access token" }));
						ws.close();
					}
				} else if (m.type === "get_states") {
					ws.send(JSON.stringify({ id: m.id, type: "result", success: true, result: srv.states }));
				} else if (m.type === "subscribe_events") {
					ws.send(JSON.stringify({ id: m.id, type: "result", success: true, result: null }));
				} else if (m.type === "ping" && srv.respondPing) {
					ws.send(JSON.stringify({ id: m.id, type: "pong" }));
				}
			});
		});
		wss.on("listening", () => resolve(srv));
	});
}

/**
 * Poll until a condition holds.
 * @param {Function} fn Returns truthy when satisfied.
 * @param {number} timeout Max wait in ms.
 * @returns {Promise<void>} Resolves when satisfied; rejects on timeout.
 */
async function waitFor (fn, timeout = 5000) {
	const start = Date.now();
	while (!fn()) {
		if (Date.now() - start > timeout) throw new Error(`waitFor timed out: ${fn}`);
		await new Promise((r) => setTimeout(r, 10));
	}
}

module.exports = { TOKEN, DOOR, DELIVERIES, makeHelper, doorState, deliveriesState, startFakeHa, waitFor };
