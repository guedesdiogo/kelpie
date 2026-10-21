# Design system artifact

The sources of Kelpie's design system artifact on claude.ai: https://claude.ai/artifact/4BWykDA1f4P3FkykJGXkN8. It was recreated from these files on 2026-10-20, after the first one went missing (#468). It is a private page of the "Design System" artifact type, and shows the tokens, a card per component, the icons and logos, and a guide.

[`docs/design-system.md`](../../docs/design-system.md) is the source of truth. The artifact shows it, and a card that disagrees with it is a bug in the card.

## What is here

- **`project/`** holds the files the artifact publishes, at the same paths:
  - `README.md`: the artifact's own guide to using the system;
  - `tokens.json`: the tokens;
  - `design-system.json`: the artifact's index;
  - `components/<Name>/preview.html` and `README.md`: one card per component. Each preview's first line is the `<!-- @dsCard group=… height=… subtitle=… -->` marker the artifact type reads;
  - `components/bundle.js` and `bundle.css`, which every preview loads;
  - `guide/*.md`, `assets/` and `fonts/`.
- **`src/`** holds what builds them:
  - `helpers.js`: the previews' motion helpers, `window.Kelpie.ui`;
  - `css/`: each component's CSS;
  - the scripts.

Generated files, never edited by hand:
- `project/components/bundle.js`;
- `project/components/bundle.css`;
- `src/mascot.part.css`;
- `project/guide/*.md`.

## Build

Each script works from any folder. Run them in this order, since `build_css.py` reads the `mascot.part.css` that `build.py` writes:

- `python3 -I tools/design-system/src/build.py` builds `bundle.js` from the webchat's own engine, `apps/ingress/public/webchat/mascot*.js`, plus `src/helpers.js`. It also copies the engine's `mascot.css` into `src/mascot.part.css`.
  - The engine's code is unchanged, apart from its import and export lines, so the cards run what ships.
  - The bundle's header names the commit that last changed the engine, read from git.
  - `ENGINE` points it at another copy of the engine, and `ENGINE_ORIGIN` names that copy in the bundle's header. Use them only for an engine an ADR approved before it ships.
- `python3 -I tools/design-system/src/build_css.py` joins `src/css/*.css`, `0-base.css` first, and `src/mascot.part.css` into `bundle.css`.
- `python3 -I tools/design-system/src/guide.py` regenerates `project/guide/*.md` from `docs/design-system.md`.
  - The guide holds §4, §5.14, §5.19 and §6 to §9.
  - Relative links point at GitHub.

## Preview

`python3 -I tools/design-system/src/harness.py` writes `test/`, which git ignores:
- `test/tokens.css`, compiled from `tokens.json` as the artifact type does;
- each card, framed as the artifact frames it, in `test/c/<Name>/index.html`;
- `test/index.html`, with every card.

To view it, serve `tools/design-system` on localhost, for example with `python3 -m http.server 8768 --bind 127.0.0.1` run in that folder, and open http://127.0.0.1:8768/test/index.html. Stop the server and delete `test/` when you're done.

## Publish

Claude Code publishes with its Artifact tool, to the artifact's URL, and nothing else does.
- Read the live version first, and merge any change made since.
- Send the changed files under `project/`, at their paths.
- Send `project/design-system.json` last, with its `lastChange` updated.
- Images and fonts listed in `design-system.json`'s `assetGroups` are uploaded assets of the artifact. The copies here are for reference.

Not in this folder:
- the `tokens.css` the artifact type compiles from `tokens.json`;
- the `latin-ext` font files, which the webchat serves (`apps/ingress/public/webchat/fonts/`).
