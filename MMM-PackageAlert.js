/* MMM-PackageAlert
 *
 * Slim glass banner that floats over the page, just under the clock card:
 * "Package at the front door" (from Home Assistant, via node_helper) plus a
 * softer "Arriving today" line from delivery emails. The module's own region
 * wrapper has zero height in every state, so showing or hiding the banner never
 * moves any other module. With nothing to say it renders nothing at all.
 *
 * This file never talks to Home Assistant: it only exchanges socket
 * notifications with node_helper (PACKAGE_CONFIG out, PACKAGE_STATE in).
 */

// Fixed lookups: carrier keys come from Home Assistant, but class names and display
// names are never built from them. Anything not an own key here falls back.
var PACKAGE_ALERT_CARRIERS = {
	usps: { name: "USPS", icon: "fa-brands fa-usps" },
	ups: { name: "UPS", icon: "fa-brands fa-ups" },
	fedex: { name: "FedEx", icon: "fa-brands fa-fedex" },
	dhl: { name: "DHL", icon: "fa-brands fa-dhl" },
	amazon: { name: "Amazon", icon: "fa-brands fa-amazon" },
	ontrac: { name: "OnTrac", icon: "fa-solid fa-truck-fast" },
	other: { name: "", icon: "fa-solid fa-truck-fast" }
};
var PACKAGE_ALERT_NO_CARRIER_ICON = "fa-solid fa-box";

