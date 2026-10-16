// The webchat (issue #40), redesigned on Kelpie's design system (#140, docs/design-system.md).
// Cloudflare Access has logged the owner in before this page loads, and the socket's upgrade
// carries the same login. Model output is never parsed as HTML: thread.js and blocks.js build it
// from text nodes and the blocks the runtime read (#188). A Confirm button shows only on a
// confirmation's notice, which the runtime marks with its id (#186). The header shows the agent's
// mascot, whose state follows the conversation's (ADR-0045).

import { Mascot, ownerTyping, setMotion } from "./mascot.js";
import { isDrawable } from "./mascot-art.js";
import { effectiveMotion, MOTIONS, presenceKeeper } from "./mascot-states.js";
import {
  BACK_SHOWN_MS,
  BANNER_AFTER_MS,
  barMotion,
  clock,
  fillAt,
  LOADING_GIVE_UP_MS,
  loginState,
  nearEnd,
  offlineText,
  pillText,
  QUIET_AFTER_MS,
  retryDelay,
  TYPING_IDLE_MS,
  tabOf,
  waitOf,
} from "./model.js";
import { enter, fadeIn, hideAfterExit, play, reduced, SPRINGS, scrollToEnd } from "./motion.js";
import { popover, segmented } from "./popover.js";
import { localeOf, TEXTS } from "./texts.js";
import { Thread } from "./thread.js";
import { Toasts } from "./toasts.js";

const LOCALE = localeOf(navigator.language);
const T = TEXTS[LOCALE];
const display = globalThis.kelpieDisplay;
const $ = (id) => document.getElementById(id);

const scroller = $("scroller");
const threadElement = $("thread");
const status = $("status");
const form = $("composer");
const input = $("text");
const sendButton = $("send");
const pause = $("pause");
const banner = $("banner");
const bannerText = $("banner-text");
const waitBar = $("wait");
const waitFill = waitBar.querySelector(".wait-fill");
const pill = $("pill");
const announcer = $("announcer");
const mascotHost = $("mascot");
const motionAsk = $("motion-ask");
const login = $("login");
const favicon = $("favicon");

let agent = new URLSearchParams(location.search).get("agent") ?? "";
/** The agents the owner can talk to, from /webchat/agents. */
let agents = [];
const agentName = () => agents.find((entry) => entry.id === agent)?.name ?? (agent || "Kelpie");

// ── The conversation ───────────────────────────────────────────────────────────────────────────

/** Messages sent but not yet accepted, by id, so a reconnect resends them. */
const unconfirmed = new Map();
let socket = null;
let attempt = 0;
let paused = false;
let loaded = false;
let lastTypingSentAt = 0;
let lastInputAt = 0;
/** While the owner types in the webchat, the page says so at most this often (ADR-0024). */
const TYPING_SENT_EVERY_MS = 3_000;
/** A typing indicator lasts until the next bubble, or this long. */
const TYPING_SHOWN_MS = 20_000;
let typingTimer = null;

const isOpen = () => socket?.readyState === WebSocket.OPEN;

const thread = new Thread(threadElement, {
  texts: T,
  locale: LOCALE,
  agentName,
  less: () => reduced(),
  onConfirm: (id) => {
    if (!isOpen()) return false;
    send({ type: "confirm", id });
    return true;
  },
  onAnnounce: (text) => announce(text),
  onChange: (change) => followChange(change),
});

const toasts = new Toasts($("toasts"), { texts: T });

function send(frame) {
  if (isOpen()) socket.send(JSON.stringify(frame));
}

