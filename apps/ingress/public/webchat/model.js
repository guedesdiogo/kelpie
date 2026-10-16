// The webchat's decisions, without the DOM, so they test on their own (#140): how messages group
// and date, how full the wait's bar is, when the thread follows its end, how the page reconnects,
// and how a turn's steps read. The page draws what these return.

// ── Groups, days and times (docs/design-system.md §5.20) ───────────────────────────────────────

/** Messages from one sender this close together, on the same day, form a group (Telegram). */
export const GROUP_GAP_MS = 10 * 60_000;

const pad = (value) => String(value).padStart(2, "0");

/** The calendar day of `at` in the browser's zone, as `<time datetime>` takes it. */
export function dayKey(at) {
  const date = new Date(at);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Whether `next` joins the group `previous` ends. Each sender is "user" or "assistant". */
export function sameGroup(previous, next) {
  return (
    previous !== undefined &&
    previous.sender === next.sender &&
    dayKey(previous.at) === dayKey(next.at) &&
    next.at - previous.at <= GROUP_GAP_MS
  );
}

/** A time of day, as the page's language writes it. */
export function clock(at, locale) {
  return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(at);
}

const startOfDay = (at) => {
  const date = new Date(at);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
};

/** "Today", "Yesterday", a weekday within the week, then the date; the year only for another one. */
export function dayLabel(at, now, locale, texts) {
  // Rounded, since a day with a clock change is an hour longer or shorter.
  const days = Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000);
  if (days === 0) return texts.today;
  if (days === 1) return texts.yesterday;
  const options =
    days > 1 && days < 7
      ? { weekday: "long" }
      : new Date(at).getFullYear() === new Date(now).getFullYear()
        ? { day: "numeric", month: "long" }
        : { day: "numeric", month: "long", year: "numeric" };
  const label = new Intl.DateTimeFormat(locale, options).format(at);
  return label.charAt(0).toLocaleUpperCase(locale) + label.slice(1);
}

/**
 * What shows under one of the owner's messages, strongest first; null for nothing. Marks only move
 * forward: once accepted, a message is never "sending" or "queued" again.
 * - refused: the conversation turned it down, with its reason;
 * - queued: written while the socket was closed;
 * - sending: not yet accepted, past the first 300 ms;
 * - held: accepted, while the wait before the reply holds it (5.1).
 */
export function markOf(message, { waiting }) {
  if (message.refused) return "refused";
  if (!message.accepted) {
    if (message.queued) return "queued";
    return message.slow ? "sending" : null;
  }
  return waiting && message.held ? "held" : null;
}

/** "Sending" shows only after this long, so a quick acceptance shows nothing (rule 8). */
export const SENDING_AFTER_MS = 300;

// ── The wait before a reply (5.1, ADR-0043 §5) ─────────────────────────────────────────────────

/** A new message refills the bar in this first part of the time, then it drains linearly. */
export const REFILL = 0.07;
/** The owner counts as still typing for this long after their last keystroke. */
export const TYPING_IDLE_MS = 1_000;

/** The wait from a `wait` frame received at `at`, or null when there is none. */
export function waitOf(deadline, at) {
  if (!deadline || !(deadline.remainingMs > 0)) return null;
  return {
    until: at + deadline.remainingMs,
    span: Math.max(deadline.spanMs, deadline.remainingMs),
    holding: deadline.holding === true,
  };
}

/** How full the bar is at `at`, by the real deadline. */
export function fillAt(wait, at) {
  if (!wait) return 0;
  return Math.min(1, Math.max(0, (wait.until - at) / wait.span));
}

/**
 * The bar's animation from what shows now, `from`: back up to where the deadline puts it within
 * the first 7%, then linearly to empty at the deadline. While the hold lasts and the owner types,
 * it fills and stays full. Null once the deadline has passed.
 */
export function barMotion(wait, at, from, { typing }) {
  const remaining = wait.until - at;
  if (remaining <= 0) return null;
  if (wait.holding && typing) {
    return {
      keyframes: [{ transform: `scaleX(${from})` }, { transform: "scaleX(1)" }],
      duration: Math.min(remaining * REFILL, 300),
    };
  }
  const refilled = fillAt(wait, at + remaining * REFILL);
  return {
    keyframes: [
      { transform: `scaleX(${from})`, offset: 0 },
      { transform: `scaleX(${refilled})`, offset: REFILL },
      { transform: "scaleX(0)", offset: 1 },
    ],
    duration: remaining,
  };
}

