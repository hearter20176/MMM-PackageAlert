"use strict";

// Front-end tests for MMM-PackageAlert.js with a small fake DOM, fake timers and a fake clock.

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

class FakeClassList {
	constructor (el) {
		this.el = el;
	}

	_list () {
		return this.el.className.split(/\s+/).filter(Boolean);
	}

	contains (c) {
		return this._list().includes(c);
	}

	add (c) {
		if (!this.contains(c)) this.el.className = [...this._list(), c].join(" ");
	}

	remove (c) {
		this.el.className = this._list().filter((x) => x !== c).join(" ");
	}
}

class FakeElement {
	constructor (tagName) {
		this.tagName = tagName;
		this.className = "";
		this.textContent = "";
		this.children = [];
		this.style = {};
		this.attributes = {};
		this.classList = new FakeClassList(this);
	}

	appendChild (child) {
		this.children.push(child);
		return child;
	}

	setAttribute (name, value) {
		this.attributes[name] = String(value);
	}

	querySelector (sel) {
		const cls = sel.replace(/^\./, "");
		return findAll(this, cls)[0] || null;
	}
}

function findAll (root, cls) {
	const found = [];
	if (root.className.split(/\s+/).includes(cls)) found.push(root);
	for (const child of root.children) found.push(...findAll(child, cls));
	return found;
}

function textOf (root) {
	return [root.textContent, ...root.children.map(textOf)].filter(Boolean).join(" ");
}

function allClasses (root) {
	return [root.className, ...root.children.map(allClasses)].filter(Boolean).join(" ");
}

let definition = null;
global.Module = { register (name, def) { definition = def; } };
global.Log = { info () {}, warn () {}, error () {} };

let liveRoot = null; // what "MM" currently has on screen
global.document = {
	createElement: (tag) => new FakeElement(tag),
	getElementById: () => liveRoot
};

// Fake timers and clock
let timers = [];
let timerId = 0;
let nowMs = 0;
const realSetTimeout = global.setTimeout;
const realClearTimeout = global.clearTimeout;
const realNow = Date.now;

function advance (ms) {
	const target = nowMs + ms;
	for (;;) {
		const due = timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
		if (!due) break;
		timers = timers.filter((t) => t !== due);
		nowMs = due.at;
		due.fn();
	}
	nowMs = target;
}

require(path.join(__dirname, "..", "MMM-PackageAlert.js"));
const spec = definition;

function make (config = {}) {
	const m = Object.create(spec);
	m.identifier = "module_1_MMM-PackageAlert";
	m.hidden = false;
	m.config = Object.assign({}, spec.defaults, config);
	m.sent = [];
	m.notes = [];
	m.domUpdates = [];
	m.sendSocketNotification = (n, p) => m.sent.push([n, p]);
	m.sendNotification = (n, p) => m.notes.push([n, p]);
	m.updateDom = (speed) => m.domUpdates.push(speed);
	m.start();
	return m;
}

// Mimic MM: getDom and put the result on screen.
function render (m) {
	liveRoot = new FakeElement("div");
	liveRoot.appendChild(m.getDom());
	m.notificationReceived("MODULE_DOM_UPDATED", null, undefined);
	return liveRoot.children[0];
}

const present = (extra = {}) => Object.assign({ state: "present", since: new Date(nowMs - 3600000).toISOString(), source: "camera", description: "", carrier: null }, extra);
const state = (over = {}) => Object.assign({ door: { state: "clear" }, arriving: [], connected: true, error: null }, over);

beforeEach(() => {
	timers = [];
	nowMs = new Date(2026, 9, 1, 15, 0, 0).getTime();
	liveRoot = null;
	global.setTimeout = (fn, ms) => {
		const t = { id: ++timerId, at: nowMs + ms, fn };
		timers.push(t);
		return t;
	};
	global.clearTimeout = (t) => {
		timers = timers.filter((x) => x !== t);
	};
	Date.now = () => nowMs;
});

afterEach(() => {
	global.setTimeout = realSetTimeout;
	global.clearTimeout = realClearTimeout;
	Date.now = realNow;
});