function receive(frame) {
  switch (frame.type) {
    case "history":
      present(frame);
      setPaused(frame.paused);
      // Connected: the header's line goes back to saying what the agent does.
      if (!paused) setStatus("");
      setWait(null, { quiet: true });
      thread.replay(Array.isArray(frame.messages) ? frame.messages : []);
      for (const id of Array.isArray(frame.received) ? frame.received : []) unconfirmed.delete(id);
      // The history already shows what the conversation received; only the rest goes again, and
      // the conversation would drop a repeat by its id anyway.
      for (const [id, text] of unconfirmed) {
        thread.owner({ id, text });
        send({ type: "message", id, text });
      }
      loadedHistory(unconfirmed.size);
      break;
    case "agent":
      showMascot(frame.mascot);
      break;
    case "wait":
      setWait(frame.deadline ?? null);
      present(frame);
      break;
    case "bubble":
      clearTimeout(typingTimer);
      thread.reply(frame);
      present(frame);
      if (presence.current.state === "idle") mascot?.arrive();
      announce(`${agentName()}: ${String(frame.text ?? "")}`);
      setStatus("");
      showEmpty();
      break;
    case "confirmation":
      if (!Number.isSafeInteger(frame.id)) break;
      confirmed(frame.id, frame.status);
      present(frame);
      break;
    case "typing":
      if (frame.active) {
        thread.working("typing");
        setStatus(T.steps.typing);
        clearTimeout(typingTimer);
        typingTimer = setTimeout(() => stopped("idle"), TYPING_SHOWN_MS);
      }
      present(frame);
      break;
    case "status":
      step(frame.status, typeof frame.label === "string" ? frame.label : undefined);
      present(frame);
      break;
    case "paused":
      setWait(null, { quiet: true });
      stopped("paused");
      setPaused(true);
      present(frame);
      break;
    case "resumed":
      setPaused(false);
      break;
    case "accepted":
      unconfirmed.delete(frame.id);
      thread.accept(frame.id);
      break;
    case "rejected": {
      const text = unconfirmed.get(frame.id);
      unconfirmed.delete(frame.id);
      thread.refuse(frame.id, frame.reason);
      // What was typed isn't lost: it goes back to the box, unless something new is there.
      if (text !== undefined && !input.value) input.value = text;
      break;
    }
  }
}

/** What the turn is doing (#141): its steps and tools, or nothing once it stopped. */
function step(name, label) {
  if (name === "idle") {
    stopped("idle");
    return;
  }
  if (name === "tool") {
    thread.tool(label ?? T.steps.tool);
    setStatus(label ?? T.steps.tool);
    return;
  }
  if (!Object.hasOwn(T.steps, name)) return;
  thread.working(name);
  setStatus(T.steps[name]);
}

function stopped(reason) {
  clearTimeout(typingTimer);
  thread.stop(reason);
  setStatus(paused ? T.pausedStatus : "");
}

/** The header's line says what the agent does, by the phases' real names (rule 7). */
function setStatus(text) {
  if (status.textContent !== text) status.textContent = text;
}

function setPaused(value) {
  paused = value;
  const line = $("paused-line");
  line.hidden = !value;
  line.textContent = value ? T.paused(agentName()) : "";
  updateControls();
  if (value) setStatus(T.pausedStatus);
  else if (status.textContent === T.pausedStatus) setStatus("");
}

/** Offline, Pause stays pressable and says why it can't pause (5.13), rather than going mute. */
function updateControls() {
  pause.disabled = paused;
}

/** A confirmation's result, on every notice of it; a toast only when its card is out of sight. */
function confirmed(id, result) {
  const card = thread.openCards.find((open) => open.id === id);
  const outOfSight = card && !visible(card.bubble);
  thread.confirmation(id, result);
  if (outOfSight && result === "accepted") {
    toasts.show({
      text: T.confirmedAt(clock(Date.now(), LOCALE)),
      action: { label: T.show, run: () => card.bubble.scrollIntoView({ block: "center" }) },
    });
  }
}

function visible(element) {
  const box = element.getBoundingClientRect();
  const view = scroller.getBoundingClientRect();
  return box.bottom > view.top && box.top < view.bottom;
}

// ── Announcements ──────────────────────────────────────────────────────────────────────────────

/** After a reconnect, announcements wait, so a backlog doesn't arrive as a burst (5.12). */
let quietUntil = 0;

/** A polite announcement, once; the replayed history never is one. */
function announce(text) {
  if (Date.now() < quietUntil) return;
  announcer.textContent = "";
  announcer.textContent = text;
}

// ── The wait before a reply (5.1, ADR-0043 §5) ───────────────────────────────────────────────────

let wait = null;
let waitAnimation = null;
let typingIdleTimer = null;

const ownerTypes = () => Date.now() - lastInputAt < TYPING_IDLE_MS;

/** A new deadline, or the end of the wait, which brings the typing bubble unless `quiet`. */
function setWait(deadline, { quiet = false } = {}) {
  const now = Date.now();
  const from = wait ? shownFill(now) : 0;
  const had = wait !== null;
  wait = waitOf(deadline, now);
  thread.setWaiting(wait !== null);
  drawWait(from);
  if (had && wait === null && !quiet) thread.working(null);
}

