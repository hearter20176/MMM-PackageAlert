"use strict";

// Overlay anchoring and arrivingCount tests for MMM-PackageAlert.js (fake DOM, observer, window).

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
		return findAll(this, sel.replace(/^\./, ""))[0] || null;
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

class FakeResizeObserver {
	constructor (cb) {
		this.cb = cb;
		this.observed = new Set();
		FakeResizeObserver.all.push(this);
	}

	observe (el) {
		this.observed.add(el);
	}

	disconnect () {
		this.observed.clear();
	}
}
FakeResizeObserver.all = [];

let definition = null;
global.Module = { register (name, def) { definition = def; } };
global.Log = { info () {}, warn () {}, error () {} };

let liveRoot = null;
let anchorOnPage = null;
let listeners = [];
global.document = {
	createElement: (tag) => new FakeElement(tag),
	getElementById: () => liveRoot,
	querySelector: () => anchorOnPage
};

let timers = [];
let nowMs = 0;
const realSetTimeout = global.setTimeout;
const realClearTimeout = global.clearTimeout;
const realNow = Date.now;

require(path.join(__dirname, "..", "MMM-PackageAlert.js"));
const spec = definition;

function make (config = {}) {
	const m = Object.create(spec);
	m.identifier = "module_1_MMM-PackageAlert";
	m.hidden = false;
	m.config = Object.assign({}, spec.defaults, config);
	m.sendSocketNotification = () => {};
	m.sendNotification = () => {};
	m.updateDom = () => {};
	m.start();
	return m;
}

function render (m) {
	liveRoot = new FakeElement("div");
	liveRoot.appendChild(m.getDom());
	m.notificationReceived("MODULE_DOM_UPDATED", null, undefined);
	return liveRoot.children[0];
}

const mkAnchor = (bottom, height = 80) => ({
	isConnected: true,
	rect: { bottom, height },
	getBoundingClientRect () { return this.rect; }
});
const present = () => ({ state: "present", since: new Date(nowMs - 3600000).toISOString(), source: "camera", carrier: null });
const state = (over = {}) => Object.assign({ door: { state: "clear" }, arriving: [], connected: true, error: null }, over);
const liveObserved = () => FakeResizeObserver.all.reduce((n, o) => n + o.observed.size, 0);

beforeEach(() => {
	timers = [];
	nowMs = new Date(2026, 9, 1, 15, 0, 0).getTime();
	liveRoot = null;
	anchorOnPage = mkAnchor(100);
	listeners = [];
	FakeResizeObserver.all = [];
	global.ResizeObserver = FakeResizeObserver;
	global.window = {
		addEventListener: (n, f) => listeners.push([n, f]),
		removeEventListener: (n, f) => {
			const i = listeners.findIndex((l) => l[0] === n && l[1] === f);
			if (i >= 0) listeners.splice(i, 1);
		}
	};
	global.setTimeout = (fn, ms) => {
		const t = { at: nowMs + ms, fn };
		timers.push(t);
		return t;
	};
	global.clearTimeout = (t) => {
		timers = timers.filter((x) => x !== t);
	};
	Date.now = () => nowMs;
});

afterEach(() => {
	delete global.ResizeObserver;
	delete global.window;
	global.setTimeout = realSetTimeout;
	global.clearTimeout = realClearTimeout;
	Date.now = realNow;
});

// ---- arrivingCount ----

test("the label uses arrivingCount when it exceeds the list length", () => {
	const m = make();
	m.socketNotificationReceived("PACKAGE_STATE", state({ arrivingCount: 30, arriving: [{ carrier: "ups", tracking: "ABCD1234" }] }));
	assert.match(textOf(m.getDom()), /Arriving today: 30 -/);
});

test("arrivingCount above 0 shows the line even if the list is empty", () => {
	const m = make();
	m.socketNotificationReceived("PACKAGE_STATE", state({ arrivingCount: 2, arriving: [] }));
	assert.match(textOf(m.getDom()), /Arriving today: 2/);
});