test("start sends the config to the helper and registers both stylesheets", () => {
	const m = make({ haUrl: "http://ha:8123" });
	assert.equal(m.sent.length, 1);
	assert.equal(m.sent[0][0], "PACKAGE_CONFIG");
	assert.equal(m.sent[0][1].haUrl, "http://ha:8123");
	assert.deepEqual(m.getStyles(), ["font-awesome.css", "MMM-PackageAlert.css"]);
});

test("renders nothing when no package and nothing arriving", () => {
	const m = make();
	m.socketNotificationReceived("PACKAGE_STATE", state());
	const root = m.getDom();
	assert.ok(root.className.includes("pa-empty"));
	assert.equal(root.children.length, 0);
	assert.equal(textOf(root), "");
});

test("renders nothing before any state arrives", () => {
	const m = make();
	assert.equal(m.getDom().children.length, 0);
});

test("package present from the camera shows title, since time and source", () => {
	const m = make();
	m.socketNotificationReceived("PACKAGE_STATE", state({ door: present() }));
	const text = textOf(m.getDom());
	assert.match(text, /Package at the front door/);
	assert.match(text, /Since 2:00 PM/);
	assert.match(text, /doorbell camera/);
	assert.equal(allClasses(m.getDom()).includes("fa-solid fa-box"), true);
});

test("24 hour time format and yesterday wording", () => {
	const m = make({ timeFormat: 24 });
	m.socketNotificationReceived("PACKAGE_STATE", state({ door: present({ since: new Date(2026, 8, 30, 21, 5).toISOString() }) }));
	assert.match(textOf(m.getDom()), /Since yesterday 21:05/);
});

test("package from email names the carrier and uses its brand icon", () => {
	const m = make();
	m.socketNotificationReceived("PACKAGE_STATE", state({ door: present({ source: "email", carrier: "ups" }) }));
	const dom = m.getDom();
	assert.match(textOf(dom), /delivery email from UPS/);
	assert.ok(allClasses(dom).includes("fa-brands fa-ups"));
});

test("arriving line: count, carriers, masked tracking by default", () => {
	const m = make();
	m.socketNotificationReceived("PACKAGE_STATE", state({
		arriving: [
			{ carrier: "ups", tracking: "1Z999AA10123456784" },
			{ carrier: "amazon", tracking: "" },
			{ carrier: "ups", tracking: "1Z999AA10123450000" }
		]
	}));
	const dom = m.getDom();
	const text = textOf(dom);
	assert.match(text, /Arriving today: 3 -/);
	assert.match(text, /UPS,/);
	assert.match(text, /Amazon/);
	assert.match(text, /\*\*\*6784/);
	assert.doesNotMatch(text, /1Z999AA10123456784/);
	assert.doesNotMatch(text, /Package at the front door/);
	assert.equal(findAll(dom, "pa-card-door").length, 0);
});

test("showTracking full and none", () => {
	const items = [{ carrier: "fedex", tracking: "123456789012" }];
	const full = make({ showTracking: "full" });
	full.socketNotificationReceived("PACKAGE_STATE", state({ arriving: items }));
	assert.match(textOf(full.getDom()), /123456789012/);
	const none = make({ showTracking: "none" });
	none.socketNotificationReceived("PACKAGE_STATE", state({ arriving: items }));
	const t = textOf(none.getDom());
	assert.match(t, /Arriving today: 1/);
	assert.equal(findAll(none.getDom(), "pa-chip").length, 0);
	assert.doesNotMatch(t, /9012/);
});

test("short tracking numbers are fully masked", () => {
	const m = make();
	m.socketNotificationReceived("PACKAGE_STATE", state({ arriving: [{ carrier: "dhl", tracking: "1234" }] }));
	assert.match(textOf(m.getDom()), /\*\*\*\*/);
	assert.doesNotMatch(textOf(m.getDom()), /1234/);
});

test("maxTracking caps the chips and reports the rest", () => {
	const m = make({ maxTracking: 2 });
	assert.equal(spec.defaults.maxTracking, 3);
	assert.equal(spec.defaults.showDescription, undefined);
	m.socketNotificationReceived("PACKAGE_STATE", state({
		arriving: [1, 2, 3, 4].map((n) => ({ carrier: "ups", tracking: "AAAA000" + n }))
	}));
	assert.equal(findAll(m.getDom(), "pa-chip").length, 3);
	assert.match(textOf(m.getDom()), /\+2/);
});

