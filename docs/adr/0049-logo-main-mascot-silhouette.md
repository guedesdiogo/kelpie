# ADR-0049: Kelpie's logo is the main mascot's silhouette, and the main mascot gets round ears and big eyes

- Status: Accepted
- Date: 2026-10-16
- Issue: [#385](https://github.com/guedesdiogo/kelpie/issues/385)
- Amended by: [ADR-0053](0053-bot-photo-follows-default-mascot.md), the main agent's bot follows the new default without a setting change
- The owner asked on 2026-10-16: «Precisamos definir um logo melhor para kelpie, abra uma sessão para tratarmos o logo a parte». After comparing four directions on a lab page: «Vamos seguir o Orelhas, mas quero alterar o padrão das orelhas para a configuração "redonda", os olhos para "grandes" e remover a coleira». On approving the plan he first asked for the eyes on the logo too, then: «corrigindo, vamos sem os olhos».
- Amends:
  - [ADR-0045](0045-agent-mascot.md) §2: the main agent starts as Kelpie with big eyes, round ears and no accessory, in place of shine eyes, pointed ears and a collar;
  - [ADR-0043](0043-design-system.md) §2: the identity gains a logo.

## Context

**Kelpie had a placeholder, not a logo.**
- **The placeholder** was an 18 px kelp shape, the mascot's `mark` shape, beside "Kelpie" in Bricolage Grotesque 680. It appeared in the webchat mockup's sidebar ([#378](https://github.com/guedesdiogo/kelpie/issues/378)) and in the motion lab.
- **There was no favicon.**
- **It blended in.** Among WhatsApp and Telegram icons, the plain shape reads as one more speech bubble.

**The research on #385, read on 2026-10-16:**
- **Brands that relate a mark to a mascot reduce it to a silhouette.**
  - GitHub's Invertocat "represents our mascot", and the mascot never substitutes for the logo.
  - Mailchimp simplified Freddie to work at any size, with a reverse version for dark backgrounds.
- **Small sizes need their own drawings and blunt shapes.**
  - Dropbox keeps a separate glyph for 32 px and below; GitHub keeps 16 and 24 px drawings.
  - Discord rounded Clyde's antennas, which failed on small surfaces.
- **A mark must not depend on a mascot that changes.** Copilot's Mico was retired after ten months; Copilot's logo never depended on it.
- **Safari 26 supports SVG favicons** but ignores `prefers-color-scheme` inside them ([WebKit bug 309949](https://bugs.webkit.org/show_bug.cgi?id=309949)).
- **None of the reference projects ties its logo to its agents.**
  - invokta's inline, token-driven mark with a favicon drawn on its own is the closest model.
  - Hermes Agent renders every size from one vector master.

**Four directions were compared** on a lab page, each shown in place, at 16 px and next to the mascot:
- **Orelhas:** the main mascot's silhouette;
- **Metamorfose:** the sign with one ear, which becomes the mascot in motion;
- **Plaquinha:** the collar's tag;
- **Lâmina:** Bricolage's K with its upper arm drawn up into a blade.

The owner chose Orelhas, and changed the main mascot itself with it.

## Decision

### 1. The logo is the main mascot's silhouette

- **The mark** is the main mascot's `mark` shape with its round ears, flat and in one colour. It has no face, fur, accessory or shadow.
- **It comes from the mascot engine's own geometry**, on the 120 grid of `mascot-art.js`:
  - the shape: 24..96 × 36..108, with corners 36, 36, 36 and 11.5;
  - the ears: circles of 10.5 at (38, 42) and (82, 42).
- **The lockup** sets the mark beside "Kelpie" in Bricolage Grotesque 680, with the font's own kerning.
- **The colour** is `--accent`. It is never amber, which means the owner must act.
- **It names Kelpie, the product.** It never stands in for an agent: every agent, the main one included, shows its own mascot (ADR-0045 §1).

### 2. The main mascot gets round ears and big eyes

- **The new default:** `KELPIE_MASCOT` is `mark`, `kelp`, `big` eyes, no cheeks, `ears: round` and no accessory.
- **Agents whose owner picked a mascot keep it,** and derived mascots don't change.

### 3. Small sizes have their own drawings

- **The favicon** is an opaque `--accent` tile with the mark in `--on-accent`. Safari ignores the dark block inside an SVG favicon, so the light tile is the one every browser can show. Chrome and Firefox take the dark tile on a dark system.
- **The 16 and 32 px masters** keep the body on whole pixels and draw the ears a little larger, so they survive.

### 4. One script draws every file

- **`scripts/brand-icons.mjs`** writes the brand's SVG files and renders the PNG and ICO files from them with headless Chrome. Its outputs are committed:
  - in `docs/brand/`: the mark, its lockups for light and dark, the 16 px favicon master and the sources of the home-screen icons;
  - the webchat's `icon.svg`, `favicon.ico` (16 and 32 px), `apple-touch-icon.png` (180 px), `icon-192.png`, `icon-512.png` and `icon-maskable-512.png`.
- **The webchat links them,** and serves a manifest. Access guards `/webchat/`, so the page asks for the manifest with the login's cookie (`crossorigin="use-credentials"`).
- **The manifest's `display` is `browser`.** A home-screen icon opens the webchat as a tab, so signing in through Access works as it does today.

The values are in `docs/design-system.md` §5.23.

## Consequences

- **The webchat has a favicon and a home-screen icon.**
  - The sidebar's lockup lands with #378, in whichever of the two pull requests merges second.
  - The favicon's amber dot from §5.9 is still to be built.
- **The main agent's Telegram photo follows the new Kelpie** when the deploy wakes the agent ([ADR-0053](0053-bot-photo-follows-default-mascot.md)). Until ADR-0053, ADR-0046 §1 redrew a photo only when the mascot setting changed or the bot connected.
- **Older home-screen shortcuts keep their old icon** until they are added again.
- **Changing the logo means changing the script and running it.** A test checks the files' sizes, the ICO's two layers and the tile's colours against `tokens.css`.
- **The logo follows the main mascot's default.** If that default changes again, a new ADR redraws the logo with it.

## Alternatives considered

- **The placeholder.** It reads as one more chat bubble.
- **Metamorfose.** At rest, the link to the mascot is subtle; it shows only in motion.
- **Plaquinha.** Its ring vanishes at 16 px, and the tag can read as a flask.
- **Lâmina.** It is the strongest at 16 px and the least tied to the mascot.
- **The mascot's pointed ears and collar,** as it was. The owner chose round ears and no collar.
- **The logo with the mascot's big eyes.** The owner asked for it, then withdrew it. A face makes the logo the mascot, which the research advises against.
- **Left out before the comparison:**
  - the sign cut by a collar, which reads as a helmet;
  - a dog's head in profile, too angular beside the plush mascot;
  - a herd of shapes, which blurs at 16 px.

## References

- Issue [#385](https://github.com/guedesdiogo/kelpie/issues/385): the request, the plan, the research as adopt, adapt and avoid, and the owner's choice.
- [The lab page](https://claude.ai/artifact/1AECLE1ZuPjYfb2RZusg4Y), with the four directions.
- **ADRs:**
  - [ADR-0045](0045-agent-mascot.md): the mascot;
  - [ADR-0043](0043-design-system.md): the identity;
  - [ADR-0046](0046-telegram-bot-photo.md): the bot's photo.
- [`docs/design-system.md`](../design-system.md) §5.23, the logo.