test("missing or invalid arrivingCount falls back to the list length; zero hides", () => {
	const items = [{ carrier: "ups", tracking: "" }, { carrier: "dhl", tracking: "" }];
	for (const bad of [undefined, null, "3", -1, NaN, {}]) {
		const m = make();
		m.socketNotificationReceived("PACKAGE_STATE", state({ arrivingCount: bad, arriving: items }));
		assert.match(textOf(m.getDom()), /Arriving today: 2/, String(bad));
	}
	const m = make();
	m.socketNotificationReceived("PACKAGE_STATE", state({ arrivingCount: 0, arriving: [] }));
	assert.equal(m.getDom().children.length, 0);
});

// ---- Overlay anchoring ----

test("overlayTop auto places the card 12px under the anchor and follows resizes", () => {
	const m = make();
	m.socketNotificationReceived("PACKAGE_STATE", state({ door: present() }));
	const card = render(m).children[0];
	assert.equal(card.style.top, "112px");
	assert.equal(liveObserved(), 1);
	assert.equal(listeners.length, 1);
	anchorOnPage.rect = { bottom: 140, height: 120 };
	FakeResizeObserver.all[0].cb();
	assert.equal(card.style.top, "152px");
	assert.equal(m.getDom().children[0].style.top, "152px");
	anchorOnPage.rect = { bottom: 90, height: 60 };
	listeners[0][1]();
	assert.equal(card.style.top, "102px");
});

test("falls back to 24px when the anchor is missing and picks it up later", () => {
	const anchor = anchorOnPage;
	anchorOnPage = null;
	const m = make();
	m.socketNotificationReceived("PACKAGE_STATE", state({ door: present() }));
	const card = render(m).children[0];
	assert.equal(card.style.top, "24px");
	assert.equal(liveObserved(), 0);
	anchorOnPage = anchor;
	m.notificationReceived("MODULE_DOM_UPDATED", null, undefined);
	assert.equal(card.style.top, "112px");
	assert.equal(liveObserved(), 1);
});

test("a replaced anchor element is re-observed, not stacked", () => {
	const first = anchorOnPage;
	const m = make();
	m.socketNotificationReceived("PACKAGE_STATE", state({ door: present() }));
	render(m);
	anchorOnPage = mkAnchor(200);
	for (let i = 0; i < 5; i++) m.notificationReceived("MODULE_DOM_UPDATED", null, undefined);
	assert.equal(liveObserved(), 1);
	assert.ok(FakeResizeObserver.all.every((o) => !o.observed.has(first)));
	assert.equal(m.topPx, 212);
	assert.equal(FakeResizeObserver.all.length, 1);
	assert.equal(listeners.length, 1);
});

test("a zero-size anchor (not laid out) uses the fallback", () => {
	anchorOnPage = mkAnchor(0, 0);
	const m = make();
	m.socketNotificationReceived("PACKAGE_STATE", state({ door: present() }));
	assert.equal(render(m).children[0].style.top, "24px");
});

test("a numeric overlayTop is forced and nothing is observed", () => {
	const m = make({ overlayTop: 300 });
	m.socketNotificationReceived("PACKAGE_STATE", state({ door: present() }));
	assert.equal(render(m).children[0].style.top, "300px");
	assert.equal(liveObserved(), 0);
	assert.equal(listeners.length, 0);
});

test("suspend disconnects the observer and the resize listener; resume restores them", () => {
	const m = make();
	m.socketNotificationReceived("PACKAGE_STATE", state({ door: present() }));
	render(m);
	m.hidden = true;
	m.suspend();
	assert.equal(liveObserved(), 0);
	assert.equal(listeners.length, 0);
	m.notificationReceived("MODULE_DOM_UPDATED", null, undefined);
	assert.equal(liveObserved(), 0);
	assert.equal(listeners.length, 0);
	m.hidden = false;
	m.resume();
	assert.equal(liveObserved(), 1);
	assert.equal(listeners.length, 1);
	m.hidden = true;
	m.suspend();
	assert.equal(liveObserved(), 0);
	assert.equal(listeners.length, 0);
});

test("a throwing anchorSelector lookup does not break rendering", () => {
	global.document.querySelector = () => { throw new Error("bad selector"); };
	try {
		const m = make({ anchorSelector: "!!" });
		m.socketNotificationReceived("PACKAGE_STATE", state({ door: present() }));
		assert.doesNotThrow(() => render(m));
		assert.equal(m.topPx, 24);
	} finally {
		global.document.querySelector = () => anchorOnPage;
	}
});