test("showArriving false hides the arriving line", () => {
	const m = make({ showArriving: false });
	m.socketNotificationReceived("PACKAGE_STATE", state({ arriving: [{ carrier: "ups", tracking: "X" }] }));
	assert.equal(m.getDom().children.length, 0);
});

test("package and arriving render together in one card", () => {
	const m = make();
	m.socketNotificationReceived("PACKAGE_STATE", state({ door: present(), arriving: [{ carrier: "usps", tracking: "9400111899223" }] }));
	const dom = m.getDom();
	assert.equal(findAll(dom, "pa-card").length, 1);
	assert.equal(findAll(dom, "pa-door").length, 1);
	assert.equal(findAll(dom, "pa-arriving").length, 1);
});

// ---- Carrier icon mapping ----

const iconFor = (carrier) => {
	const m = make();
	m.socketNotificationReceived("PACKAGE_STATE", state({ door: present({ carrier }) }));
	return findAll(m.getDom(), "pa-door-icon")[0];
};

test("carrier keys map to the fixed Font Awesome classes", () => {
	const expected = {
		usps: "fa-brands fa-usps",
		ups: "fa-brands fa-ups",
		fedex: "fa-brands fa-fedex",
		dhl: "fa-brands fa-dhl",
		amazon: "fa-brands fa-amazon",
		ontrac: "fa-solid fa-truck-fast",
		other: "fa-solid fa-truck-fast"
	};
	for (const [key, cls] of Object.entries(expected)) {
		const icon = iconFor(key);
		assert.ok(icon.className.startsWith(cls + " "), key + " -> " + icon.className);
		assert.equal(icon.attributes["aria-hidden"], "true");
	}
	assert.ok(iconFor(null).className.startsWith("fa-solid fa-box "));
	assert.ok(iconFor("UPS").className.startsWith("fa-brands fa-ups "));
});

test("unknown and hostile carrier values fall back and never reach a class name", () => {
	const hostile = ["dhl\" onmouseover=\"x", "fa-brands fa-skull", "__proto__", "constructor", "toString", "hasOwnProperty", "<img src=x>", "../../x", 42, "ups ups"];
	for (const value of hostile) {
		const icon = iconFor(value);
		assert.ok(icon.className.startsWith("fa-solid fa-truck-fast "), String(value) + " -> " + icon.className);
		assert.ok(!/skull|onmouseover|img|proto|constructor/i.test(icon.className));
	}
	for (const value of [undefined, "", "   ", "null", false, {}, [], () => 1]) {
		assert.ok(iconFor(value).className.startsWith("fa-solid fa-box "), String(value));
	}
});

test("hostile carrier in arriving items falls back and prints no raw text", () => {
	const m = make();
	m.socketNotificationReceived("PACKAGE_STATE", state({ arriving: [{ carrier: "<b>evil</b>", tracking: "ABCD1234" }] }));
	const dom = m.getDom();
	assert.doesNotMatch(textOf(dom), /evil/);
	assert.doesNotMatch(allClasses(dom), /evil|<b>/);
	assert.match(textOf(dom), /Arriving today: 1/);
	assert.match(textOf(dom), /\*\*\*1234/);
});

// ---- Text safety and malformed payloads ----

test("HA text is set via textContent only (no markup interpreted, no innerHTML)", () => {
	const m = make({ showTracking: "full" });
	m.socketNotificationReceived("PACKAGE_STATE", state({
		door: present(),
		arriving: [{ carrier: "ups", tracking: "<img src=x onerror=alert(1)>" }]
	}));
	const dom = m.getDom();
	assert.match(textOf(dom), /<img src=x onerror=alert\(1\)>/);
	const walk = (el) => {
		assert.equal("innerHTML" in el, false);
		el.children.forEach(walk);
	};
	walk(dom);
});

test("long text is truncated", () => {
	const m = make({ showTracking: "full" });
	m.socketNotificationReceived("PACKAGE_STATE", state({ arriving: [{ carrier: "ups", tracking: "x".repeat(5000) }] }));
	assert.ok(textOf(m.getDom()).length < 600);
});

