"use strict";

// node_helper message handling and shaping, with the real WebSocket stubbed out.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { TOKEN, DOOR, DELIVERIES, makeHelper, doorState, deliveriesState } = require("./support/ha-fake");
const NodeHelperClass = require("../node_helper");

const T = new NodeHelperClass()._testables;

/**
 * Configure the helper and feed it a handshake plus a get_states snapshot.
 * @param {object} ctx makeHelper context.
 * @param {Array} states get_states result.
 * @returns {void}
 */
function connectWith (ctx, states) {
	ctx.configure();
	ctx.helper.ha.ws = { readyState: 1, send () {}, terminate () {}, on () {} };
	ctx.send({ type: "auth_ok", ha_version: "2026.9.3" });
	ctx.send({ id: ctx.helper.ha.snapshotId, type: "result", success: true, result: states });
}

/**
 * @param {object} ctx makeHelper context.
 * @param {object} st New state for a watched entity.
 * @returns {void}
 */
function changed (ctx, st) {
	ctx.send({ type: "event", event: { event_type: "state_changed", data: { entity_id: st.entity_id, new_state: st, old_state: null } } });
}

test("normaliseCarrier lowercases, maps unknown to other, empty to null", () => {
	assert.equal(T.normaliseCarrier(" UPS "), "ups");
	assert.equal(T.normaliseCarrier("FedEx"), "fedex");
	assert.equal(T.normaliseCarrier("OnTrac"), "ontrac");
	assert.equal(T.normaliseCarrier("USPS"), "usps");
	assert.equal(T.normaliseCarrier("Royal Mail"), "other");
	assert.equal(T.normaliseCarrier("other"), "other");
	assert.equal(T.normaliseCarrier(""), null);
	assert.equal(T.normaliseCarrier("   "), null);
	assert.equal(T.normaliseCarrier(null), null);
	assert.equal(T.normaliseCarrier(undefined), null);
	assert.equal(T.normaliseCarrier({}), null);
	for (const v of ["null", " None ", "UNKNOWN", "Null"]) assert.equal(T.normaliseCarrier(v), null);
});

test("parseList accepts native arrays and JSON strings, rejects junk", () => {
	assert.deepEqual(T.parseList([{ a: 1 }, "x", null, [1], { b: 2 }]), [{ a: 1 }, { b: 2 }]);
	assert.deepEqual(T.parseList("[{\"a\":1}]"), [{ a: 1 }]);
	assert.deepEqual(T.parseList("not json"), []);
	assert.deepEqual(T.parseList("{\"a\":1}"), []);
	assert.deepEqual(T.parseList(undefined), []);
	assert.deepEqual(T.parseList(42), []);
	assert.equal(T.parseList(Array.from({ length: 100 }, () => ({}))).length, 25);
});

test("shapeDoor maps attributes to the contract and normalises carrier", () => {
	const d = T.shapeDoor(doorState({ carrier: "FEDEX", source: "email" }));
	assert.deepEqual(d, {
		state: "present",
		since: "2026-10-01T10:00:00-04:00",
		source: "email",
		description: "Brown box",
		carrier: "fedex",
		lastCheck: "2026-10-01T10:00:05-04:00",
		lastCheckResult: "package"
	});
});

test("shapeDoor tolerates unavailable, unknown values and a missing entity", () => {
	assert.equal(T.shapeDoor({ entity_id: DOOR, state: "unavailable", attributes: {} }).state, null);
	assert.equal(T.shapeDoor(doorState({ source: "carrier-pigeon" })).source, null);
	assert.equal(T.shapeDoor({ entity_id: DOOR, state: "weird", attributes: {} }).state, null);
	assert.equal(T.shapeDoor(doorState({ carrier: "Mystery Couriers" })).carrier, "other");
	const none = T.shapeDoor(undefined);
	assert.equal(none.state, null);
	assert.equal(none.carrier, null);
});

test("shapeArriving and shapeDelivered normalise carriers and field names", () => {
	assert.deepEqual(T.shapeArriving("[{\"carrier\":\"USPS\",\"tracking\":\"9400\",\"subject\":\"s\",\"received\":\"r\"}]"), [
		{ carrier: "usps", tracking: "9400", subject: "s", received: "r" }
	]);
	assert.deepEqual(T.shapeDelivered([{ carrier: "Weird", tracking: "T1", delivered_at: "2026-10-01T12:00:00" }, { carrier: "amazon" }, { carrier: "" }]), [
		{ carrier: "other", tracking: "T1", deliveredAt: "2026-10-01T12:00:00" },
		{ carrier: "amazon", tracking: null, deliveredAt: null },
		{ carrier: null, tracking: null, deliveredAt: null }
	]);
});

