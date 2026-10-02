/**
 * node_helper.js -- MMM-PackageAlert
 *
 * Keeps one WebSocket connection to Home Assistant and turns two entities
 * into a single PACKAGE_STATE notification for the front end:
 *
 *   doorEntity        (default sensor.front_door_package)
 *       state "present" | "clear"; attributes since, source, description,
 *       carrier, last_check, last_check_result
 *   deliveriesEntity  (default sensor.package_deliveries)
 *       state = count of out-for-delivery items; attributes out_for_delivery
 *       and delivered, each a list of objects
 *
 * Flow: auth -> get_states snapshot -> subscribe_events(state_changed),
 * filtered to the two entities. Ping/pong detects half-open sockets, and
 * reconnects back off exponentially. A rejected token is terminal.
 *
 * The token is read here only (haToken > haTokenFile > PACKAGEALERT_HA_TOKEN)
 * and is never placed in any notification or log line. Tracking numbers are
 * never logged above debug level.
 *
 * Front end -> helper: PACKAGE_CONFIG { haUrl, haToken?, haTokenFile?,
 *   doorEntity?, deliveriesEntity?, haAllowSelfSigned?, reconnectInterval?,
 *   heartbeatInterval? }
 * Helper -> front end: PACKAGE_STATE { door, arriving, arrivingCount,
 *   delivered, connected, error } where error is null or
 *   { kind: "config"|"auth"|"connection"|"entities", message, terminal }.
 */

"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const nodePath = require("node:path");
const NodeHelper = require("node_helper");
const Log = require("logger");
const WebSocket = require("ws");

const HA_TOKEN_ENV = "PACKAGEALERT_HA_TOKEN";
const DEFAULT_DOOR_ENTITY = "sensor.front_door_package";
const DEFAULT_DELIVERIES_ENTITY = "sensor.package_deliveries";
const HA_DEFAULT_HEARTBEAT_MS = 30000;
const HA_RECONNECT_MIN_MS = 5000;
const HA_RECONNECT_MAX_MS = 60000;
// Consecutive failed connection attempts before the front end is told.
const HA_ERROR_AFTER_FAILURES = 3;
const MAX_TEXT = 300;
const MAX_ITEMS = 25;
const DOOR_SOURCES = ["camera", "email"];
const NO_CARRIER = ["null", "none", "unknown"];
const CARRIERS = ["usps", "ups", "fedex", "dhl", "amazon", "ontrac", "other"];

/**
 * Validate and normalise haUrl.
 * @param {*} value The configured haUrl.
 * @returns {string|null} The base URL without trailing slashes, or null if invalid.
 */
function normaliseHaUrl (value) {
	if (typeof value !== "string" || !value.trim()) return null;
	try {
		const u = new URL(value.trim());
		if (u.protocol !== "http:" && u.protocol !== "https:") return null;
		return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
	} catch {
		return null;
	}
}

/**
 * Clean a free-text attribute value.
 * @param {*} value Any attribute value.
 * @returns {string|null} A trimmed, length-capped string, or null.
 */
function cleanText (value) {
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	if (typeof value !== "string") return null;
	const t = value.trim();
	return t ? t.slice(0, MAX_TEXT) : null;
}

/**
 * Normalise a carrier value to one of the contract keys.
 * @param {*} value Raw carrier from HA.
 * @returns {string|null} A lowercase carrier key, "other" for anything unknown, null when empty.
 */
function normaliseCarrier (value) {
	const t = cleanText(value);
	if (!t) return null;
	const key = t.toLowerCase();
	if (NO_CARRIER.includes(key)) return null;
	return CARRIERS.includes(key) ? key : "other";
}

/**
 * Parse a list attribute that may arrive as a native array or a JSON string.
 * @param {*} value The attribute value.
 * @returns {Array} The list entries that are plain objects; [] when unusable.
 */
function parseList (value) {
	let list = value;
	if (typeof list === "string") {
		try {
			list = JSON.parse(list);
		} catch {
			return [];
		}
	}
	if (!Array.isArray(list)) return [];
	return list.filter((x) => x && typeof x === "object" && !Array.isArray(x)).slice(0, MAX_ITEMS);
}