function shownFill(now) {
  return wait.holding && ownerTypes() ? 1 : fillAt(wait, now);
}

function drawWait(from) {
  waitAnimation?.cancel();
  waitAnimation = null;
  clearTimeout(typingIdleTimer);
  const now = Date.now();
  const motion = wait && barMotion(wait, now, from, { typing: ownerTypes() });
  if (!motion) {
    waitBar.hidden = true;
    waitFill.style.transform = "scaleX(0)";
    return;
  }
  waitBar.hidden = false;
  waitFill.style.transform = motion.keyframes.at(-1).transform;
  waitAnimation = play(waitFill, motion.keyframes, {
    duration: motion.duration,
    easing: "linear",
    fill: "forwards",
  });
  // Held while the owner types; once they stop, it drains toward the held deadline.
  if (wait.holding && ownerTypes()) {
    const drainOnceIdle = () => {
      if (!wait?.holding) return;
      // Still typing: the bar stays full a while longer.
      if (ownerTypes()) {
        typingIdleTimer = setTimeout(drainOnceIdle, lastInputAt + TYPING_IDLE_MS - Date.now());
        return;
      }
      const at = Date.now();
      wait = waitOf({ remainingMs: wait.until - at, spanMs: wait.until - at }, at);
      drawWait(1);
    };
    typingIdleTimer = setTimeout(drainOnceIdle, lastInputAt + TYPING_IDLE_MS - now);
  }
}

// ── Following the chat (5.10) ───────────────────────────────────────────────────────────────────

let following = true;
let selecting = false;
let unseen = 0;
let approvalBelow = false;

function followChange(change) {
  showEmpty();
  if (change.kind === "owner") {
    // Sending a message always returns to the end.
    toEnd({ flip: true });
    return;
  }
  if (change.kind === "receipt") return;
  if (following && !selecting) {
    toEnd({ flip: true });
    return;
  }
  // An approval never forces a scroll; it counts in the pill.
  if (change.kind === "approval") approvalBelow = true;
  else if (change.kind === "reply") unseen += 1;
  updatePill();
}

/** To the end: at once, or with the bubbles above sliding up after the new one (FLIP). */
function toEnd({ flip = false, animate = false } = {}) {
  const distance = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
  if (animate) {
    scrollToEnd(scroller);
  } else {
    scroller.scrollTop = scroller.scrollHeight;
    if (flip && distance > 0 && distance < scroller.clientHeight && !reduced()) {
      play(
        threadElement,
        [{ transform: `translateY(${distance}px)` }, { transform: "none" }],
        SPRINGS.base,
      );
    }
  }
  following = true;
  unseen = 0;
  approvalBelow = false;
  updatePill();
}

function updatePill() {
  const text = pillText(T, { count: unseen, approval: approvalBelow });
  if (text === null) {
    hideAfterExit(pill);
    return;
  }
  pill.toggleAttribute("data-approval", approvalBelow);
  const appearing = pill.hidden || pill.dataset.leaving !== undefined;
  delete pill.dataset.leaving;
  pill.textContent = text;
  pill.hidden = false;
  if (appearing) enter(pill, { spring: SPRINGS.fast });
}

let scrollIdle = null;
scroller.addEventListener("scroll", () => {
  if (nearEnd(scroller)) {
    if (!following || unseen > 0 || approvalBelow) {
      following = true;
      unseen = 0;
      approvalBelow = false;
      updatePill();
    }
  } else {
    following = false;
  }
  for (const label of threadElement.querySelectorAll(".day-label[data-stuck]")) {
    label.removeAttribute("data-stuck");
  }
  clearTimeout(scrollIdle);
  scrollIdle = setTimeout(markStuckDays, 1_000);
});

/** A day's label that stuck to the top fades 1 s after scrolling stops. */
function markStuckDays() {
  const top = scroller.getBoundingClientRect().top;
  for (const label of threadElement.querySelectorAll(".day-label")) {
    const day = label.parentElement.getBoundingClientRect();
    label.toggleAttribute(
      "data-stuck",
      day.top < top - 1 && label.getBoundingClientRect().top <= top + 1,
    );
  }
}