test("normaliseHaUrl validates scheme and strips trailing slashes", () => {
	assert.equal(T.normaliseHaUrl("http://ha.local:8123/"), "http://ha.local:8123");
	assert.equal(T.normaliseHaUrl("https://ha.example.test/sub//"), "https://ha.example.test/sub");
	assert.equal(T.normaliseHaUrl("ftp://x"), null);
	assert.equal(T.normaliseHaUrl("nonsense"), null);
	assert.equal(T.normaliseHaUrl(undefined), null);
});

test("snapshot produces a PACKAGE_STATE with door and deliveries", () => {
	const ctx = makeHelper({ connect: false });
	connectWith(ctx, [{ entity_id: "light.x", state: "on", attributes: {} }, doorState({ carrier: "UPS" }), deliveriesState({ delivered: [{ carrier: "Amazon", tracking: "", delivered_at: "2026-10-01T11:00:00" }] }, "1")]);
	const s = ctx.last();
	assert.equal(s.connected, true);
	assert.equal(s.error, null);
	assert.equal(s.door.state, "present");
	assert.equal(s.door.carrier, "ups");
	assert.equal(s.arriving.length, 1);
	assert.equal(s.arriving[0].carrier, "ups");
	assert.equal(s.arrivingCount, 1);
	assert.equal(s.delivered[0].carrier, "amazon");
	assert.equal(s.delivered[0].tracking, null);
	ctx.stop();
});

test("list attributes given as JSON strings are parsed", () => {
	const ctx = makeHelper({ connect: false });
	connectWith(ctx, [doorState(), deliveriesState({ out_for_delivery: JSON.stringify([{ carrier: "dhl", tracking: "123", subject: "s", received: "r" }, { carrier: "ups", tracking: "456" }]) }, "2")]);
	const s = ctx.last();
	assert.equal(s.arriving.length, 2);
	assert.equal(s.arrivingCount, 2);
	assert.equal(s.arriving[0].carrier, "dhl");
	ctx.stop();
});

test("a non-numeric deliveries state falls back to the list length", () => {
	const ctx = makeHelper({ connect: false });
	connectWith(ctx, [doorState(), deliveriesState({}, "banana")]);
	assert.equal(ctx.last().arrivingCount, 1);
	ctx.stop();
});

test("state_changed events for the watched entities update state; others are ignored", () => {
	const ctx = makeHelper({ connect: false });
	connectWith(ctx, [doorState({ since: "a" }), deliveriesState()]);
	ctx.clear();
	changed(ctx, { entity_id: "sensor.unrelated", state: "1", attributes: {} });
	assert.equal(ctx.states().length, 0);
	changed(ctx, { entity_id: DOOR, state: "clear", attributes: { since: "b", source: null } });
	assert.equal(ctx.last().door.state, "clear");
	assert.equal(ctx.last().door.since, "b");
	changed(ctx, { entity_id: DELIVERIES, state: "0", attributes: { out_for_delivery: [], delivered: [] } });
	assert.equal(ctx.last().arriving.length, 0);
	assert.equal(ctx.last().arrivingCount, 0);
	ctx.stop();
});

test("identical consecutive states are not re-sent, but a re-config always is", () => {
	const ctx = makeHelper({ connect: false });
	connectWith(ctx, [doorState(), deliveriesState()]);
	ctx.clear();
	changed(ctx, doorState());
	assert.equal(ctx.states().length, 0);
	ctx.configure();
	assert.equal(ctx.states().length, 1);
	assert.equal(ctx.last().door.state, "present");
	ctx.stop();
});

test("missing entities give a non-terminal entities error, not a crash", () => {
	const ctx = makeHelper({ connect: false });
	connectWith(ctx, [{ entity_id: "light.x", state: "on", attributes: {} }]);
	const s = ctx.last();
	assert.equal(s.connected, true);
	assert.equal(s.error.kind, "entities");
	assert.equal(s.error.terminal, false);
	assert.match(s.error.message, /sensor\.front_door_package/);
	assert.match(s.error.message, /sensor\.package_deliveries/);
	assert.equal(s.door.state, null);
	assert.deepEqual(s.arriving, []);
	ctx.stop();
});