test("malformed payloads never throw and ignore junk", () => {
	const m = make();
	for (const p of [null, undefined, 5, "x", [], { door: 5 }, { door: { state: {} }, arriving: "no" }, { arriving: [null, 3, "x", {}] }, { error: 7 }]) {
		assert.doesNotThrow(() => m.socketNotificationReceived("PACKAGE_STATE", p));
		assert.doesNotThrow(() => m.getDom());
	}
	assert.doesNotThrow(() => m.socketNotificationReceived("OTHER", {}));
});

test("an invalid since time is omitted", () => {
	const m = make();
	m.socketNotificationReceived("PACKAGE_STATE", state({ door: present({ since: "garbage" }) }));
	const text = textOf(m.getDom());
	assert.doesNotMatch(text, /Since/);
	assert.match(text, /doorbell camera/);
});

test("getDom does not throw when internals are corrupt", () => {
	const m = make();
	m.socketNotificationReceived("PACKAGE_STATE", state({ door: present() }));
	m.door = { state: "present", carrier: "zzz-not-a-key", source: "email" };
	assert.doesNotThrow(() => m.getDom());
	assert.ok(m.getDom().className.includes("pa-empty"));
});

// ---- PACKAGE_AT_DOOR transitions ----

test("PACKAGE_AT_DOOR is sent on transitions only", () => {
	const m = make();
	m.socketNotificationReceived("PACKAGE_STATE", state());
	assert.equal(m.notes.length, 0);
	m.socketNotificationReceived("PACKAGE_STATE", state({ door: present() }));
	m.socketNotificationReceived("PACKAGE_STATE", state({ door: present({ description: "again" }) }));
	m.socketNotificationReceived("PACKAGE_STATE", state({ door: present(), connected: false, error: { kind: "connection", terminal: false } }));
	assert.deepEqual(m.notes, [["PACKAGE_AT_DOOR", { present: true }]]);
	m.socketNotificationReceived("PACKAGE_STATE", state());
	m.socketNotificationReceived("PACKAGE_STATE", state());
	assert.deepEqual(m.notes, [["PACKAGE_AT_DOOR", { present: true }], ["PACKAGE_AT_DOOR", { present: false }]]);
});

test("a package already present on the first snapshot is announced once", () => {
	const m = make();
	m.socketNotificationReceived("PACKAGE_STATE", state({ door: present() }));
	assert.deepEqual(m.notes, [["PACKAGE_AT_DOOR", { present: true }]]);
});

test("every state update asks for a redraw with the configured speed", () => {
	const m = make({ animationSpeed: 321 });
	m.socketNotificationReceived("PACKAGE_STATE", state());
	assert.deepEqual(m.domUpdates, [321]);
});

// ---- Status line ----

test("terminal auth error is shown at once, even with nothing else", () => {
	const m = make();
	m.socketNotificationReceived("PACKAGE_STATE", state({ connected: false, error: { kind: "auth", message: "secret", terminal: true } }));
	const text = textOf(m.getDom());
	assert.match(text, /login failed/);
	assert.doesNotMatch(text, /secret/);
});

test("reconnecting is silent until the grace has passed, then a timer redraws", () => {
	const m = make({ errorGraceSeconds: 60 });
	const err = state({ connected: false, error: { kind: "connection", terminal: false } });
	m.socketNotificationReceived("PACKAGE_STATE", err);
	assert.equal(m.getDom().children.length, 0);
	assert.equal(timers.length, 1);
	const before = m.domUpdates.length;
	advance(60000);
	assert.equal(m.domUpdates.length, before + 1);
	assert.match(textOf(m.getDom()), /Reconnecting/);
	// repeated errors do not restart the clock
	m.socketNotificationReceived("PACKAGE_STATE", err);
	assert.match(textOf(m.getDom()), /Reconnecting/);
	// recovery clears it
	m.socketNotificationReceived("PACKAGE_STATE", state());
	assert.equal(m.getDom().children.length, 0);
	assert.equal(timers.length, 0);
});

test("status line is appended under a package alert", () => {
	const m = make({ errorGraceSeconds: 0 });
	m.socketNotificationReceived("PACKAGE_STATE", state({ door: present(), connected: false, error: { kind: "connection", terminal: false } }));
	const dom = m.getDom();
	assert.equal(findAll(dom, "pa-door").length, 1);
	assert.equal(findAll(dom, "pa-status").length, 1);
});