// The banner, a note over the composer or the phone's keyboard shrink the thread: while it
// follows, its end stays in sight.
if (typeof ResizeObserver === "function") {
  new ResizeObserver(() => {
    if (following && !selecting) scroller.scrollTop = scroller.scrollHeight;
  }).observe(scroller);
}

document.addEventListener("selectionchange", () => {
  const selection = document.getSelection();
  selecting =
    selection !== null &&
    !selection.isCollapsed &&
    threadElement.contains(selection.anchorNode ?? null);
});

pill.addEventListener("click", () => toEnd({ animate: true }));

// ── Loading (5.11) and the empty conversation ────────────────────────────────────────────────────

const skeleton = $("skeleton");
let skeletonShownAt = 0;
const skeletonTimer = setTimeout(() => {
  if (loaded) return;
  skeleton.hidden = false;
  skeletonShownAt = Date.now();
}, 200);
const giveUpTimer = setTimeout(() => {
  if (loaded) return;
  skeleton.hidden = true;
  if (isOpen()) return;
  offlineSince ??= Date.now() - LOADING_GIVE_UP_MS;
  showBanner();
}, LOADING_GIVE_UP_MS);

/** The history arrived: the first one replaces the skeleton, a later one ends an outage. */
function loadedHistory(resent) {
  if (!loaded) {
    loaded = true;
    clearTimeout(skeletonTimer);
    clearTimeout(giveUpTimer);
    const left = skeleton.hidden ? 0 : Math.max(0, skeletonShownAt + 400 - Date.now());
    setTimeout(() => {
      skeleton.hidden = true;
      threadElement.setAttribute("aria-busy", "false");
      fadeIn(threadElement);
      announce(T.loaded);
      showEmpty();
      toEnd();
    }, left);
  } else if (following) {
    toEnd();
  }
  back(resent);
}

let emptyMascot = null;

function showEmpty() {
  const empty = $("empty");
  const isEmpty = loaded && thread.isEmpty;
  if (empty.hidden === !isEmpty) return;
  empty.hidden = !isEmpty;
  if (!isEmpty) {
    // A new host, so the old one leaves the page and the mascots' timer lets its mascot go.
    emptyMascot = null;
    const host = $("empty-mascot");
    host.replaceWith(host.cloneNode(false));
    return;
  }
  $("empty-text").textContent = T.empty(agentName());
  if (mascotConfig)
    emptyMascot = new Mascot($("empty-mascot"), { mascot: mascotConfig, px: 160, mode: "large" });
  if (document.activeElement === document.body) input.focus();
}

// ── The connection (5.12) ─────────────────────────────────────────────────────────────────────────

let offlineSince = null;
let bannerTimer = null;
let bannerTicker = null;
let retryTimer = null;
let nextTryAt = 0;
let backTimer = null;

function connect() {
  clearTimeout(retryTimer);
  // A socket still connecting is dropped: only the newest one speaks for the conversation.
  const previous = socket;
  socket = null;
  previous?.close();
  const opened = Date.now();
  const lang = encodeURIComponent(navigator.language || "");
  // The browser's language goes along, for Kelpie's own messages when the owner's words don't say
  // which language the conversation is in (#187).
  const current = new WebSocket(
    `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/webchat/ws?agent=${encodeURIComponent(agent)}&lang=${lang}`,
  );
  socket = current;
  let wasOpen = false;
  current.addEventListener("open", () => {
    wasOpen = true;
    if (offlineSince !== null) quietUntil = Date.now() + QUIET_AFTER_MS;
    updateControls();
  });
  current.addEventListener("message", (event) => {
    if (socket !== current) return;
    let frame;
    try {
      frame = JSON.parse(event.data);
    } catch {
      return;
    }
    // Not one of Kelpie's frames.
    if (frame && typeof frame.type === "string") receive(frame);
  });
  current.addEventListener("close", () => {
    if (socket !== current) return;
    socket = null;
    updateControls();
    // Nothing more of the turn reaches this page, so the mascot and the thread show none of it.
    present({ type: "closed" });
    thread.stop("closed");
    setWait(null, { quiet: true });
    offlineSince ??= Date.now();
    clearTimeout(bannerTimer);
    if (banner.hidden || banner.dataset.state === "back") {
      bannerTimer = setTimeout(
        showBanner,
        Math.max(0, offlineSince + BANNER_AFTER_MS - Date.now()),
      );
    }
    // A socket that dies quickly counts as a failed attempt.
    attempt = Date.now() - opened < 5_000 ? attempt + 1 : 0;
    const delay = retryDelay(attempt);
    nextTryAt = Date.now() + delay;
    retryTimer = setTimeout(connect, delay);
    // A socket that never opened may be an expired login: Access says so to a plain request.
    if (!wasOpen) checkLogin();
  });
}