test("only one entity missing still shows the other and names the missing one", () => {
	const ctx = makeHelper({ connect: false });
	connectWith(ctx, [doorState()]);
	const s = ctx.last();
	assert.equal(s.door.state, "present");
	assert.equal(s.error.kind, "entities");
	assert.match(s.error.message, /sensor\.package_deliveries/);
	assert.doesNotMatch(s.error.message, /front_door_package/);
	ctx.stop();
});

test("the entities error clears when the entity appears later and returns if removed", () => {
	const ctx = makeHelper({ connect: false });
	connectWith(ctx, [doorState()]);
	changed(ctx, deliveriesState());
	assert.equal(ctx.last().error, null);
	assert.equal(ctx.last().arriving.length, 1);
	ctx.send({ type: "event", event: { event_type: "state_changed", data: { entity_id: DELIVERIES, new_state: null, old_state: deliveriesState() } } });
	assert.equal(ctx.last().error.kind, "entities");
	ctx.stop();
});

test("unavailable entities do not crash and yield empty data", () => {
	const ctx = makeHelper({ connect: false });
	connectWith(ctx, [{ entity_id: DOOR, state: "unavailable", attributes: {} }, { entity_id: DELIVERIES, state: "unknown", attributes: {} }]);
	const s = ctx.last();
	assert.equal(s.door.state, null);
	assert.deepEqual(s.arriving, []);
	assert.equal(s.error, null);
	ctx.stop();
});

test("custom entity ids are honoured", () => {
	const ctx = makeHelper({ connect: false });
	ctx.configure({ doorEntity: "sensor.porch", deliveriesEntity: "sensor.mail" });
	ctx.send({ type: "auth_ok" });
	ctx.send({ id: ctx.helper.ha.snapshotId, type: "result", success: true, result: [{ entity_id: "sensor.porch", state: "present", attributes: {} }, { entity_id: "sensor.mail", state: "0", attributes: {} }, doorState()] });
	assert.equal(ctx.last().door.state, "present");
	assert.equal(ctx.last().error, null);
	ctx.stop();
});

test("auth_invalid is terminal and the message names the token source", () => {
	const ctx = makeHelper({ connect: false });
	ctx.configure();
	ctx.send({ type: "auth_invalid", message: "Invalid" });
	const s = ctx.last();
	assert.equal(s.error.kind, "auth");
	assert.equal(s.error.terminal, true);
	assert.match(s.error.message, /haToken/);
	assert.equal(ctx.helper.ha.authFailed, true);
	ctx.stop();
});

test("a failed get_states reports a non-terminal connection error", () => {
	const ctx = makeHelper({ connect: false });
	ctx.configure();
	ctx.send({ type: "auth_ok" });
	ctx.send({ id: ctx.helper.ha.snapshotId, type: "result", success: false, error: { code: "unknown" } });
	assert.equal(ctx.last().error.kind, "connection");
	assert.equal(ctx.last().error.terminal, false);
	ctx.stop();
});

test("missing haUrl or token yields a terminal config error and no connection", () => {
	const ctx = makeHelper({ connect: false });
	const saved = process.env.PACKAGEALERT_HA_TOKEN;
	delete process.env.PACKAGEALERT_HA_TOKEN;
	try {
		ctx.helper.socketNotificationReceived("PACKAGE_CONFIG", {});
		assert.equal(ctx.connects(), 0);
		assert.equal(ctx.last().error.kind, "config");
		assert.equal(ctx.last().error.terminal, true);
		assert.match(ctx.last().error.message, /haUrl/);
		assert.match(ctx.last().error.message, /PACKAGEALERT_HA_TOKEN/);
		assert.equal(ctx.last().connected, false);
	} finally {
		if (saved !== undefined) process.env.PACKAGEALERT_HA_TOKEN = saved;
		ctx.stop();
	}
});

