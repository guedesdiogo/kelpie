# ADR-0046: Each agent's Telegram bot shows the agent's mascot as its profile photo

- Status: Accepted
- Date: 2026-10-15
- Issue: [#368](https://github.com/guedesdiogo/kelpie/issues/368)
- The owner asked on 2026-10-15: «Nós conseguimos colocar de forma automática a imagem do mascote ou melhor ainda um gif como na imagem do bot no telegram?» They chose the plan: «Abre a story com o plano: primeiro o JPG estático, depois o MP4 animado, gerados pelo Browser Run.» Then they approved it: «Aprovado o plano da #368. Pode começar.»
- Amends: [ADR-0045](0045-agent-mascot.md). Its consequences said channels without a figure, such as Telegram, are unaffected; Telegram now shows the mascot as the bot's photo.

## Context

**Telegram lets a bot set its own photo.** `setMyProfilePhoto` takes either of two kinds ([Bot API](https://core.telegram.org/bots/api#setmyprofilephoto)):
- a still JPG;
- an animated MPEG4, whose `main_frame_timestamp` picks the frame shown as the still.

A photo can't be reused, so each one goes up as a new file. Telegram recommends a square 800 × 800 video ([files](https://core.telegram.org/api/files)), and has no GIF avatars.

**Each agent has its own bot.** Its token lives only in channel-egress (ADR-0013).

**The fur needs a canvas, and Workers have none.** The mascot's fur is painted strand by strand on a canvas (ADR-0045 §3). [Browser Run](https://developers.cloudflare.com/browser-run/) runs headless Chrome from a Worker. The spike on #368 measured it:
- **Its page can record H.264.** Its Quick Action page is `about:blank`, not a secure context, so WebCodecs is missing. `MediaRecorder` records `video/mp4;codecs=avc1`.
- **The still:** the fur paints in 0.25 to 0.6 s, and the page answers a still in about 2 s.
- **The loop:** a 3.6 s loop at 30 fps takes 11 to 16 s and weighs about 0.5 MB.

**Cost.** Workers Paid includes 10 browser hours a month, then US$ 0.09 an hour. Under `CLAUDE.md`, a feature that bills only past a free tier stays on, guarded by the alert at 90% (#269).

**Telegram plays the loop, not Kelpie.** A Premium account's profile video "will animate for everyone throughout the app" ([2022](https://telegram.org/blog/700-million-and-premium)). Where it plays for other accounts, and whether it follows the system's reduced motion, isn't documented. The research behind the framing and the loop is on #368.

## Decision

### 1. The bot's photo is the agent's mascot

- **When:** the agent's `AgentHost` asks channel-egress for the photo when its bot connects and when its mascot changes, including back to the default.
- **Who sends it:** a `BotPhoto` Durable Object per agent keeps the newest mascot asked for. Its alarm waits 5 s, so a mascot changed several times in a row is drawn once, then draws and sends it.
- **What it skips:** a mascot already on that bot isn't drawn again. An agent without a bot gets nothing.
- **What it replaces:** it replaces a photo set in BotFather, because the owner asked for the photo to follow the mascot by itself.

### 2. Browser Run draws it with the webchat's own engine

channel-egress bundles the webchat's mascot files as text, through links in `src/photo/webchat`, with `mascot-photo.js` beside them. One Quick Action page runs them:
- the page is never public, so Access is unchanged;
- the page gets only the mascot's axes;
- the bot's token never leaves channel-egress.

The photo is always the mascot the webchat shows.

### 3. What the photo shows

- **The square:** 800 × 800, on a flat, opaque background: the design system's `--bg`, `#E7EEEC`.
- **The figure:** centered by what it shows, from its ears or hat to its shadow, inside the circle Telegram crops.
- **The loop:** one idle breath of 3.6 s at 30 fps, so it joins up, with a blink at 0.7 s, a wave at 1.3 s and a blink at 3.0 s.
- **The still:** its first frame, at rest, which is also the JPG.

### 4. How the loop is recorded, and what is sent

- **Recording:** a virtual clock moves the engine's timers and Web Animations frame by frame. Each frame is the SVG with its animated transforms written in, drawn to a canvas. The frames then play in real time into `MediaRecorder`.
- **Sending:** channel-egress sends the loop. When Telegram refuses it (400), or the page couldn't record one, it sends the still.
- **Failures:** a draw or send that fails is tried again by the alarm, later each time. A 429 waits as long as Telegram asks.

### 5. Motion outside Kelpie's interface

Telegram decides when the loop plays, so Kelpie's motion guards (ADR-0045 §6) don't reach it. The loop is made safe on its own:
- one pass is under WCAG 2.2.2's 5 s;
- it has no flash, no zoom and no scaling of the whole figure;
- its still is the rest pose.

This isn't ambient motion in Kelpie's interface, which the design system rejects (§8).

## Consequences

- **The bot shows the mascot** wherever Telegram shows its photo, and follows the owner's changes.
- **channel-egress gains** a `browser` binding, a `BotPhoto` class (migration `v2`, add-only) and the webchat's mascot files in its bundle, about 120 KB.
- **The webchat and the photo share one engine.** A change to the engine shows in a bot's photo the next time its mascot changes or its bot connects.
- **Browser Run is used for each connection or mascot change:** about 15 s each, about 2,000 changes a month within the included hours. Until #269's alert ships, its use shows only in Cloudflare's dashboard.
- **Not yet verified:**
  - whether Telegram takes the fragmented MP4 that `MediaRecorder` writes, which the fallback to the still covers;
  - where Telegram plays a bot's profile video.

  A real bot verifies them.
- **What the tests cover and what they don't:**
  - Tests cover the clock, the framing, the page's module order, and the photo's flow in channel-egress against a stand-in for Browser Run.
  - The drawing itself runs only in a real browser. #368 has its frames from Browser Run.

## Alternatives considered

- **Drawing in a browser the owner has open,** as Hermes's desktop rasterizes its bot faces. The photo would wait for an open page.
- **A GIF.** Telegram has no GIF avatars; a profile video is an MPEG4.
- **A Puppeteer session that screenshots each frame.** It adds a dependency and moves every frame through the Worker twice.
- **WebCodecs with an MP4 muxer.** WebCodecs is missing: the Quick Action page isn't a secure context.
- **The still only.** The owner asked for the animation; the still is its fallback.
- **An opt-in setting,** as Hermes keeps its own changes to a bot's profile. The owner asked for the photo to change by itself.

## References

- Issue [#368](https://github.com/guedesdiogo/kelpie/issues/368): the reference projects' findings, the spike's numbers and the design research.
- [Bot API: setMyProfilePhoto](https://core.telegram.org/bots/api#setmyprofilephoto), [InputProfilePhotoAnimated](https://core.telegram.org/bots/api#inputprofilephotoanimated)
- [Telegram: uploading files, profile videos](https://core.telegram.org/api/files)
- [Browser Run](https://developers.cloudflare.com/browser-run/), [limits](https://developers.cloudflare.com/browser-run/limits/), [pricing](https://developers.cloudflare.com/changelog/post/2025-07-28-br-pricing/)
- [Durable Objects: alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)
- [WCAG 2.2.2 Pause, Stop, Hide](https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html)
