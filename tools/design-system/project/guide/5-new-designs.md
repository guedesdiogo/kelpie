# Designing what isn't here yet

A component, screen, state or interaction this document doesn't define is designed from award-winning work, never from a library's default look (owner, 2026-10-15; ADR-0043 §7).

1. **Research first.** Find how award-winning UX and UI work solves the same problem, newest editions first:
   - the Apple Design Awards;
   - Awwwards, including its product sites;
   - the CSS Design Awards;
   - the Webby Awards;
   - the Red Dot and iF interface categories;
   - teams known for interaction craft.

   Read the product, its video or its write-up, not only the award's page. Check the reference projects in `CLAUDE.md` too.
2. **Look at two things.** How it moves in the interaction, with numbers where the source gives them, and how usable it is: speed, keyboard, errors, accessibility.
3. **Post the findings on the issue,** each as adopt, adapt or avoid, with a link and one line on why. If nothing relevant turns up, say so in one line.
4. **Design it in Kelpie's terms.**
   - Pick its grammar (frequent or moment), its springs and its tokens.
   - Check it against the ten rules.
   - Say what it becomes under reduced motion.
   - Give a moment its signature; keep a frequent pattern quick and quiet.
5. **Show it live when motion is the point.** A lab page lets the owner judge an animation before it is built.
6. **Add it to section 5** in the same pull request as the code, with its sources in section 9.

**Already rejected.** Research turned these down; a new design doesn't bring them back without a new decision:
- glass or blur over content;
- glows or ambient motion that loop, apart from the mascot's life in place under its guards (5.19);
- a character that wanders the screen: the mascot lives in its box, and the box moves only with its view (5.14);
- playful verbs in place of real phase names;
- a roster that regroups itself by state.
