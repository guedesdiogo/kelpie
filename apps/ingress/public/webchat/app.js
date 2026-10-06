// The webchat (issue #40). Cloudflare Access has logged the owner in before this page loads, and
// the socket's upgrade carries the same login. Everything shown goes through textContent: model
// output is never parsed as HTML.

const agent = new URLSearchParams(location.search).get("agent") ?? "";
const list = document.getElementById("messages");
const typing = document.getElementById("typing");
const status = document.getElementById("status");
const form = document.getElementById("composer");
const input = document.getElementById("text");
const pause = document.getElementById("pause");

/** Messages sent but not yet accepted, by id, so a reconnect resends them. */
const unconfirmed = new Map();
let socket = null;
let attempt = 0;
/** Sockets in a row that never opened: an expired Access login looks like this. */
let refused = 0;
let typingTimer = null;
let lastTypingSentAt = 0;
let paused = false;

const PAUSED_STATUS = "Paused: Kelpie answers after your next message";

function setPaused(value) {
  paused = value;
  pause.disabled = value;
  status.textContent = value ? PAUSED_STATUS : "Connected";
}

/** The agent's "typing" lasts until its next bubble, or this long. */
const TYPING_SHOWN_MS = 20_000;
/** While the owner types, the page says so at most this often. */
const TYPING_SENT_EVERY_MS = 3_000;

function show(role, text, id) {
  const item = document.createElement("li");
  item.className = role;
  item.textContent = text;
  if (id) {
    item.dataset.id = id;
    item.classList.add("pending");
  }
  list.append(item);
  item.scrollIntoView({ block: "end" });
  return item;
}

function setTyping(active) {
  clearTimeout(typingTimer);
  typing.hidden = !active;
  if (active) typingTimer = setTimeout(() => setTyping(false), TYPING_SHOWN_MS);
}

function send(frame) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
}

function receive(frame) {
  switch (frame.type) {
    case "history":
      setPaused(frame.paused);
      list.replaceChildren();
      for (const message of frame.messages) show(message.role, message.text);
      // The history already shows what the conversation received; only the rest goes again, and
      // the conversation would drop a repeat by its id anyway.
      for (const id of frame.received) unconfirmed.delete(id);
      for (const [id, text] of unconfirmed) {
        show("user", text, id);
        send({ type: "message", id, text });
      }
      break;
    case "bubble":
      setTyping(false);
      show("assistant", frame.text);
      break;
    case "typing":
      setTyping(frame.active);
      break;
    case "paused":
      setTyping(false);
      setPaused(true);
      break;
    case "accepted":
    case "rejected": {
      const text = unconfirmed.get(frame.id);
      unconfirmed.delete(frame.id);
      const item = list.querySelector(`li[data-id="${CSS.escape(frame.id)}"]`);
      item?.classList.remove("pending");
      if (frame.type === "rejected") {
        item?.classList.add("rejected");
        // What was typed isn't lost: it goes back to the box, unless something new is there.
        if (text !== undefined && !input.value) input.value = text;
      }
      break;
    }
  }
}

function connect() {
  const opened = Date.now();
  socket = new WebSocket(
    `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/webchat/ws?agent=${encodeURIComponent(agent)}`,
  );
  let wasOpen = false;
  socket.addEventListener("open", () => {
    wasOpen = true;
    refused = 0;
    status.textContent = paused ? PAUSED_STATUS : "Connected";
  });
  socket.addEventListener("message", (event) => {
    try {
      receive(JSON.parse(event.data));
    } catch {
      // Not one of Kelpie's frames.
    }
  });
  socket.addEventListener("close", () => {
    refused = wasOpen ? 0 : refused + 1;
    status.textContent =
      refused >= 3 ? "Can't connect. If your login expired, reload the page." : "Reconnecting…";
    setTyping(false);
    // A socket that dies quickly counts as a failed attempt; full jitter, from 300 ms to 15 s.
    attempt = Date.now() - opened < 5_000 ? attempt + 1 : 0;
    const ceiling = Math.min(15_000, 300 * 2 ** attempt);
    setTimeout(connect, Math.random() * ceiling);
  });
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  const id = crypto.randomUUID();
  unconfirmed.set(id, text);
  show("user", text, id);
  send({ type: "message", id, text });
  // The next message ends a pause.
  if (paused) setPaused(false);
  send({ type: "typing", active: false });
  lastTypingSentAt = 0;
  input.value = "";
});

pause.addEventListener("click", () => {
  send({ type: "pause" });
});

input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
  }
});

input.addEventListener("input", () => {
  const now = Date.now();
  if (input.value.trim() && now - lastTypingSentAt >= TYPING_SENT_EVERY_MS) {
    lastTypingSentAt = now;
    send({ type: "typing", active: true });
  }
});

if (agent) {
  connect();
} else {
  status.textContent = "Open this page with ?agent=<agent id>";
  form.hidden = true;
}