test("no status line when connected and healthy", () => {
	const m = make();
	m.socketNotificationReceived("PACKAGE_STATE", state({ door: present() }));
	assert.equal(findAll(m.getDom(), "pa-status").length, 0);
});

// ---- Pulse, suspend, resume ----

test("pulse starts on the live card after the swap, ends after PULSE_MS", () => {
	const m = make();
	m.socketNotificationReceived("PACKAGE_STATE", state({ door: present() }));
	assert.equal(m.pulseState, "pending");
	assert.equal(timers.length, 0);
	const card = render(m).children[0];
	assert.equal(m.pulseState, "active");
	assert.ok(card.classList.contains("pa-pulse"));
	advance(m.PULSE_MS - 1);
	assert.ok(card.classList.contains("pa-pulse"));
	advance(1);
	assert.equal(m.pulseState, "none");
	assert.ok(!card.classList.contains("pa-pulse"));
	assert.equal(timers.length, 0);
});

test("no second pulse for later renders or repeated present updates", () => {
	const m = make();
	m.socketNotificationReceived("PACKAGE_STATE", state({ door: present() }));
	render(m);
	advance(m.PULSE_MS);
	m.socketNotificationReceived("PACKAGE_STATE", state({ door: present({ description: "x" }) }));
	const card = render(m).children[0];
	m.notificationReceived("MODULE_DOM_UPDATED", null, undefined);
	assert.ok(!card.classList.contains("pa-pulse"));
	assert.equal(timers.length, 0);
});

test("a re-render during the pulse keeps it running without restarting it", () => {
	const m = make();
	m.socketNotificationReceived("PACKAGE_STATE", state({ door: present() }));
	render(m);
	advance(1000);
	m.socketNotificationReceived("PACKAGE_STATE", state({ door: present({ description: "x" }) }));
	const card = render(m).children[0];
	assert.ok(card.classList.contains("pa-pulse"));
	assert.equal(card.style.animationDelay, "-1000ms");
	assert.equal(timers.length, 1);
});

test("pulse is not started on the arriving-only card or when the swap has not landed", () => {
	const m = make();
	m.socketNotificationReceived("PACKAGE_STATE", state({ door: present() }));
	liveRoot = null;
	m.notificationReceived("MODULE_DOM_UPDATED", null, undefined);
	assert.equal(m.pulseState, "pending");
	liveRoot = new FakeElement("div"); // old tree still on screen (no door card)
	liveRoot.appendChild(new FakeElement("div"));
	m.notificationReceived("MODULE_DOM_CREATED", null, undefined);
	assert.equal(m.pulseState, "pending");
});

test("spoofed DOM notifications from other modules are ignored", () => {
	const m = make();
	m.socketNotificationReceived("PACKAGE_STATE", state({ door: present() }));
	liveRoot = new FakeElement("div");
	liveRoot.appendChild(m.getDom());
	m.notificationReceived("MODULE_DOM_UPDATED", null, { name: "other" });
	assert.equal(m.pulseState, "pending");
});

test("suspend cancels an active pulse and its timer; resume does not replay it", () => {
	const m = make();
	m.socketNotificationReceived("PACKAGE_STATE", state({ door: present() }));
	const card = render(m).children[0];
	m.hidden = true;
	m.suspend();
	assert.equal(m.pulseState, "none");
	assert.ok(!card.classList.contains("pa-pulse"));
	assert.equal(timers.length, 0);
	m.hidden = false;
	m.resume();
	assert.equal(m.pulseState, "none");
	assert.equal(timers.length, 0);
});

test("a package arriving while suspended pulses once on resume, never while hidden", () => {
	const m = make();
	m.hidden = true;
	m.suspend();
	m.socketNotificationReceived("PACKAGE_STATE", state({ door: present() }));
	liveRoot = new FakeElement("div");
	liveRoot.appendChild(m.getDom());
	m.notificationReceived("MODULE_DOM_UPDATED", null, undefined);
	assert.equal(m.pulseState, "pending");
	assert.equal(timers.length, 0);
	m.hidden = false;
	m.resume();
	assert.equal(m.pulseState, "active");
	assert.equal(timers.length, 1);
	advance(m.PULSE_MS);
	assert.equal(timers.length, 0);
});