/**
 * Is this HA state object usable (entity exists and has data)?
 * @param {object|undefined} st An HA state object.
 * @returns {boolean} True when the state carries data.
 */
function isUsableState (st) {
	return !!st && st.state !== "unavailable" && st.state !== "unknown";
}

/**
 * Shape the door entity into the contract's door object.
 * @param {object|undefined} st The HA state of the door entity.
 * @returns {object} The door payload; state is null when unavailable.
 */
function shapeDoor (st) {
	const attrs = (st && st.attributes) || {};
	const state = isUsableState(st) && (st.state === "present" || st.state === "clear") ? st.state : null;
	const source = typeof attrs.source === "string" && DOOR_SOURCES.includes(attrs.source) ? attrs.source : null;
	return {
		state,
		since: cleanText(attrs.since),
		source,
		description: cleanText(attrs.description),
		carrier: normaliseCarrier(attrs.carrier),
		lastCheck: cleanText(attrs.last_check),
		lastCheckResult: cleanText(attrs.last_check_result)
	};
}

/**
 * Shape the arriving (out for delivery) list.
 * @param {*} value The out_for_delivery attribute.
 * @returns {Array} Items of { carrier, tracking, subject, received }.
 */
function shapeArriving (value) {
	return parseList(value).map((i) => ({
		carrier: normaliseCarrier(i.carrier),
		tracking: cleanText(i.tracking),
		subject: cleanText(i.subject),
		received: cleanText(i.received)
	}));
}

/**
 * Shape the delivered-today list.
 * @param {*} value The delivered attribute.
 * @returns {Array} Items of { carrier, tracking, deliveredAt }.
 */
function shapeDelivered (value) {
	return parseList(value).map((i) => ({
		carrier: normaliseCarrier(i.carrier),
		tracking: cleanText(i.tracking),
		deliveredAt: cleanText(i.delivered_at !== undefined ? i.delivered_at : i.deliveredAt)
	}));
}

// -- node_helper ------------------------------------------------------------