test("token precedence is haToken, then haTokenFile, then the environment", () => {
	const ctx = makeHelper({ connect: false });
	const file = path.join(os.tmpdir(), `packagealert-token-${process.pid}.txt`);
	fs.writeFileSync(file, "  FILE-TOKEN\n");
	const saved = process.env.PACKAGEALERT_HA_TOKEN;
	process.env.PACKAGEALERT_HA_TOKEN = "ENV-TOKEN";
	try {
		const h = ctx.helper;
		assert.equal(h._resolveToken({ haToken: " DIRECT ", haTokenFile: file }), "DIRECT");
		assert.equal(h._resolveToken({ haTokenFile: file }), "FILE-TOKEN");
		assert.match(h.ha.tokenSource, /haTokenFile/);
		assert.equal(h._resolveToken({ haTokenFile: path.join(os.tmpdir(), "does-not-exist-xyz") }), "ENV-TOKEN");
		assert.equal(h._resolveToken({}), "ENV-TOKEN");
		assert.match(h.ha.tokenSource, /PACKAGEALERT_HA_TOKEN/);
	} finally {
		fs.rmSync(file, { force: true });
		if (saved === undefined) delete process.env.PACKAGEALERT_HA_TOKEN;
		else process.env.PACKAGEALERT_HA_TOKEN = saved;
		ctx.stop();
	}
});

test("the token never appears in any notification payload", () => {
	const ctx = makeHelper({ connect: false });
	connectWith(ctx, [doorState(), deliveriesState()]);
	ctx.send({ type: "auth_invalid", message: "Invalid" });
	ctx.configure({ haUrl: "garbage" });
	assert.ok(ctx.sent.length > 0);
	assert.ok(!JSON.stringify(ctx.sent).includes(TOKEN));
	assert.ok(!JSON.stringify(ctx.sent).includes("access_token"));
	ctx.stop();
});

test("the same config resent (browser reload) opens no second connection", () => {
	const ctx = makeHelper({ connect: false });
	ctx.configure();
	ctx.configure();
	ctx.configure();
	assert.equal(ctx.connects(), 1);
	ctx.configure({ doorEntity: "sensor.other" });
	assert.equal(ctx.connects(), 2);
	ctx.stop();
});

test("a reload after a terminal auth error still reports that error", () => {
	const ctx = makeHelper({ connect: false });
	ctx.configure();
	ctx.send({ type: "auth_invalid", message: "x" });
	ctx.clear();
	ctx.configure();
	assert.equal(ctx.connects(), 1);
	assert.equal(ctx.last().error.kind, "auth");
	assert.equal(ctx.last().error.terminal, true);
	ctx.stop();
});

test("unrelated notifications and malformed frames are ignored", () => {
	const ctx = makeHelper({ connect: false });
	ctx.helper.socketNotificationReceived("SOMETHING_ELSE", {});
	assert.equal(ctx.connects(), 0);
	ctx.configure();
	ctx.helper._handleMessage("not json");
	ctx.helper._handleMessage("null");
	ctx.helper._handleMessage("42");
	ctx.send({ type: "event", event: null });
	ctx.send({ type: "event", event: { event_type: "state_changed" } });
	ctx.send({ type: "mystery" });
	ctx.helper.socketNotificationReceived("PACKAGE_CONFIG", null);
	ctx.stop();
});

test("tracking numbers and the token are never logged above debug", () => {
	const logger = require("logger");
	const lines = [];
	const orig = {};
	for (const level of ["log", "info", "warn", "error"]) {
		orig[level] = logger[level];
		logger[level] = (...a) => lines.push(a.join(" "));
	}
	try {
		const ctx = makeHelper({ connect: false });
		connectWith(ctx, [doorState(), deliveriesState({ delivered: [{ carrier: "ups", tracking: "1Z999AA10123456784", delivered_at: "x" }] })]);
		ctx.send({ type: "auth_invalid", message: "x" });
		ctx.stop();
		assert.ok(lines.length > 0);
		assert.ok(!lines.join("\n").includes("1Z999AA10123456784"));
		assert.ok(!lines.join("\n").includes(TOKEN));
	} finally {
		Object.assign(logger, orig);
	}
});

test("a rejected token is logged once", () => {
	const logger = require("logger");
	const lines = [];
	const orig = logger.error;
	logger.error = (...a) => lines.push(a.join(" "));
	try {
		const ctx = makeHelper({ connect: false });
		ctx.configure();
		ctx.send({ type: "auth_invalid", message: "x" });
		ctx.stop();
		assert.equal(lines.filter((l) => (/rejected the access token/).test(l)).length, 1);
	} finally {
		logger.error = orig;
	}
});