test("works without ResizeObserver or window", () => {
	delete global.ResizeObserver;
	delete global.window;
	const m = make();
	m.socketNotificationReceived("PACKAGE_STATE", state({ door: present() }));
	assert.equal(render(m).children[0].style.top, "112px");
	assert.doesNotThrow(() => m.suspend());
});

test("the card is a compact single main row plus at most one arriving row", () => {
	const m = make();
	m.socketNotificationReceived("PACKAGE_STATE", state({
		door: Object.assign(present(), { source: "email", carrier: "ups" }),
		arrivingCount: 6,
		arriving: Array.from({ length: 6 }, (_, n) => ({ carrier: "fedex", tracking: "TRK00000" + n }))
	}));
	const dom = m.getDom();
	assert.equal(findAll(dom, "pa-door").length, 1);
	assert.equal(findAll(dom, "pa-arriving").length, 1);
	assert.equal(findAll(dom, "pa-chip").length, 4);
	assert.match(textOf(dom), /\+3/);
});

// ---- Anchor replaced by its own module (MMM-GlassClock re-renders its card at midnight) ----

const withWrapper = (anchor, wrapper) => {
	anchor.closest = (sel) => (sel === ".module" ? wrapper : null);
	return anchor;
};

test("a replaced anchor card moves the overlay via the wrapper observer, without a state change", () => {
	const wrapper = { name: "wrapper" };
	const first = withWrapper(mkAnchor(100), wrapper);
	anchorOnPage = first;
	const m = make();
	m.socketNotificationReceived("PACKAGE_STATE", state({ door: present() }));
	const card = render(m).children[0];
	assert.equal(card.style.top, "112px");
	const observer = FakeResizeObserver.all[0];
	assert.ok(observer.observed.has(first) && observer.observed.has(wrapper));

	// The other module swaps in a taller card: old one detaches, wrapper resizes.
	first.isConnected = false;
	const second = withWrapper(mkAnchor(180, 160), wrapper);
	anchorOnPage = second;
	observer.cb();
	assert.equal(card.style.top, "192px");
	assert.equal(FakeResizeObserver.all.length, 1);
	assert.equal(liveObserved(), 2);
	assert.ok(!observer.observed.has(first));
	assert.ok(observer.observed.has(second) && observer.observed.has(wrapper));

	// The new card then resizes on its own and is followed.
	second.rect = { bottom: 210, height: 190 };
	observer.cb();
	assert.equal(card.style.top, "222px");
});

test("a detached anchor is re-queried on window resize and the observer is re-bound once", () => {
	const wrapper = {};
	const first = withWrapper(mkAnchor(100), wrapper);
	anchorOnPage = first;
	const m = make();
	m.socketNotificationReceived("PACKAGE_STATE", state({ door: present() }));
	const card = render(m).children[0];
	first.isConnected = false;
	anchorOnPage = withWrapper(mkAnchor(300), wrapper);
	listeners[0][1]();
	listeners[0][1]();
	assert.equal(card.style.top, "312px");
	assert.equal(FakeResizeObserver.all.length, 1);
	assert.equal(liveObserved(), 2);
});

test("a detached anchor with no replacement falls back and recovers when it returns", () => {
	const first = mkAnchor(100);
	anchorOnPage = first;
	const m = make();
	m.socketNotificationReceived("PACKAGE_STATE", state({ door: present() }));
	const card = render(m).children[0];
	first.isConnected = false;
	anchorOnPage = null;
	FakeResizeObserver.all[0].cb();
	assert.equal(card.style.top, "24px");
	assert.equal(liveObserved(), 0);
	anchorOnPage = mkAnchor(250);
	m.notificationReceived("MODULE_DOM_UPDATED", null, undefined);
	assert.equal(card.style.top, "262px");
	assert.equal(liveObserved(), 1);
});

test("suspend releases both the card and wrapper observations", () => {
	const wrapper = {};
	anchorOnPage = withWrapper(mkAnchor(100), wrapper);
	const m = make();
	m.socketNotificationReceived("PACKAGE_STATE", state({ door: present() }));
	render(m);
	assert.equal(liveObserved(), 2);
	m.hidden = true;
	m.suspend();
	assert.equal(liveObserved(), 0);
	assert.equal(listeners.length, 0);
});
