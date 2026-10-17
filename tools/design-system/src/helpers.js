  // ── Kelpie.ui: what every preview shares ────────────────────────────────────────────────────
  // Motion reads its values from the tokens (tokens.css), so a value changed in the system
  // changes every preview. Reduced motion replaces movement with a short fade (rule 10).
  var ui = (function () {
    var root = document.documentElement;
    var KEEP = ["opacity", "offset", "color", "backgroundColor", "borderColor"];
    var mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    function token(name) {
      return getComputedStyle(root).getPropertyValue("--" + name).trim();
    }
    function num(name, fallback) {
      var v = parseFloat(token(name));
      return isNaN(v) ? fallback : v;
    }
    function reduced() {
      return mq.matches || root.hasAttribute("data-reduced");
    }
    function spring(name) {
      return {
        duration: num("spring-" + name + "-dur", 266),
        easing: token("spring-" + name) || "ease-out",
      };
    }
    function ease(name) {
      return token("ease-" + name) || "ease-out";
    }
    // o: { spring } or { dur, ease }, plus delay, fill, essential (progress keeps moving).
    function animate(el, frames, o) {
      o = o || {};
      var timing = o.spring
        ? spring(o.spring)
        : { duration: o.dur != null ? o.dur : num("dur-fade", 150), easing: o.ease || ease("standard") };
      var fr = frames;
      if (reduced() && !o.essential) {
        fr = frames.map(function (f) {
          var g = {};
          KEEP.forEach(function (k) {
            if (k in f) g[k] = f[k];
          });
          return g;
        });
        timing = { duration: Math.min(timing.duration, num("dur-fade", 150)), easing: ease("fade") };
      }
      return el.animate(fr, {
        duration: timing.duration,
        easing: timing.easing,
        delay: o.delay || 0,
        fill: o.fill || "backwards",
      });
    }
    // Enters from below and a little smaller; the moment grammar travels farther.
    function enter(el, o) {
      o = o || {};
      var rise = o.y != null ? o.y : num(o.moment ? "rise-moment" : "rise", 8);
      var scale = o.scale != null ? o.scale : num(o.moment ? "scale-in-moment" : "scale-in", 0.97);
      return animate(
        el,
        [
          { opacity: 0, transform: "translate(" + (o.x || 0) + "px, " + rise + "px) scale(" + scale + ")" },
          { opacity: 1, transform: "none" },
        ],
        { spring: o.spring || (o.moment ? "moment" : "base"), delay: o.delay },
      );
    }
    // Leaving is faster than arriving (rule 9).
    function exit(el, o) {
      o = o || {};
      return animate(
        el,
        [
          { opacity: 1, transform: "none" },
          { opacity: 0, transform: "translate(0px, " + (o.y != null ? o.y : -4) + "px) scale(" + (o.scale || 0.985) + ")" },
        ],
        { dur: num(o.moment ? "dur-exit-moment" : "dur-exit", 120), ease: ease("exit"), fill: "forwards", delay: o.delay },
      );
    }
    // A label that rolls: the old one leaves upward, the new one rises (5.2).
    function roll(box, html, o) {
      o = o || {};
      var old = box.lastElementChild;
      var next = document.createElement("span");
      next.className = "n";
      next.innerHTML = html;
      box.append(next);
      if (old) {
        animate(old, [{ transform: "none", opacity: 1 }, { transform: "translateY(-75%)", opacity: 0 }], {
          dur: num("dur-exit", 120),
          ease: ease("exit"),
          fill: "forwards",
        }).finished.then(
          function () { old.remove(); },
          function () { old.remove(); },
        );
      }
      animate(next, [{ transform: "translateY(75%)", opacity: 0 }, { transform: "none", opacity: 1 }], {
        spring: o.spring || "fast",
        delay: o.delay,
      });
      return next;
    }
    // A scripted run that a replay cancels: every wait checks it is still current.
    var STOP = {};
    function runner(play) {
      var current = null;
      // A fresh run cancels the one before it; a click takes over with `start.takeover()`.
      function fresh() {
        if (current) {
          current.alive = false;
          current.timers.forEach(clearTimeout);
        }
        var run = {
          alive: true,
          timers: [],
          sleep: function (ms) {
            return new Promise(function (resolve, reject) {
              run.timers.push(
                setTimeout(function () {
                  if (run.alive) resolve();
                  else reject(STOP);
                }, ms),
              );
            });
          },
          later: function (ms, fn) {
            run.timers.push(setTimeout(function () { if (run.alive) fn(); }, ms));
          },
        };
        current = run;
        return run;
      }
      function start() {
        var run = fresh();
        guard(play(run));
        return run;
      }
      start.takeover = fresh;
      return start;
    }
    // Swallows the stop of a cancelled run; anything else still reaches the console.
    function guard(p) {
      Promise.resolve(p).catch(function (e) {
        if (e !== STOP) console.error(e);
      });
    }
    // The webchat's own glyphs (apps/ingress/public/webchat/icons.js), drawn with currentColor.
    var PATHS = {
      clock: ["M8 2.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 1 0 0-11Z", "M8 5v3.2l2 1.3"],
      alert: ["M8 2.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 1 0 0-11Z", "M8 5v3.5", "M8 10.6v.4"],
      check: ["M3.5 8.5l3 3l6-6.5"],
      neutral: ["M8 2.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 1 0 0-11Z", "M5.5 8h5"],
      chevron: ["M4.5 6.5l3.5 3.5l3.5-3.5"],
      close: ["M4.5 4.5l7 7", "M11.5 4.5l-7 7"],
      display: ["M8 2.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 1 0 0-11Z", "M8 2.5v11"],
      // From the webchat's mockup (#378): the composer's Pause and Send, the theme, a lost connection, the strip.
      pause: ["M6 4.5v7", "M10 4.5v7"],
      send: ["M8 13V3.5", "M4 7.5l4-4 4 4"],
      monitor: ["M3.5 3h9A1.5 1.5 0 0 1 14 4.5v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 10V4.5A1.5 1.5 0 0 1 3.5 3Z", "M6 14h4", "M8 11.5V14"],
      sun: ["M8 5.2a2.8 2.8 0 1 0 0 5.6a2.8 2.8 0 1 0 0-5.6Z", "M8 1.8v1.4M8 12.8v1.4M1.8 8h1.4M12.8 8h1.4M3.6 3.6l1 1M11.4 11.4l1 1M3.6 12.4l1-1M11.4 4.6l1-1"],
      moon: ["M13 9.6A5.2 5.2 0 0 1 6.4 3a5.2 5.2 0 1 0 6.6 6.6Z"],
      wifiOff: ["M2 2l12 12", "M5.5 8.6a4 4 0 0 1 4.2-.9", "M3 6.2a7.5 7.5 0 0 1 2.8-1.7", "M10.6 4.6A7.5 7.5 0 0 1 13 6.2", "M7 11a1.5 1.5 0 0 1 2 0"],
      bell: ["M4 11V7.5a4 4 0 0 1 8 0V11l1 1.5H3Z", "M6.5 14h3"],
      // From the §8 research on the comfort controls: text size as letters (Lucide's a-large-small),
      // less motion as a circle with one trail (Material's motion_blur, reduced).
      textSmall: ["M5.48 13.5L8 6.50L10.52 13.5M6.49 10.70H9.51"],
      textLarge: ["M4.04 13.5L8 2.50L11.96 13.5M5.62 9.10H10.38"],
      lessMotion: ["M11 5.25a2.75 2.75 0 1 0 0 5.5a2.75 2.75 0 1 0 0-5.5Z", "M2.75 8h4"],
      // The account's chevron, which opens upward (5.24).
      chevronUp: ["M4.5 9.5L8 6l3.5 3.5"],
      // The agent's editor (5.25, 5.26): the pencil on a mascot, Undo as a U-turn (a circle reads as
      // refresh), Randomize as a die with three pips (a shuffle means reorder), and the main agent's lock.
      pencil: ["M10.5 2.8l2.4 2.4L6.2 11.9l-3 .8.8-3z", "M9.2 4.1l2.4 2.4"],
      undo: ["M5.5 4L2.5 7l3 3", "M2.5 7h7a3.5 3.5 0 0 1 0 7H8"],
      dice: ["M5 2.5h6A2.5 2.5 0 0 1 13.5 5v6a2.5 2.5 0 0 1-2.5 2.5H5A2.5 2.5 0 0 1 2.5 11V5A2.5 2.5 0 0 1 5 2.5Z", { d: "M5.5 4.5a1 1 0 1 0 0 2a1 1 0 1 0 0-2Z", solid: true }, { d: "M8 7a1 1 0 1 0 0 2a1 1 0 1 0 0-2Z", solid: true }, { d: "M10.5 9.5a1 1 0 1 0 0 2a1 1 0 1 0 0-2Z", solid: true }],
      lock: ["M5 7h6a1.5 1.5 0 0 1 1.5 1.5v3.5A1.5 1.5 0 0 1 11 13.5H5A1.5 1.5 0 0 1 3.5 12V8.5A1.5 1.5 0 0 1 5 7Z", "M5.5 7V5a2.5 2.5 0 0 1 5 0v2"],
      // The editor's sections: an ID card, a page with a heart, a list, two stacked notes and a puzzle
      // piece; the Mascot section is the mascot's own outline (pauseIcon("body")). None is a 5.9 glyph.
      profile: ["M3.5 3.5h9A1.5 1.5 0 0 1 14 5v6a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11V5a1.5 1.5 0 0 1 1.5-1.5Z", "M5.8 6a1.3 1.3 0 1 0 0 2.6a1.3 1.3 0 1 0 0-2.6Z", "M4 10.4c.5-.9 1.1-1.3 1.8-1.3s1.3.4 1.8 1.3M9.5 7h3M9.5 9.5h3"],
      soul: ["M4 2.5h5.5l3 3v8H4z", "M9.5 2.5v3h3", "M8.2 11.6s-2-1.2-2-2.5a1 1 0 0 1 2-.5a1 1 0 0 1 2 .5c0 1.3-2 2.5-2 2.5z"],
      rules: ["M6.5 4.5h7M6.5 8h7M6.5 11.5h7", { d: "M3.4 3.6a.9.9 0 1 0 0 1.8a.9.9 0 1 0 0-1.8Z", solid: true }, { d: "M3.4 7.1a.9.9 0 1 0 0 1.8a.9.9 0 1 0 0-1.8Z", solid: true }, { d: "M3.4 10.6a.9.9 0 1 0 0 1.8a.9.9 0 1 0 0-1.8Z", solid: true }],
      memory: ["M5.5 3.5h7v7", "M3.5 5.5h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1Z", "M4.5 8.5h4M4.5 11h3"],
      skills: ["M6.5 3.5h1.7a1.3 1.3 0 0 1 2.6 0h1.7v2.2a1.3 1.3 0 0 1 0 2.6V11h-2.3a1.3 1.3 0 0 0-2.6 0H5.4V8.3a1.3 1.3 0 0 1 0-2.6V3.5z"],
    };
    // More contrast: a rounded square split on its diagonal, never the half-filled circle of "working".
    var CONTRAST = '<rect x="2.75" y="2.75" width="10.5" height="10.5" rx="2.5"/><path d="M13.25 2.75V10.75A2.5 2.5 0 0 1 10.75 13.25H2.75Z" fill="currentColor" stroke="none"/>';
    function icon(name, cls) {
      if (name === "contrast") return '<svg class="k-icon ' + (cls || "") + '" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' + CONTRAST + "</svg>";
      return (
        '<svg class="k-icon ' + (cls || "") + '" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
        (PATHS[name] || []).map(function (d) { return typeof d === "string" ? '<path pathLength="1" d="' + d + '"/>' : '<path d="' + d.d + '" fill="currentColor" stroke="none"/>'; }).join("") +
        "</svg>"
      );
    }
    // The state glyphs of 5.9: they carry the state beside the label, in every theme and in forced colors.
    var GLYPHS = {
      working: '<circle cx="6" cy="6" r="4.6" fill="none"/><path d="M6 1.4a4.6 4.6 0 010 9.2z" stroke="none"/>',
      waiting: '<path d="M6 1l5 5-5 5-5-5z" stroke="none"/>',
      idle: '<circle cx="6" cy="6" r="4.6" fill="none"/>',
      error: '<path d="M6 1.2l5.2 9.4H.8z" stroke="none"/>',
      noResponse: '<circle cx="6" cy="6" r="4.6" fill="none" stroke-dasharray="2.2 1.8"/>',
      offline: '<circle cx="6" cy="6" r="4.6" fill="none"/><path d="M2.4 9.6L9.6 2.4" fill="none"/>',
    };
    function glyph(state) {
      return '<svg class="k-glyph" viewBox="0 0 12 12" aria-hidden="true">' + (GLYPHS[state] || "") + "</svg>";
    }
    // The mascot's pause as icons: its own outline, as the main mascot now looks (round ears, ADR-0049),
    // mid-hop for Alive, with 5.19's badge for States only, standing on a line for Still (#378, decision 8).
    var BODY = '<path d="M9 6.5h2a6 6 0 0 1 6 6v0a5.5 5.5 0 0 1-5.5 5.5H5a2 2 0 0 1-2-2v-3.5a6 6 0 0 1 6-6Z"/><circle cx="5.9" cy="5.1" r="2" fill="currentColor" stroke="none"/><circle cx="14.1" cy="5.1" r="2" fill="currentColor" stroke="none"/><circle cx="8.2" cy="12.4" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="12.4" r="1" fill="currentColor" stroke="none"/>';
    var PAUSE_ICONS = {
      alive: '<g transform="translate(-.6 -1.8) rotate(-9 10 12)">' + BODY + '</g><path d="M6.5 19.2h6"/><path d="M17.2 2.4l.8 1.6M19 5.4l-1.6.6"/>',
      states: '<g transform="translate(-1.2 .9) scale(.9)">' + BODY + '</g><circle cx="16.4" cy="4" r="2.6" fill="currentColor" stroke="none"/>',
      still: '<g transform="translate(0 -.4)">' + BODY + '</g><path d="M3 19.2h14"/>',
      // The editor's Mascot section (5.25): the outline at rest.
      body: '<g transform="translate(0 -1.6)">' + BODY + "</g>",
    };
    function pauseIcon(kind) {
      return '<svg class="k-icon m20" viewBox="0 0 20 20" aria-hidden="true" focusable="false">' + PAUSE_ICONS[kind] + "</svg>";
    }
    // Icon buttons name themselves in a tooltip (5.26): the first waits 400 ms, then rises from 4 px and
    // 0.97 with spring-fast; its neighbours within 300 ms show at once, keyboard focus shows one at once and
    // a click's focus none, a press or Escape hides it without moving focus, the pointer can move onto it,
    // it has no timer and leaves in dur-exit, and nothing uses `title`.
    function tooltips(root) {
      var lastHide = 0, timer = null;
      function show(el, now) {
        clearTimeout(timer);
        var tip = el.querySelector(":scope > .k-tip");
        if (!tip) return;
        tip.classList.toggle("instant", !!now);
        if (now) tip.classList.add("on");
        else timer = setTimeout(function () { tip.classList.add("on"); }, 400);
      }
      function hide(el) {
        clearTimeout(timer);
        var tip = el.querySelector(":scope > .k-tip");
        if (tip && tip.classList.contains("on")) lastHide = performance.now();
        if (tip) tip.classList.remove("on");
      }
      (root || document).querySelectorAll("[data-tip]").forEach(function (el) {
        if (!el.querySelector(":scope > .k-tip")) {
          var t = document.createElement("span");
          t.className = "k-tip text-sm";
          t.setAttribute("aria-hidden", "true");
          t.textContent = el.dataset.tip;
          el.append(t);
        }
        el.addEventListener("pointerenter", function (e) { if (e.pointerType !== "touch") show(el, performance.now() - lastHide < 300); });
        el.addEventListener("pointerleave", function () { hide(el); });
        el.addEventListener("focus", function () { if (el.matches(":focus-visible")) show(el, true); });
        el.addEventListener("blur", function () { hide(el); });
        el.addEventListener("click", function () { hide(el); });
        el.addEventListener("keydown", function (e) {
          var tip = el.querySelector(":scope > .k-tip");
          if (e.key === "Escape" && tip && tip.classList.contains("on")) { e.stopPropagation(); hide(el); }
        });
      });
    }
    // A segmented choice: the indicator slides with spring-fast, the arrows move the choice at once,
    // and each option is a radio. `onPick(value, keyboard, button)` runs on every change.
    function segment(box, onPick) {
      var ind = document.createElement("span");
      ind.className = "k-seg-ind";
      ind.setAttribute("aria-hidden", "true");
      box.prepend(ind);
      box.classList.add("has-ind");
      box.setAttribute("role", "radiogroup");
      var btns = Array.prototype.slice.call(box.querySelectorAll(":scope > button"));
      btns.forEach(function (b) { b.setAttribute("role", "radio"); });
      var current = btns.filter(function (b) { return b.getAttribute("aria-checked") === "true"; })[0] || btns[0];
      function place(b, moving) {
        var x = b.offsetLeft, y = b.offsetTop, w = b.offsetWidth, px = ind._x, py = ind._y, pw = ind._w;
        ind.style.transform = "translate(" + x + "px, " + y + "px)";
        ind.style.width = w + "px";
        ind.style.height = b.offsetHeight + "px";
        if (moving && px != null && (px !== x || py !== y)) {
          animate(ind, [{ transform: "translate(" + px + "px, " + py + "px)", width: pw + "px" }, { transform: "translate(" + x + "px, " + y + "px)", width: w + "px" }], { spring: "fast" });
        }
        ind._x = x; ind._y = y; ind._w = w;
      }
      function pick(b, keyboard, quiet) {
        current = b;
        btns.forEach(function (x) { x.setAttribute("aria-checked", String(x === b)); x.tabIndex = x === b ? 0 : -1; });
        place(b, !keyboard);
        if (!quiet && onPick) onPick(b.dataset.v, keyboard, b);
      }
      box.addEventListener("click", function (e) {
        var b = e.target.closest("button");
        if (!b || b.disabled || btns.indexOf(b) < 0 || b === current) return;
        pick(b, e.detail === 0);
      });
      box.addEventListener("keydown", function (e) {
        var k = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
        if (!k) return;
        e.preventDefault();
        var live = btns.filter(function (b) { return !b.disabled; });
        var i = live.indexOf(current), next = live[(i + k + live.length) % live.length];
        if (next) { pick(next, true); next.focus(); }
      });
      btns.forEach(function (b) { b.tabIndex = b === current ? 0 : -1; });
      requestAnimationFrame(function () { place(current, false); });
      return {
        set: function (v) { var b = btns.filter(function (x) { return x.dataset.v === v; })[0]; if (b) pick(b, true, true); },
        refresh: function () { place(current, false); },
        get value() { return current.dataset.v; },
      };
    }
    // Sample agents for the previews. Kelpie keeps the main agent's default look (5.19, ADR-0049).
    var LOOKS = {
      kelpie: { shape: "mark", color: "kelp", eyes: "big", cheeks: false, head: { type: "ears", variation: "round" }, accessory: { type: "none" } },
      agenda: { shape: "pebble", color: "fawn", eyes: "dots", cheeks: true, head: { type: "ears", variation: "floppy" }, accessory: { type: "bow", variation: "tie" } },
      research: { shape: "bubble", color: "tide", eyes: "marbles", cheeks: false, head: { type: "hair", variation: "strands" }, accessory: { type: "glasses", variation: "round" } },
      code: { shape: "block", color: "slate", eyes: "cyclops", cheeks: false, head: { type: "horns", variation: "antennae" }, accessory: { type: "none" } },
      notes: { shape: "cloud", color: "anemone", eyes: "big", cheeks: true, head: { type: "leaves", variation: "kelp" }, accessory: { type: "hat", variation: "beanie" } },
    };
    // A task card shows the shape, the color and the eyes only (5.19).
    function bare(look) {
      return Object.assign({}, look, { cheeks: false, head: { type: "none" }, accessory: { type: "none" } });
    }
    // A pup: the same shape and head, a lighter color, dot eyes and no accessory (5.6).
    function pup(look) {
      return Object.assign({}, look, { color: "pup", eyes: "dots", cheeks: false, accessory: { type: "none" } });
    }
    function lighter(hex, t) {
      var n = parseInt(hex.trim().slice(1), 16);
      var ch = [n >> 16, (n >> 8) & 255, n & 255].map(function (v) { return Math.round(v + (255 - v) * t); });
      return "#" + ch.map(function (v) { return v.toString(16).padStart(2, "0"); }).join("");
    }
    // Puts a mascot in `host`. The pause follows reduced motion: Alive, or Still (5.19).
    function mascot(host, look, px, o) {
      o = o || {};
      var m = new engine.Mascot(host, { mascot: look, px: px, mode: o.mode || "header", quietable: !!o.quietable });
      if (o.state && o.state !== "idle") m.setState(o.state, { activity: o.activity || null, instant: true });
      // A header pup breathes and blinks, and nothing else (5.6): no gestures.
      if (o.calm) {
        m.nextGesture = Infinity;
        (function wink() {
          setTimeout(function () {
            if (!host.isConnected) return;
            if (!reduced()) m.blink();
            wink();
          }, 3000 + Math.random() * 3000);
        })();
      }
      return m;
    }
    function syncMotion() {
      engine.setMotion(reduced() ? "still" : "alive");
    }
    if (mq.addEventListener) mq.addEventListener("change", syncMotion);
    syncMotion();
    return {
      token: token, num: num, reduced: reduced, spring: spring, ease: ease, animate: animate,
      enter: enter, exit: exit, roll: roll, runner: runner, guard: guard, icon: icon, glyph: glyph,
      pauseIcon: pauseIcon, tooltips: tooltips, segment: segment, LOOKS: LOOKS, bare: bare, pup: pup, lighter: lighter, mascot: mascot, syncMotion: syncMotion,
    };
  })();