Module.register("MMM-PackageAlert", {
	defaults: {
		// --- Home Assistant (read by node_helper only; this file never renders or logs them) ---
		haUrl: "",
		haToken: "",
		haTokenFile: "",
		doorEntity: "sensor.front_door_package",
		deliveriesEntity: "sensor.package_deliveries",

		// --- Display ---
		showArriving: true,
		// "masked" (last 4 characters), "full", or "none"
		showTracking: "masked",
		// Cap on tracking chips shown in the arriving row (the rest become "+N")
		maxTracking: 3,
		// 12 or 24
		timeFormat: 12,
		// Browser locale when empty
		locale: "",
		animationSpeed: 1000,
		// A non-terminal Home Assistant outage is only mentioned after this many seconds
		// (a stale "no package" is not trustworthy after that). Setup errors show at once.
		errorGraceSeconds: 60,

		// --- Overlay position ---
		// "auto" places the banner just under anchorSelector; a number forces that many px from the top.
		overlayTop: "auto",
		anchorSelector: ".module.MMM-GlassClock .glass-clock-card",
		anchorGap: 12,
		// Used when overlayTop is "auto" and the anchor is not on the page
		fallbackTop: 24
	},

	// One gentle pulse when a package first appears; length matches the CSS animation.
	PULSE_MS: 2600,
	MAX_TEXT: 160,

	getStyles () {
		// MagicMirror's vendored Font Awesome 7 free (solid + brands) for the carrier icons
		return ["font-awesome.css", "MMM-PackageAlert.css"];
	},

	start () {
		this.door = null;
		this.arriving = [];
		this.arrivingCount = 0;
		this.error = null;
		this.lastPresent = false;
		this.suspended = false;

		// "none" | "pending" (package appeared, not yet on screen) | "active"
		this.pulseState = "none";
		this.pulseStartedAt = 0;
		this.pulseTimer = null;

		this.disconnectedSince = 0;
		this.graceTimer = null;

		this.topPx = this._configuredTop();
		this.anchorEl = null;
		this.resizeObserver = null;
		this.onWindowResize = null;

		this.sendSocketNotification("PACKAGE_CONFIG", this.config);
	},

	suspend () {
		this.suspended = true;
		this._endPulse();
		this._clearGraceTimer();
		this._unwatchAnchor();
	},

	resume () {
		this.suspended = false;
		this._armGrace();
		this._watchAnchor();
		this._startPulse();
		this.updateDom(0);
	},

	notificationReceived (notification, payload, sender) {
		if (notification !== "MODULE_DOM_CREATED" && notification !== "MODULE_DOM_UPDATED") return;
		// MM sends these only to the module they concern; ignore anything spoofed by another module.
		if (sender) return;
		// MM can drop the resume() callback when a render lands inside the show fade; the module
		// is visibly on screen, so stop treating it as suspended.
		if (this.suspended && this.hidden === false) {
			this.suspended = false;
			this._armGrace();
		}
		this._watchAnchor();
		this._startPulse();
	},

	socketNotificationReceived (notification, payload) {
		if (notification !== "PACKAGE_STATE") return;
		if (!payload || typeof payload !== "object") return;

		var door = this._cleanDoor(payload.door);
		var present = !!door && door.state === "present";
		var wasPresent = this.lastPresent;

		this.door = door;
		this.arriving = this._cleanItems(payload.arriving);
		this.arrivingCount = this._cleanCount(payload.arrivingCount, this.arriving.length);
		this.error = this._cleanError(payload.error);

		if (present && !wasPresent) {
			this.pulseState = "pending";
		} else if (!present) {
			this._endPulse();
			this.pulseState = "none";
		}

		this._trackConnection();

		// Transitions only. A package already there on the first snapshot counts as one (other
		// modules may have started after us); "clear" at startup is silent.
		if (present !== wasPresent) {
			this.lastPresent = present;
			this.sendNotification("PACKAGE_AT_DOOR", { present: present });
		}

		this.updateDom(this.config.animationSpeed);
	},

	// ---- State cleaning (everything here came from Home Assistant: treat as untrusted text) ----

	_text (value) {
		if (typeof value !== "string" && typeof value !== "number") return "";
		var s = String(value).replace(/\s+/g, " ").trim();
		return s.length > this.MAX_TEXT ? s.slice(0, this.MAX_TEXT) : s;
	},

	// Returns a key of PACKAGE_ALERT_CARRIERS, "" for no carrier, or "other" for anything unknown.
	_carrierKey (value) {
		var key = this._text(value).toLowerCase();
		if (!key || key === "null") return "";
		return Object.prototype.hasOwnProperty.call(PACKAGE_ALERT_CARRIERS, key) ? key : "other";
	},

	_carrierIcon (key) {
		return key ? PACKAGE_ALERT_CARRIERS[key].icon : PACKAGE_ALERT_NO_CARRIER_ICON;
	},

	_cleanDoor (door) {
		if (!door || typeof door !== "object") return null;
		return {
			state: this._text(door.state).toLowerCase(),
			since: this._text(door.since),
			source: this._text(door.source).toLowerCase(),
			carrier: this._carrierKey(door.carrier)
		};
	},

	_cleanItems (list) {
		if (!Array.isArray(list)) return [];
		var out = [];
		for (var i = 0; i < list.length; i++) {
			var item = list[i];
			if (!item || typeof item !== "object") continue;
			out.push({
				carrier: this._carrierKey(item.carrier),
				tracking: this._text(item.tracking)
			});
		}
		return out;
	},

	// The helper sends the sensor state as arrivingCount; fall back to the list length.
	_cleanCount (value, fallback) {
		var n = typeof value === "number" ? value : NaN;
		if (!isFinite(n) || n < 0) return fallback;
		return Math.min(Math.floor(n), 999);
	},

	_cleanError (error) {
		if (!error || typeof error !== "object") return null;
		var kind = this._text(error.kind);
		if (["config", "auth", "connection", "entities"].indexOf(kind) === -1) kind = "connection";
		return { kind: kind, terminal: error.terminal === true };
	},

	// ---- Outage grace handling ----

	// Records when a non-terminal outage began; the status line appears once the grace is over.
	_trackConnection () {
		var down = !!this.error && this._isOutage();
		if (!down) {
			this.disconnectedSince = 0;
			this._clearGraceTimer();
			return;
		}
		if (!this.disconnectedSince) this.disconnectedSince = Date.now();
		this._armGrace();
	},

	// A reachability problem (as opposed to a setup problem that will not fix itself).
	_isOutage () {
		return !this.error.terminal && this.error.kind === "connection";
	},

	_graceLeft () {
		return this.config.errorGraceSeconds * 1000 - (Date.now() - this.disconnectedSince);
	},

	_armGrace () {
		this._clearGraceTimer();
		if (!this.disconnectedSince || this._isSuspended()) return;
		var wait = this._graceLeft();
		if (wait <= 0) return;
		var self = this;
		this.graceTimer = setTimeout(function () {
			self.graceTimer = null;
			self.updateDom(self.config.animationSpeed);
		}, wait);
	},

	_clearGraceTimer () {
		if (this.graceTimer) {
			clearTimeout(this.graceTimer);
			this.graceTimer = null;
		}
	},

	// MM drops resume() callbacks in some show-fade races, so "suspended" only counts while
	// MM also reports the module hidden.
	_isSuspended () {
		return this.suspended && this.hidden !== false;
	},

	// ---- Overlay anchor (banner sits just under the clock card) ----

	_configuredTop () {
		var top = this.config.overlayTop;
		if (typeof top === "number" && isFinite(top)) return top;
		return Number(this.config.fallbackTop) || 24;
	},

	_isAuto () {
		return this.config.overlayTop === "auto";
	},

	// Measures the anchor and, when the result changed, moves the live card. Never re-renders.
	// If the cached anchor was detached (its module re-rendered), it is looked up again first.
	_measure () {
		if (!this._isAuto()) return;
		if (this.anchorEl && this.anchorEl.isConnected === false) this._bindAnchor();
		var top = Number(this.config.fallbackTop) || 24;
		var anchor = this.anchorEl;
		if (anchor && typeof anchor.getBoundingClientRect === "function") {
			var rect = anchor.getBoundingClientRect();
			if (rect && isFinite(rect.bottom) && rect.height > 0) {
				top = Math.round(rect.bottom + (Number(this.config.anchorGap) || 0));
			}
		}
		if (top === this.topPx) return;
		this.topPx = top;
		var card = this._liveCard();
		if (card) card.style.top = top + "px";
	},

	// Finds the anchor and, when it is a different element than before, moves the single
	// ResizeObserver over to it. The anchor's module wrapper is observed too: when the other
	// module replaces its card, the old element stops reporting but the wrapper still resizes.
	_bindAnchor () {
		var anchor;
		try {
			anchor = document.querySelector(this.config.anchorSelector);
		} catch (e) {
			anchor = null;
		}
		if (anchor === this.anchorEl) return;
		if (this.resizeObserver) this.resizeObserver.disconnect();
		this.anchorEl = anchor;
		if (!anchor || typeof ResizeObserver !== "function") return;
		var self = this;
		if (!this.resizeObserver) {
			this.resizeObserver = new ResizeObserver(function () {
				self._measure();
			});
		}
		this.resizeObserver.observe(anchor);
		var wrapper = typeof anchor.closest === "function" ? anchor.closest(".module") : null;
		if (wrapper && wrapper !== anchor) this.resizeObserver.observe(wrapper);
	},

	// Starts observing and listens for window resizes. Released in _unwatchAnchor().
	_watchAnchor () {
		if (!this._isAuto() || this._isSuspended()) return;
		this._bindAnchor();
		var self = this;
		if (!this.onWindowResize && typeof window !== "undefined" && window.addEventListener) {
			this.onWindowResize = function () {
				self._bindAnchor();
				self._measure();
			};
			window.addEventListener("resize", this.onWindowResize);
		}
		this._measure();
	},

	_unwatchAnchor () {
		if (this.resizeObserver) {
			this.resizeObserver.disconnect();
			this.resizeObserver = null;
		}
		this.anchorEl = null;
		if (this.onWindowResize && typeof window !== "undefined" && window.removeEventListener) {
			window.removeEventListener("resize", this.onWindowResize);
		}
		this.onWindowResize = null;
	},

	// ---- Pulse (finite, cancelled on suspend; applied to the live card, not via getDom) ----

	_liveCard () {
		var wrapper = document.getElementById(this.identifier);
		if (!wrapper) return null;
		return wrapper.querySelector(".pa-card");
	},

	_startPulse () {
		if (this.pulseState !== "pending" || this._isSuspended()) return;
		var card = this._liveCard();
		if (!card || card.className.split(/\s+/).indexOf("pa-card-door") === -1) return;
		this.pulseState = "active";
		this.pulseStartedAt = Date.now();
		card.classList.add("pa-pulse");
		var self = this;
		this.pulseTimer = setTimeout(function () {
			self.pulseTimer = null;
			self._endPulse();
		}, this.PULSE_MS);
	},

	_endPulse () {
		if (this.pulseTimer) {
			clearTimeout(this.pulseTimer);
			this.pulseTimer = null;
		}
		if (this.pulseState === "active") {
			this.pulseState = "none";
			var card = this._liveCard();
			if (card) card.classList.remove("pa-pulse");
		}
	},

	// ---- Formatting ----

	_formatSince (iso) {
		var ms = Date.parse(iso);
		if (!iso || isNaN(ms)) return "";
		var then = new Date(ms);
		var now = new Date(Date.now()); // one clock source (Date.now) for all time logic
		var locale = this.config.locale || undefined;
		var time;
		try {
			time = then.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit", hour12: Number(this.config.timeFormat) !== 24 });
		} catch (e) {
			time = then.toLocaleTimeString();
		}
		var startOf = function (d) {
			return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
		};
		var days = Math.round((startOf(now) - startOf(then)) / 86400000);
		if (days <= 0) return time;
		if (days === 1) return "yesterday " + time;
		var day;
		try {
			day = then.toLocaleDateString(locale, days < 7 ? { weekday: "short" } : { month: "short", day: "numeric" });
		} catch (e) {
			day = then.toDateString();
		}
		return day + " " + time;
	},

	_sourceText (door) {
		if (door.source === "camera") return "doorbell camera";
		if (door.source === "email") {
			var name = door.carrier ? PACKAGE_ALERT_CARRIERS[door.carrier].name : "";
			return name ? "delivery email from " + name : "delivery email";
		}
		return "";
	},

	_maskTracking (tracking) {
		if (this.config.showTracking === "full") return tracking;
		if (tracking.length <= 4) return "****";
		return "***" + tracking.slice(-4);
	},

	// Distinct, named carriers in first-seen order (keys, not display names).
	_carriers () {
		var seen = {};
		var list = [];
		for (var i = 0; i < this.arriving.length; i++) {
			var c = this.arriving[i].carrier;
			if (c && PACKAGE_ALERT_CARRIERS[c].name && !seen[c]) {
				seen[c] = true;
				list.push(c);
			}
		}
		return list;
	},

	// ---- DOM ----

	_el (tag, className, text) {
		var el = document.createElement(tag);
		if (className) el.className = className;
		if (text) el.textContent = text;
		return el;
	},

	_icon (key, extra) {
		var el = this._el("i", this._carrierIcon(key) + " pa-carrier-icon" + (extra ? " " + extra : ""));
		el.setAttribute("aria-hidden", "true");
		return el;
	},

	_statusText () {
		if (!this.error) return "";
		if (this.error.kind === "auth") return "Home Assistant login failed - check the access token";
		if (this.error.kind === "config") return "Home Assistant URL or token is missing or invalid";
		if (this.error.kind === "entities") return "Package sensors not found in Home Assistant";
		if (this.disconnectedSince && this._graceLeft() <= 0) {
			return "Reconnecting to Home Assistant - package status may be out of date";
		}
		return "";
	},

	getDom () {
		var root = this._el("div", "pa-root");
		try {
			var present = !!this.door && this.door.state === "present";
			var arrivingOn = this.config.showArriving && this.arrivingCount > 0;
			var status = this._statusText();

			if (!present && !arrivingOn && !status) {
				root.className = "pa-root pa-empty";
				return root;
			}

			var card = this._el("div", "pa-card" + (present ? " pa-card-door" : ""));
			card.style.top = this.topPx + "px";
			if (present && this.pulseState === "active") {
				// A re-render during the pulse must not restart it: resume the animation mid-way.
				card.className += " pa-pulse";
				card.style.animationDelay = "-" + Math.max(0, Date.now() - this.pulseStartedAt) + "ms";
			}

			if (present) card.appendChild(this._doorRow());
			if (arrivingOn) card.appendChild(this._arrivingRow());
			if (status) {
				card.appendChild(this._el("div", "pa-status" + (this.error.kind !== "connection" ? " pa-status-error" : ""), status));
			}
			root.appendChild(card);
		} catch (e) {
			// A bad payload must never break the render: show nothing rather than throw.
			root = this._el("div", "pa-root pa-empty");
		}
		return root;
	},

	_doorRow () {
		var row = this._el("div", "pa-door");
		row.appendChild(this._icon(this.door.carrier, "pa-door-icon"));
		row.appendChild(this._el("span", "pa-title", "Package at the front door"));

		var parts = [];
		var since = this._formatSince(this.door.since);
		if (since) parts.push("Since " + since);
		var source = this._sourceText(this.door);
		if (source) parts.push(source);
		if (parts.length) row.appendChild(this._el("span", "pa-detail", parts.join(" · ")));
		return row;
	},

	_arrivingRow () {
		var row = this._el("div", "pa-arriving");
		var carriers = this._carriers();
		var label = this._el("div", "pa-arriving-label");
		label.appendChild(this._el("span", "pa-arriving-count", "Arriving today: " + this.arrivingCount + (carriers.length ? " -" : "")));
		for (var c = 0; c < carriers.length; c++) {
			var group = this._el("span", "pa-carrier");
			group.appendChild(this._icon(carriers[c]));
			group.appendChild(this._el("span", "pa-carrier-name", PACKAGE_ALERT_CARRIERS[carriers[c]].name + (c < carriers.length - 1 ? "," : "")));
			label.appendChild(group);
		}
		row.appendChild(label);

		if (this.config.showTracking !== "none") {
			var numbers = [];
			for (var i = 0; i < this.arriving.length; i++) {
				if (this.arriving[i].tracking) numbers.push(this.arriving[i]);
			}
			if (numbers.length) {
				var max = Math.max(1, Number(this.config.maxTracking) || 3);
				var list = this._el("div", "pa-tracking");
				for (var j = 0; j < numbers.length && j < max; j++) {
					var chip = this._el("span", "pa-chip");
					chip.appendChild(this._icon(numbers[j].carrier));
					chip.appendChild(this._el("span", "pa-chip-text", this._maskTracking(numbers[j].tracking)));
					list.appendChild(chip);
				}
				if (numbers.length > max) {
					list.appendChild(this._el("span", "pa-chip pa-chip-more", "+" + (numbers.length - max)));
				}
				row.appendChild(list);
			}
		}
		return row;
	}
});