// ── Following the chat (5.10) ──────────────────────────────────────────────────────────────────

/** The thread follows new content only while the reader is this close to its end. */
export const FOLLOW_PX = 150;

export function nearEnd({ scrollTop, clientHeight, scrollHeight }) {
  return scrollHeight - scrollTop - clientHeight <= FOLLOW_PX;
}

/** The pill's text: an approval waiting below wins over the count; null hides it. */
export function pillText(texts, { count, approval }) {
  if (approval) return texts.pillApproval;
  return count > 0 ? texts.pillNew(count) : null;
}

// ── The tab (5.9) ──────────────────────────────────────────────────────────────────────────────

/**
 * The tab's title and favicon while `waiting` agents wait for the owner: the title starts with
 * their count, and the favicon gets the --warm dot. An agent named Kelpie isn't named twice.
 */
export function tabOf(name, waiting) {
  const title = name === "Kelpie" ? "Kelpie" : `${name} · Kelpie`;
  if (waiting === 0) return { title, icon: "/webchat/icon.svg" };
  return { title: `(${waiting}) ${title}`, icon: "/webchat/icon-waiting.svg" };
}

// ── A lost connection (5.12) ───────────────────────────────────────────────────────────────────

/** The first 2 s offline change nothing. */
export const BANNER_AFTER_MS = 2_000;
/** "Back" shows this long, then the banner leaves. */
export const BACK_SHOWN_MS = 2_600;
/** After reconnecting, announcements wait this long, so a backlog doesn't arrive as a burst. */
export const QUIET_AFTER_MS = 4_000;
/** Loading longer than this leaves the screen to the connection banner (5.11). */
export const LOADING_GIVE_UP_MS = 10_000;

/** The wait before the next try: full jitter, from 300 ms up to 15 s. */
export function retryDelay(attempt, random = Math.random) {
  return random() * Math.min(15_000, 300 * 2 ** attempt);
}

/** The banner's words while offline; under less motion, no counting number. */
export function offlineText(texts, { nextTryAt, now, less }) {
  if (less) return texts.offlineShortly;
  return texts.offline(Math.max(1, Math.ceil((nextTryAt - now) / 1_000)));
}

/**
 * What a request with `X-Requested-With` says about the Access login: Access answers 401 once the
 * session expired, or redirects to its sign-in when it doesn't recognize the header.
 */
export function loginState(response) {
  if (response.type === "opaqueredirect" || response.status === 401) return "expired";
  if (response.status === 403) return "refused";
  return response.ok ? "ok" : "unknown";
}

// ── A turn's activity (5.1, 5.2, rule 8) ──────────────────────────────────────────────────────

/** The elapsed time shows from 3 s. */
export const ELAPSED_FROM_MS = 3_000;
/** A spinner appears only after this much waiting, and stays at least SPINNER_MIN_MS. */
export const SPINNER_AFTER_MS = 200;
export const SPINNER_MIN_MS = 300;

/**
 * The elapsed time, or null before 3 s: seconds, then m:ss. Under less motion, minutes only, which
 * the page updates once a minute.
 */
export function elapsedText(ms, texts, { less }) {
  if (ms < ELAPSED_FROM_MS) return null;
  if (less) return texts.minutes(Math.max(1, Math.round(ms / 60_000)));
  const seconds = Math.floor(ms / 1_000);
  if (seconds < 60) return texts.seconds(seconds);
  return `${Math.floor(seconds / 60)}:${pad(seconds % 60)}`;
}

/** A finished row's one line: "3 steps · 2.6 s". */
export function summaryText(steps, ms, texts) {
  return texts.summary(steps, Math.round(ms / 100) / 10);
}

// ── The account (the owner, 2026-10-16) ───────────────────────────────────────────────────────

/** Up to two initials: the first and last words of the name, or of the email's name before the @. */
export function initialsOf(name, email, locale) {
  const words = (name || email.split("@")[0]).split(/[\s._-]+/).filter(Boolean);
  const chosen = words.length > 1 ? [words[0], words.at(-1)] : words.slice(0, 1);
  return chosen
    .map((word) => [...word][0] ?? "")
    .join("")
    .toLocaleUpperCase(locale);
}