function showBanner() {
  if (offlineSince === null) return;
  clearTimeout(backTimer);
  const appearing = banner.hidden;
  banner.dataset.state = "offline";
  banner.hidden = false;
  setStatus(T.offlineStatus);
  renderOffline();
  clearInterval(bannerTicker);
  if (!reduced()) bannerTicker = setInterval(renderOffline, 1_000);
  if (appearing) {
    enter(banner, { rise: -8, scale: 1 });
    // The page sees none of the agents now: every mascot that shows a state says so (ADR-0047).
    present({ type: "offline" });
  }
}

function renderOffline() {
  // A first socket still connecting has no next try to count down to.
  const now = Date.now();
  const text = offlineText(T, { nextTryAt, now, less: reduced() || nextTryAt <= now });
  const digits = text.match(/\d+/);
  if (!digits) {
    bannerText.textContent = text;
    return;
  }
  const number = document.createElement("span");
  number.className = "digits";
  number.textContent = digits[0];
  bannerText.replaceChildren(
    text.slice(0, digits.index),
    number,
    text.slice(digits.index + digits[0].length),
  );
}

/** Back: the banner turns --ok for 2.6 s, saying how many waiting messages went out. */
function back(resent) {
  const wasOffline = offlineSince !== null;
  offlineSince = null;
  clearTimeout(bannerTimer);
  clearInterval(bannerTicker);
  if (!wasOffline || banner.hidden) return;
  if (status.textContent === T.offlineStatus) setStatus(paused ? T.pausedStatus : "");
  banner.dataset.state = "back";
  bannerText.textContent = T.back(resent);
  backTimer = setTimeout(() => {
    banner.hidden = true;
    delete banner.dataset.state;
  }, BACK_SHOWN_MS);
}

$("retry").addEventListener("click", () => {
  if (!isOpen()) connect();
});

// ── The agents and an expired login ────────────────────────────────────────────────────────────

/** Asks ingress for the agents; Access answers 401 to it once the login expired. */
async function fetchAgents() {
  try {
    const response = await fetch("/webchat/agents", {
      headers: { "X-Requested-With": "XMLHttpRequest" },
      redirect: "manual",
      cache: "no-store",
    });
    const state = loginState(response);
    if (state !== "ok") return { state, agents: [] };
    const body = await response.json();
    return { state, agents: Array.isArray(body?.agents) ? body.agents : [] };
  } catch {
    return { state: "unknown", agents: [] };
  }
}

async function checkLogin() {
  const { state } = await fetchAgents();
  if (state === "expired") showLogin();
}

function showLogin() {
  if (login.open) return;
  saveSession();
  // The dialog shows the conversation's mascot at 160 px, holding its plug, and behind it every
  // mascot is Offline too (ADR-0047 §3).
  present({ type: "offline" });
  if (mascotConfig && !$("login-mascot").mascot) {
    new Mascot($("login-mascot"), {
      mascot: mascotConfig,
      px: 160,
      mode: "large",
      state: "offline",
    });
  }
  if (typeof login.showModal === "function") login.showModal();
  else login.setAttribute("open", "");
}

$("sign-in").addEventListener("click", () => {
  saveSession();
  location.reload();
});

const sessionKey = () => `kelpie.webchat.${agent}`;

/** The draft and the messages not yet accepted outlive a reload in this tab (WCAG 2.2.5). */
function saveSession() {
  try {
    const kept = { savedAt: Date.now(), draft: input.value, unconfirmed: [...unconfirmed] };
    if (kept.draft || kept.unconfirmed.length > 0) {
      sessionStorage.setItem(sessionKey(), JSON.stringify(kept));
    } else {
      sessionStorage.removeItem(sessionKey());
    }
  } catch {
    // Without storage, they go with the page.
  }
}

/** Unsent messages go out again by themselves only this soon after leaving, as a sign-in takes. */
const RESEND_WITHIN_MS = 10 * 60_000;
/** The ids and texts the conversation takes (`parseClientFrame`, `LIMITS.maxTextLength`). */
const MESSAGE_ID = /^[A-Za-z0-9-]{1,64}$/;
const MAX_TEXT = 16_000;