test("package cleared while pending or active drops the pulse", () => {
	const m = make();
	m.socketNotificationReceived("PACKAGE_STATE", state({ door: present() }));
	const card = render(m).children[0];
	m.socketNotificationReceived("PACKAGE_STATE", state());
	assert.equal(m.pulseState, "none");
	assert.ok(!card.classList.contains("pa-pulse"));
	assert.equal(timers.length, 0);
	// reappearing pulses again
	m.socketNotificationReceived("PACKAGE_STATE", state({ door: present() }));
	assert.equal(m.pulseState, "pending");
});

test("suspend clears the grace timer and resume re-arms it with the remaining time", () => {
	const m = make({ errorGraceSeconds: 60 });
	m.socketNotificationReceived("PACKAGE_STATE", state({ connected: false, error: { kind: "connection", terminal: false } }));
	assert.equal(timers.length, 1);
	m.hidden = true;
	m.suspend();
	assert.equal(timers.length, 0);
	advance(30000);
	m.hidden = false;
	m.resume();
	assert.equal(timers.length, 1);
	assert.equal(timers[0].at, nowMs + 30000);
	advance(30000);
	assert.match(textOf(m.getDom()), /Reconnecting/);
});

test("resume after the grace elapsed while hidden shows the status without a timer", () => {
	const m = make({ errorGraceSeconds: 10 });
	m.socketNotificationReceived("PACKAGE_STATE", state({ connected: false, error: { kind: "connection", terminal: false } }));
	m.hidden = true;
	m.suspend();
	advance(60000);
	m.hidden = false;
	m.resume();
	assert.equal(timers.length, 0);
	assert.match(textOf(m.getDom()), /Reconnecting/);
	assert.deepEqual(m.domUpdates.slice(-1), [0]);
});

test("a dropped resume() is recovered by MODULE_DOM_UPDATED while visible", () => {
	const m = make();
	m.hidden = true;
	m.suspend();
	m.hidden = false; // MM started the show fade but never called resume()
	m.socketNotificationReceived("PACKAGE_STATE", state({ door: present() }));
	const card = render(m).children[0];
	assert.equal(m.suspended, false);
	assert.ok(card.classList.contains("pa-pulse"));
});

test("no timers are left behind after a full lifecycle", () => {
	const m = make();
	m.socketNotificationReceived("PACKAGE_STATE", state({ door: present() }));
	render(m);
	m.socketNotificationReceived("PACKAGE_STATE", state({ connected: false, error: { kind: "connection", terminal: false } }));
	m.hidden = true;
	m.suspend();
	m.hidden = false;
	m.resume();
	m.socketNotificationReceived("PACKAGE_STATE", state());
	m.hidden = true;
	m.suspend();
	assert.equal(timers.length, 0);
});

test("getDom is side-effect free: rendering twice yields equal trees and no timers or state change", () => {
	const m = make();
	m.socketNotificationReceived("PACKAGE_STATE", state({ door: present(), arriving: [{ carrier: "ups", tracking: "ABCDEF1234" }] }));
	const before = m.pulseState;
	const a = textOf(m.getDom());
	const b = textOf(m.getDom());
	assert.equal(a, b);
	assert.equal(m.pulseState, before);
	assert.equal(timers.length, 0);
});

test("setup errors are named at once and never print the helper's message", () => {
	const m = make();
	m.socketNotificationReceived("PACKAGE_STATE", state({ error: { kind: "config", message: "token abc", terminal: true } }));
	assert.match(textOf(m.getDom()), /URL or token is missing/);
	m.socketNotificationReceived("PACKAGE_STATE", state({ error: { kind: "entities", message: "sensor.x missing", terminal: false } }));
	const text = textOf(m.getDom());
	assert.match(text, /Package sensors not found/);
	assert.doesNotMatch(text, /sensor\.x/);
	assert.equal(timers.length, 0);
});

test("an unknown error kind is treated as a connection outage (silent during grace)", () => {
	const m = make();
	m.socketNotificationReceived("PACKAGE_STATE", state({ error: { kind: "<b>x</b>", terminal: false } }));
	assert.equal(m.getDom().children.length, 0);
});