module.exports = NodeHelper.create({
	start () {
		Log.log("[MMM-PackageAlert] node_helper started");
		this.ha = {
			ws: null,
			cfg: null,
			sig: null,
			base: null,
			token: "",
			tokenSource: "haToken",
			doorId: DEFAULT_DOOR_ENTITY,
			deliveriesId: DEFAULT_DELIVERIES_ENTITY,
			msgId: 1,
			snapshotId: null,
			reconnectTimer: null,
			heartbeatTimer: null,
			awaitingPong: false,
			stopping: false,
			authFailed: false,
			started: false,
			connected: false,
			snapshotDone: false,
			failures: 0,
			errors: {},
			states: new Map(), // entity_id -> HA state object, watched entities only
			lastSent: null
		};
	},

	socketNotificationReceived (notification, payload) {
		if (notification !== "PACKAGE_CONFIG") return;
		this._configure(payload && typeof payload === "object" ? payload : {});
	},

	// Token precedence: haToken, then the file named by haTokenFile, then the
	// PACKAGEALERT_HA_TOKEN environment variable.
	_resolveToken (cfg) {
		const ha = this.ha;
		ha.tokenSource = "haToken";
		if (typeof cfg.haToken === "string" && cfg.haToken.trim()) return cfg.haToken.trim();
		if (typeof cfg.haTokenFile === "string" && cfg.haTokenFile.trim()) {
			try {
				const fromFile = fs.readFileSync(cfg.haTokenFile.trim(), "utf8").trim();
				if (fromFile) {
					ha.tokenSource = `haTokenFile (${nodePath.basename(cfg.haTokenFile.trim())})`;
					return fromFile;
				}
			} catch (err) {
				Log.warn(`[MMM-PackageAlert] Could not read haTokenFile (${err.code || "error"})`);
			}
		}
		ha.tokenSource = `the ${HA_TOKEN_ENV} environment variable`;
		return (process.env[HA_TOKEN_ENV] || "").trim();
	},

	// Validate config, then (re)start the HA connection unless nothing changed.
	// A browser reload resends the same config; that must not open a second
	// connection.
	_configure (cfg) {
		const ha = this.ha;
		const base = normaliseHaUrl(cfg.haUrl);
		const token = this._resolveToken(cfg);
		const doorId = typeof cfg.doorEntity === "string" && cfg.doorEntity.trim() ? cfg.doorEntity.trim() : DEFAULT_DOOR_ENTITY;
		const deliveriesId = typeof cfg.deliveriesEntity === "string" && cfg.deliveriesEntity.trim() ? cfg.deliveriesEntity.trim() : DEFAULT_DELIVERIES_ENTITY;

		if (!base || !token) {
			this._shutdown();
			const problems = [];
			if (!base) problems.push("haUrl (an http:// or https:// address)");
			if (!token) problems.push(`a token (haToken, haTokenFile or the ${HA_TOKEN_ENV} environment variable)`);
			this._setError("config", `Home Assistant needs ${problems.join(" and ")}.`, true, true);
			this._publish(true);
			return;
		}

		const sig = crypto.createHash("sha256").update(JSON.stringify([base, token, doorId, deliveriesId, !!cfg.haAllowSelfSigned])).digest("hex");
		if (ha.started && ha.sig === sig) {
			ha.cfg = cfg;
			this._publish(true);
			return;
		}

		this._shutdown();
		ha.sig = sig;
		ha.base = base;
		ha.token = token;
		ha.doorId = doorId;
		ha.deliveriesId = deliveriesId;
		ha.cfg = cfg;
		ha.stopping = false;
		ha.authFailed = false;
		ha.started = true;
		ha.failures = 0;
		this._publish(true);
		this._connect();
	},

	_now () {
		return Date.now();
	},

	// -- WebSocket lifecycle --------------------------------------------------

	_connect () {
		const ha = this.ha;
		if (ha.ws) {
			try { ha.ws.terminate(); } catch { /* socket may already be closed */ }
			ha.ws = null;
		}
		const url = `${ha.base.replace(/^http/, "ws")}/api/websocket`;
		Log.log("[MMM-PackageAlert] Connecting to Home Assistant");

		let ws;
		try {
			ws = new WebSocket(url, {
				rejectUnauthorized: !ha.cfg.haAllowSelfSigned,
				handshakeTimeout: 15000
			});
		} catch (err) {
			Log.error(`[MMM-PackageAlert] Could not create WebSocket: ${err.message}`);
			this._connectionLost();
			return;
		}
		ha.ws = ws;
		ha.msgId = 1;

		ws.on("message", (data) => {
			if (ha.ws !== ws) return; // stale socket
			this._handleMessage(data.toString());
		});
		ws.on("close", (code) => {
			if (ha.ws !== ws) return; // stale socket
			Log.log(`[MMM-PackageAlert] Home Assistant WebSocket closed (${code})`);
			ha.ws = null;
			this._connectionLost();
		});
		ws.on("error", (err) => {
			// 'close' follows 'error', so reconnect is handled there.
			Log.error(`[MMM-PackageAlert] Home Assistant WebSocket error: ${err.message}`);
		});
	},

	_connectionLost () {
		const ha = this.ha;
		this._stopHeartbeat();
		ha.connected = false;
		ha.snapshotDone = false;
		ha.failures += 1;
		const retrying = !(ha.stopping || ha.authFailed);
		// A rejected token is terminal: retrying only invites an HA IP ban.
		if (retrying && ha.failures >= HA_ERROR_AFTER_FAILURES) {
			this._setError("connection", "Home Assistant is unreachable; retrying.", false, true);
		}
		this._publish();
		if (retrying) this._scheduleReconnect();
	},

	_scheduleReconnect () {
		const ha = this.ha;
		if (ha.reconnectTimer) return;
		const base = (ha.cfg && Number(ha.cfg.reconnectInterval)) || HA_RECONNECT_MIN_MS;
		const delay = Math.min(Math.max(HA_RECONNECT_MAX_MS, base), base * (2 ** Math.max(0, ha.failures - 1)));
		Log.log(`[MMM-PackageAlert] Reconnecting to Home Assistant in ${Math.round(delay / 1000)}s`);
		ha.reconnectTimer = setTimeout(() => {
			ha.reconnectTimer = null;
			if (ha.started && !ha.stopping) this._connect();
		}, delay);
	},

	_send (obj) {
		const ws = this.ha.ws;
		if (!ws || ws.readyState !== WebSocket.OPEN) return;
		try {
			ws.send(JSON.stringify(obj));
		} catch (err) {
			Log.error(`[MMM-PackageAlert] Home Assistant send error: ${err.message}`);
		}
	},

	// A Wi-Fi drop can leave a half-open TCP socket that never fires 'close'.
	// Ping HA periodically and force a reconnect if a pong does not come back.
	_startHeartbeat () {
		const ha = this.ha;
		this._stopHeartbeat();
		const interval = (ha.cfg && Number(ha.cfg.heartbeatInterval)) || HA_DEFAULT_HEARTBEAT_MS;
		ha.heartbeatTimer = setInterval(() => {
			if (ha.awaitingPong) {
				Log.warn("[MMM-PackageAlert] No pong from Home Assistant; reconnecting");
				this._stopHeartbeat();
				if (ha.ws) {
					try { ha.ws.terminate(); } catch { /* socket may already be closed */ }
				}
				return;
			}
			ha.awaitingPong = true;
			this._send({ id: ha.msgId++, type: "ping" });
		}, interval);
		if (ha.heartbeatTimer.unref) ha.heartbeatTimer.unref();
	},

	_stopHeartbeat () {
		const ha = this.ha;
		if (ha.heartbeatTimer) {
			clearInterval(ha.heartbeatTimer);
			ha.heartbeatTimer = null;
		}
		ha.awaitingPong = false;
	},

	// -- Errors ---------------------------------------------------------------

	// kind: "config" | "auth" | "connection" | "entities". Terminal means the
	// module will not retry on its own. Messages never contain the token or
	// tracking numbers.
	_setError (kind, message, terminal, quiet) {
		const ha = this.ha;
		const cur = ha.errors[kind];
		if (cur && cur.message === message) return;
		ha.errors[kind] = { kind, message, terminal };
		Log.error(`[MMM-PackageAlert] ${message}`);
		if (!quiet) this._publish();
	},

	_clearError (kind) {
		const ha = this.ha;
		if (!ha.errors[kind]) return;
		delete ha.errors[kind];
		this._publish();
	},

	// Most severe active error (config, auth, connection, then entities), or null.
	_currentError () {
		const e = this.ha.errors;
		return e.config || e.auth || e.connection || e.entities || null;
	},

	// -- Message handling -----------------------------------------------------

	_handleMessage (raw) {
		const ha = this.ha;
		// HA emits thousands of unrelated state changes an hour; skip parsing the
		// ones that cannot concern the two watched entities.
		if (ha.snapshotDone && (/"type"\s*:\s*"event"/).test(raw) && !raw.includes(ha.doorId) && !raw.includes(ha.deliveriesId)) return;

		let msg;
		try {
			msg = JSON.parse(raw);
		} catch {
			return;
		}
		if (!msg || typeof msg !== "object") return;

		switch (msg.type) {
			case "auth_required":
				this._send({ type: "auth", access_token: ha.token });
				break;

			case "auth_ok":
				Log.log(`[MMM-PackageAlert] Home Assistant authenticated (HA ${msg.ha_version})`);
				ha.failures = 0;
				ha.connected = true;
				ha.snapshotDone = false;
				ha.snapshotId = ha.msgId++;
				this._send({ id: ha.snapshotId, type: "get_states" });
				this._send({ id: ha.msgId++, type: "subscribe_events", event_type: "state_changed" });
				this._startHeartbeat();
				delete ha.errors.connection;
				this._publish();
				break;

			case "auth_invalid":
				ha.authFailed = true;
				this._setError("auth", `Home Assistant rejected the access token (check ${ha.tokenSource}).`, true);
				break;

			case "pong":
				ha.awaitingPong = false;
				break;

			case "result":
				if (msg.id === ha.snapshotId) {
					if (msg.success && Array.isArray(msg.result)) {
						this._ingestSnapshot(msg.result);
					} else {
						Log.warn("[MMM-PackageAlert] Home Assistant get_states failed");
						this._setError("connection", "Could not read states from Home Assistant.", false);
					}
				} else if (!msg.success) {
					Log.warn(`[MMM-PackageAlert] Home Assistant command failed (${msg.error && msg.error.code})`);
				}
				break;

			case "event":
				this._handleEvent(msg.event);
				break;

			default:
				break;
		}
	},

	_ingestSnapshot (list) {
		const ha = this.ha;
		ha.states.clear();
		for (const st of list) {
			if (st && (st.entity_id === ha.doorId || st.entity_id === ha.deliveriesId)) ha.states.set(st.entity_id, st);
		}
		ha.snapshotDone = true;
		delete ha.errors.connection;
		this._evaluateEntities();
		this._publish();
	},

	_handleEvent (event) {
		const ha = this.ha;
		if (!event || event.event_type !== "state_changed" || !event.data) return;
		const { entity_id: id, new_state: next } = event.data;
		if (id !== ha.doorId && id !== ha.deliveriesId) return;
		if (next && typeof next === "object") {
			ha.states.set(id, next);
		} else {
			ha.states.delete(id); // entity removed
		}
		if (ha.snapshotDone) this._evaluateEntities();
		this._publish();
	},

	// The HA package may not be installed yet: report missing entities as a
	// clear, non-terminal error and keep showing whichever entity does exist.
	_evaluateEntities () {
		const ha = this.ha;
		const missing = [ha.doorId, ha.deliveriesId].filter((id) => !ha.states.has(id));
		if (!missing.length) {
			delete ha.errors.entities;
			return;
		}
		const message = `Home Assistant entity ${missing.join(" or ")} not found - see README (Home Assistant setup).`;
		const cur = ha.errors.entities;
		if (!cur || cur.message !== message) {
			ha.errors.entities = { kind: "entities", message, terminal: false };
			Log.warn(`[MMM-PackageAlert] ${message}`);
		}
	},

	// -- Output ---------------------------------------------------------------

	_buildState () {
		const ha = this.ha;
		const doorSt = ha.states.get(ha.doorId);
		const delSt = ha.states.get(ha.deliveriesId);
		const delAttrs = (delSt && isUsableState(delSt) && delSt.attributes) || {};
		const arriving = shapeArriving(delAttrs.out_for_delivery);
		const delivered = shapeDelivered(delAttrs.delivered);
		const n = delSt && isUsableState(delSt) ? Number.parseInt(delSt.state, 10) : NaN;
		const e = this._currentError();
		return {
			door: shapeDoor(doorSt),
			arriving,
			arrivingCount: Number.isFinite(n) && n >= 0 ? n : arriving.length,
			delivered,
			connected: ha.connected,
			error: e ? { kind: e.kind, message: e.message, terminal: !!e.terminal } : null
		};
	},

	// Send PACKAGE_STATE, skipping it when identical to the last one unless
	// forced (a (re)connecting browser always needs the current state).
	_publish (force) {
		const state = this._buildState();
		const json = JSON.stringify(state);
		if (!force && json === this.ha.lastSent) return;
		this.ha.lastSent = json;
		Log.debug(`[MMM-PackageAlert] State: door=${state.door.state} arriving=${state.arriving.length} delivered=${state.delivered.length} connected=${state.connected}`);
		this.sendSocketNotification("PACKAGE_STATE", state);
	},

	_shutdown () {
		const ha = this.ha;
		ha.stopping = true;
		ha.started = false;
		ha.sig = null;
		ha.connected = false;
		ha.snapshotDone = false;
		ha.authFailed = false;
		ha.errors = {};
		ha.states.clear();
		this._stopHeartbeat();
		if (ha.reconnectTimer) {
			clearTimeout(ha.reconnectTimer);
			ha.reconnectTimer = null;
		}
		if (ha.ws) {
			const ws = ha.ws;
			ha.ws = null;
			try { ws.terminate(); } catch { /* socket may already be closed */ }
		}
	},

	// Clean up when MagicMirror stops
	stop () {
		this._shutdown();
	},

	// Exposed only so the test suite can exercise pure helpers directly.
	_testables: {
		normaliseHaUrl,
		parseList,
		shapeDoor,
		shapeArriving,
		shapeDelivered,
		cleanText,
		normaliseCarrier
	}
});