function restoreSession() {
  let kept = null;
  try {
    const stored = sessionStorage.getItem(sessionKey());
    sessionStorage.removeItem(sessionKey());
    kept = JSON.parse(stored ?? "null");
  } catch {
    return;
  }
  if (typeof kept !== "object" || kept === null) return;
  const messages = (Array.isArray(kept.unconfirmed) ? kept.unconfirmed : []).filter(
    (entry) =>
      Array.isArray(entry) &&
      typeof entry[0] === "string" &&
      MESSAGE_ID.test(entry[0]) &&
      typeof entry[1] === "string" &&
      entry[1].length <= MAX_TEXT,
  );
  const fresh = Number.isFinite(kept.savedAt) && Date.now() - kept.savedAt <= RESEND_WITHIN_MS;
  const draft = [];
  for (const [id, text] of messages) {
    // An old message is never sent by itself: it waits in the box for the owner to send again.
    if (fresh) unconfirmed.set(id, text);
    else draft.push(text);
  }
  // The draft was written after the messages it follows.
  if (typeof kept.draft === "string") draft.push(kept.draft);
  const text = draft.filter(Boolean).join("\n");
  if (text) {
    input.value = text;
    const notice = $("restored");
    notice.textContent = T.restored;
    notice.hidden = false;
  }
}

addEventListener("pagehide", saveSession);

function showAgents() {
  const name = $("agent-name");
  name.textContent = agentName();
  thread.renamed();
  showTab();
  const switcher = $("switcher");
  const several = agents.length > 1;
  switcher.setAttribute("aria-disabled", String(!several));
  switcher.setAttribute("aria-label", several ? `${agentName()}, ${T.switchAgent}` : agentName());
  if (several && !switcher.querySelector(".icon")) {
    switcher.append(chevron());
  }
  const list = $("agents").querySelector("ul");
  list.replaceChildren(
    ...agents.map((entry) => {
      const item = document.createElement("li");
      const link = document.createElement("a");
      link.href = `?agent=${encodeURIComponent(entry.id)}`;
      if (entry.id === agent) link.setAttribute("aria-current", "page");
      const label = document.createElement("span");
      label.textContent = entry.name;
      const id = document.createElement("span");
      id.className = "agent-id";
      id.textContent = entry.id;
      link.append(label, id);
      item.append(link);
      return item;
    }),
  );
  if (paused) $("paused-line").textContent = T.paused(agentName());
}

function chevron() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M4.5 6.5l3.5 3.5l3.5-3.5");
  svg.append(path);
  return svg;
}

popover($("switcher"), $("agents"), { arrows: true });

/**
 * How many agents wait for the owner (5.9). The page hears only the open one, which waits while its
 * mascot does; once the sidebar hears every agent (#378), its strip's count goes here.
 */
let waiting = 0;

/**
 * The tab's title starts with the count, and the favicon gets its --warm dot. Each is written only
 * when it changes: Firefox marks a pinned tab whose title changed. Safari keeps the first favicon
 * (WebKit bug 266426), so the title carries the count there.
 */
function showTab() {
  const { title, icon } = tabOf(agentName(), waiting);
  if (document.title !== title) document.title = title;
  if (favicon.getAttribute("href") !== icon) favicon.setAttribute("href", icon);
}

// ── The composer ───────────────────────────────────────────────────────────────────────────────

/** On a touch keyboard, Enter breaks the line and the button sends (Telegram). */
const touchKeyboard = matchMedia("(hover: none) and (pointer: coarse)");

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  const id = crypto.randomUUID();
  unconfirmed.set(id, text);
  thread.owner({ id, text, queued: !isOpen() });
  send({ type: "message", id, text });
  present({ type: "sent" });
  mascot?.touch();
  // The next message ends a pause.
  if (paused) setPaused(false);
  send({ type: "typing", active: false });
  lastTypingSentAt = 0;
  input.value = "";
  $("restored").hidden = true;
  setStatus("");
});

input.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey) return;
  // An input method composing a word (the owner's dead-key accents among them) keeps its Enter.
  if (event.isComposing || event.keyCode === 229) return;
  if (touchKeyboard.matches) return;
  event.preventDefault();
  form.requestSubmit();
});

