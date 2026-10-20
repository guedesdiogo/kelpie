# ADR-0062: Kelpie's logo takes the kelpie's pointed ear, and Master starts with it

- Status: Accepted
- Date: 2026-10-20
- Issue: [#464](https://github.com/guedesdiogo/kelpie/issues/464)
- The owner asked on 2026-10-19: «Quero revisar o que definimos como logo do kelpie, pensando melhor faz mais sentido a orelha pontuda, por ter a referência ao cachorro da raça kelpie […] quero primeiro melhorar ela na customização do mascote e depois adaptarmos o logo.»
  - The mascot's pointed ear was redrawn first, in [#455](https://github.com/guedesdiogo/kelpie/issues/455).
  - On the logo's lab, the owner chose: «A. Master passa a ter a orelha pontuda incialmente».
- Amends [ADR-0049](0049-logo-main-mascot-silhouette.md):
  - §1, the mark takes the pointed ear in place of the round one;
  - §2, Master starts with pointed ears in place of round ones.

## Context

**The round ear read as a teddy bear, not as the breed Kelpie is named for.** The owner wanted the pointed ear, but the mascot's own pointed ear read as a cat's ear or a horn.

**#455 redrew the mascot's `ears: pointed` from a photo of a kelpie**, the owner's reference:
- a domed top, an outer edge nearly upright and a straight inner diagonal;
- a base set at the corner of the head;
- a light shell inside, which §5.19 says is what keeps the ear from reading as a horn.

**ADR-0049 ties the logo to Master's default:** "If that default changes again, a new ADR redraws the logo with it."

**A flat mark has no shell.** At 16 px the ear is 2 to 3 px wide, so its dome can't show either.

**Three marks were compared on a lab page,** each drawn from the engine's geometry and shown in place: large, in the lockup, as the app icon, and in light and dark browser tabs at a true 16 and 32 px.
- **A:** the ear's silhouette, exactly as the engine draws it on `mark`.
- **B:** A with the shell cut out on the large masters.
- **C:** the ear at the photo's height, free of the mascot's frame.

**The lab showed one thing plainly:** at large sizes all three lean toward a cat. The body is a drop with no muzzle, and a round body with two upright ears is the code for a cat.

## Decision

### 1. The mark is Master's silhouette with the kelpie's pointed ear

- **The mark** is the `mark` shape with the pointed ears the engine draws on it, flat and in one colour. It has no shell, face, fur, accessory or shadow.
- **It comes from the engine itself.**
  - `pointedEarOutlines("mark")` in `apps/ingress/public/webchat/mascot-art.js` gives the ears' outlines on the 120 grid.
  - `scripts/brand-icons.mjs` imports them, so the logo and the mascot can't drift apart. A test checks that those outlines are the ears the mascot draws, point for point.
- **The figure runs from y 19.04, the top of the ears' outline, to 108.** On the 64 box, the mark is 50 wide and 61.8 tall, against 53.1 with the round ears.
- **The 32 and 16 px masters** keep the body on whole pixels, as before. The ears are grown about the middle of their base, 10% at 32 px and 25% at 16 px.
- **Everything else in ADR-0049 stands:** the lockup, the colours, the tiles, the files and the script.

### 2. Master starts with the kelpie's pointed ear

- **`KELPIE_MASCOT`** is `mark`, `kelp`, `big` eyes, no cheeks, `ears: pointed` and no accessory.
- **The outline of the mascot's motion setting follows it** (§5.22), since it draws Master's mascot.
- **Agents whose owner picked a mascot keep it,** and derived mascots don't change.

## Consequences

- **Master's Telegram photo** is redrawn when the deploy wakes it (ADR-0054).
- **Home-screen shortcuts** keep the old icon until they are added again.
- **Changing the pointed ear now changes the logo.** Run `scripts/brand-icons.mjs` and commit what it writes. A change to the ear's geometry is a change to the logo, so it takes an ADR, as ADR-0049 asks.
- **At 16 px,** only the wide base and the outer edge set upright separate the ear from a cat's.

## Alternatives considered

- **B, the shell cut out on the large masters.** It reads more as an ear, but the cut exists only at large sizes. The owner chose A.
- **C, the ear at the photo's height.** It's the closest to a kelpie, but the logo would stop being Master's exact silhouette, which is ADR-0049's principle.
- **The pointed logo with a round Master.** It breaks the same principle. The owner chose to change Master with it.
- **Keeping the round ear.** The owner set it aside: the pointed ear refers to the breed.

## References

- Issue [#464](https://github.com/guedesdiogo/kelpie/issues/464): the decision, the research's re-check and the owner's pick.
- Issue [#455](https://github.com/guedesdiogo/kelpie/issues/455): the ear's research, the photo's measurements and the lab of the ear.
- The lab pages, private and the owner's:
  - [the logo's](https://claude.ai/artifact/EtCnnPReRsM14i79DqgREQ);
  - [the ear's](https://claude.ai/artifact/CE6iUearH7xpRwk3kKA2gD).
- [ADR-0049](0049-logo-main-mascot-silhouette.md), the logo; [ADR-0054](0054-bot-photo-follows-default-mascot.md), the bot follows Master's default.
- [`docs/design-system.md`](../design-system.md) §5.19 and §5.23.