input.addEventListener("input", () => {
  // Reading comes first: while the owner types, the mascot only breathes and blinks.
  ownerTyping();
  mascot?.watch();
  const now = Date.now();
  lastInputAt = now;
  if (input.value.trim() && now - lastTypingSentAt >= TYPING_SENT_EVERY_MS) {
    lastTypingSentAt = now;
    send({ type: "typing", active: true });
  }
});

pause.addEventListener("click", () => {
  if (!isOpen()) {
    toasts.show({ text: T.pauseOffline, error: true });
    return;
  }
  send({ type: "pause" });
});

/** A printable key anywhere focuses the composer, except in a field, a dialog or on a button. */
document.addEventListener("keydown", (event) => {
  if (event.defaultPrevented) return;
  if (event.key === "End" && !isField(event.target)) {
    event.preventDefault();
    toEnd();
    return;
  }
  if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.isComposing || login.open || isField(event.target)) return;
  if (event.target instanceof Element && event.target.closest("button, a, [role='radio']")) return;
  input.focus();
});

function isField(target) {
  return (
    target instanceof Element &&
    Boolean(target.closest("input, textarea, select, [contenteditable]"))
  );
}

// The phone's keyboard: on iOS the layout follows `visualViewport` (5.15); Android resizes the
// content itself (`interactive-widget`). Under 80 px it is the address bar's jitter.
const viewport = globalThis.visualViewport;
if (viewport) {
  const inset = () => {
    const covered = innerHeight - viewport.height - viewport.offsetTop;
    document.documentElement.style.setProperty(
      "--keyboard",
      covered >= 80 ? `${covered}px` : "0px",
    );
  };
  viewport.addEventListener("resize", inset);
  viewport.addEventListener("scroll", inset);
  input.addEventListener("focus", () => setTimeout(inset, 350));
}

// ── The mascot (ADR-0045) and the Display menu ───────────────────────────────────────────────────

// The mascot shows once the conversation names it, and its state follows what the page shows.
// Its motion setting is this browser's; until the owner picks one, it stays still.
const MOTION_KEY = "kelpie.mascotMotion";
let mascot = null;
let mascotConfig = null;
const presence = presenceKeeper((shown) => {
  mascot?.setState(shown.state, { activity: shown.activity });
  waiting = shown.state === "waiting" ? 1 : 0;
  showTab();
});
const present = (event) => presence.event(event);

/** The agent's mascot, from the conversation; one the page can't draw is ignored. */
function showMascot(config) {
  if (!isDrawable(config)) return;
  mascotConfig = config;
  if (mascot) {
    mascot.change(config);
    return;
  }
  mascot = new Mascot(mascotHost, { mascot: config, px: 48, mode: "header", quietable: true });
  const { state, activity } = presence.current;
  mascot.setState(state, { activity, instant: true });
  // The first time a mascot shows, the page asks how it should move.
  applyMotion();
  if (!$("empty").hidden && !emptyMascot) {
    emptyMascot = new Mascot($("empty-mascot"), { mascot: config, px: 160, mode: "large" });
  }
}

function readMotion() {
  try {
    const stored = localStorage.getItem(MOTION_KEY);
    return MOTIONS.includes(stored) ? stored : null;
  } catch {
    return null;
  }
}

let mascotChoice = null;

/**
 * Applies the setting. Reduced motion, from the system or the less-motion switch, means Still and
 * needs no question; otherwise, until the owner picks one, the page asks, and the mascot doesn't
 * move before they answer.
 */
function applyMotion() {
  const chosen = readMotion();
  const less = reduced();
  motionAsk.hidden = chosen !== null || less || !mascot;
  // Until the owner answers, the mascot stays still and the question asks; the menu keeps the answer.
  $("mascot-setting").hidden = !mascot || (chosen === null && !less);
  mascotChoice?.check(effectiveMotion(chosen, less));
  for (const button of $("motion").querySelectorAll("button")) button.disabled = less;
  const note = $("motion-note");
  note.hidden = !less;
  note.textContent = less ? T.reducedMotion : "";
  setMotion(chosen === null ? "still" : effectiveMotion(chosen, less));
}

function chooseMotion(value) {
  try {
    localStorage.setItem(MOTION_KEY, value);
  } catch {
    // Without storage the choice lasts until the page closes.
  }
  applyMotion();
}

for (const button of motionAsk.querySelectorAll("button")) {
  button.addEventListener("click", () => chooseMotion(button.dataset.motion));
}
mascotHost.addEventListener("click", () => mascot?.pet());

function buildDisplay() {
  const current = display?.current ?? { theme: "system", motion: "system", contrast: "system" };
  const choose = (name) => (value) => display?.set({ [name]: value });
  segmented($("theme"), {
    label: T.theme,
    choices: T.themes,
    value: current.theme,
    onChange: choose("theme"),
  });
  const motion = segmented($("motion-setting"), {
    label: T.motionSetting,
    choices: T.motionChoices,
    value: current.motion,
    onChange: choose("motion"),
  });
  // The system's reduced motion can't be turned off here; the switch only adds to it.
  if (display?.systemReduced) {
    motion.check("less");
    for (const button of $("motion-setting").querySelectorAll("button")) button.disabled = true;
  }
  segmented($("contrast"), {
    label: T.contrast,
    choices: T.contrasts,
    value: current.contrast,
    onChange: choose("contrast"),
  });
  mascotChoice = segmented($("motion"), {
    label: T.motion,
    choices: T.motions,
    value: effectiveMotion(readMotion(), reduced()),
    onChange: chooseMotion,
  });
}

popover($("display-button"), $("display"), { onOpen: buildDisplay });
display?.onChange(() => applyMotion());

// ── Start ───────────────────────────────────────────────────────────────────────────────────────

/** Kelpie's version and the deploy's commit, in the footer (#148); nothing when it can't be read. */
async function showVersion() {
  try {
    const response = await fetch("/version", { cache: "no-store" });
    if (!response.ok) return;
    const { version, commit } = await response.json();
    if (typeof version !== "string") return;
    $("version").textContent =
      typeof commit === "string" ? `Kelpie ${version} · ${commit}` : `Kelpie ${version}`;
  } catch {
    // The footer stays empty.
  }
}

/** The page's own texts in its language; index.html holds the English ones. */
function translatePage() {
  document.documentElement.lang = LOCALE;
  document.querySelector(".skip").textContent = T.skip;
  threadElement.setAttribute("aria-label", T.conversation);
  document.querySelector('label[for="text"]').textContent = T.message;
  sendButton.textContent = T.send;
  pause.textContent = T.pause;
  pause.title = T.pauseTitle;
  $("retry").textContent = T.tryNow;
  $("display-button").textContent = T.display;
  $("display").setAttribute("aria-label", T.display);
  $("agents").setAttribute("aria-label", T.agents);
  $("theme-label").textContent = T.theme;
  $("motion-setting-label").textContent = T.motionSetting;
  $("contrast-label").textContent = T.contrast;
  $("motion-label").textContent = T.motion;
  $("login-title").textContent = T.loginTitle;
  $("login-body").textContent = T.loginBody;
  $("sign-in").textContent = T.signIn;
  $("motion-ask-text").textContent = T.motionAsk;
  for (const button of motionAsk.querySelectorAll("button")) {
    button.textContent = T.motions[button.dataset.motion];
  }
}

async function start() {
  translatePage();
  showVersion();
  applyMotion();
  setStatus(T.connecting);
  // Without `?agent=`, the page opens the main agent (#140).
  const listed = agent ? fetchAgents() : null;
  if (agent) {
    restoreSession();
    connect();
  }
  const { state, agents: found } = await (listed ?? fetchAgents());
  agents = found;
  if (state === "expired") {
    showLogin();
    return;
  }
  // An id the list doesn't name would never connect: the main agent opens instead.
  if (agent && state === "ok" && !found.some((entry) => entry.id === agent)) {
    const main = found.find((entry) => entry.main) ?? found[0];
    if (main) {
      location.replace(`?agent=${encodeURIComponent(main.id)}`);
      return;
    }
  }
  if (!agent) {
    const main = found.find((entry) => entry.main) ?? found[0];
    if (!main) {
      setStatus(state === "refused" ? T.notAdmitted : T.noAgents);
      form.hidden = true;
      skeleton.hidden = true;
      clearTimeout(skeletonTimer);
      clearTimeout(giveUpTimer);
      return;
    }
    agent = main.id;
    history.replaceState(null, "", `?agent=${encodeURIComponent(agent)}`);
    restoreSession();
    connect();
  }
  showAgents();
}

start();
