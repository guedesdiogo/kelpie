// A popover that grows from its trigger (docs/design-system.md §5.8): from a click, with
// `--spring-fast`; from the keyboard, at once. Escape closes it and returns focus to the trigger
// that opened it, and a press outside closes it. `arrows` moves focus between its items with the
// arrow keys. One panel may have several triggers, as the Display menu has the sidebar's account
// and the header's avatar; it says which opened it in `data-from`, for where it stands.

import { DUR, EASE, fadeIn, fromKeyboard, play, reduced, SPRINGS } from "./motion.js";
import { tips } from "./tips.js";

/**
 * `motion(trigger)` says how the panel enters from that trigger: how far it rises from, its scale
 * and its spring. It grows 6 px down from a trigger above it by default; a phone's sheet rises
 * from below with `--spring-slow` (5.15).
 */
export function popover(
  triggers,
  panel,
  {
    arrows = false,
    onOpen = () => {},
    motion = () => ({ rise: -6, scale: 0.97, spring: SPRINGS.fast }),
  } = {},
) {
  const all = Array.isArray(triggers) ? triggers : [triggers];
  let open = false;
  let opener = all[0];
  const items = () => [
    ...panel.querySelectorAll("a[href], button:not(:disabled), input:not(:disabled)"),
  ];

  function show(trigger = all[0]) {
    open = true;
    opener = trigger;
    panel.dataset.from = trigger.id;
    panel.hidden = false;
    for (const each of all) each.setAttribute("aria-expanded", String(each === trigger));
    onOpen(trigger);
    if (!fromKeyboard()) {
      if (reduced()) fadeIn(panel);
      else {
        const { rise, scale, spring } = motion(trigger);
        play(
          panel,
          [
            { opacity: 0, transform: `translateY(${rise}px) scale(${scale})` },
            { opacity: 1, transform: "none" },
          ],
          spring,
        );
      }
    }
    const current = panel.querySelector('[aria-current="page"], [aria-checked="true"]');
    (current ?? items()[0])?.focus();
  }

  function hide({ restore = true } = {}) {
    if (!open) return;
    open = false;
    for (const each of all) each.setAttribute("aria-expanded", "false");
    if (restore) opener.focus();
    const leaving =
      fromKeyboard() || reduced()
        ? null
        : play(panel, [{ opacity: 1 }, { opacity: 0 }], { duration: DUR.exit, easing: EASE.exit });
    if (!leaving) {
      panel.hidden = true;
      return;
    }
    leaving.finished.then(
      () => {
        if (!open) panel.hidden = true;
      },
      () => {},
    );
  }

  for (const trigger of all) {
    trigger.addEventListener("click", () => {
      if (trigger.getAttribute("aria-disabled") === "true") return;
      if (open && opener === trigger) hide();
      else show(trigger);
    });
  }
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      hide();
      return;
    }
    if (!arrows) return;
    const list = items();
    const index = list.indexOf(document.activeElement);
    const next = {
      ArrowDown: index + 1,
      ArrowUp: index - 1,
      Home: 0,
      End: list.length - 1,
    }[event.key];
    if (next === undefined || list.length === 0) return;
    event.preventDefault();
    list[(next + list.length) % list.length].focus();
  });
  document.addEventListener("pointerdown", (event) => {
    if (!open || panel.contains(event.target)) return;
    if (all.some((trigger) => trigger.contains(event.target))) return;
    hide({ restore: false });
  });

  return {
    show,
    hide,
    get open() {
      return open;
    },
  };
}

/**
 * A row of choices, one of them checked: a radiogroup whose arrow keys move the choice and the
 * focus together, with only the checked one in the tab order (invokta's theme switch). With
 * `icons`, each choice is an icon that says its name in a tooltip, and a chip slides under the
 * checked one: with `--spring-fast` for the pointer, at once for the arrows (the lab's control).
 */
export function segmented(container, { label, choices, value, disabled = false, onChange, icons }) {
  container.replaceChildren();
  container.className = icons ? "segmented icons" : "segmented";
  container.setAttribute("role", "radiogroup");
  container.setAttribute("aria-label", label);
  const chip = icons ? document.createElement("span") : null;
  if (chip) {
    chip.className = "chip";
    chip.setAttribute("aria-hidden", "true");
    container.append(chip);
  }
  const buttons = Object.entries(choices).map(([choice, text]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("role", "radio");
    button.dataset.value = choice;
    if (icons) {
      button.setAttribute("aria-label", text);
      button.dataset.tip = "";
      button.append(icons[choice]());
    } else {
      button.textContent = text;
    }
    button.disabled = disabled;
    button.addEventListener("click", () => select(choice, false));
    container.append(button);
    return button;
  });
  if (icons) tips(container);
  let placed = null;
  /** The chip under the checked choice: it slides there unless `instant`. */
  function place(button, instant) {
    if (!chip || !button) return;
    const to = { x: button.offsetLeft, width: button.offsetWidth };
    chip.style.transform = `translateX(${to.x}px)`;
    chip.style.inlineSize = `${to.width}px`;
    if (!instant && placed && placed.x !== to.x) {
      if (reduced()) fadeIn(chip);
      else
        play(
          chip,
          [{ transform: `translateX(${placed.x}px)` }, { transform: `translateX(${to.x}px)` }],
          SPRINGS.fast,
        );
    }
    placed = to;
  }
  function check(choice, { instant = true } = {}) {
    for (const button of buttons) {
      const checked = button.dataset.value === choice;
      button.setAttribute("aria-checked", String(checked));
      button.tabIndex = checked ? 0 : -1;
    }
    place(
      buttons.find((button) => button.dataset.value === choice),
      instant,
    );
  }
  function select(choice, focus) {
    check(choice, { instant: focus || fromKeyboard() });
    if (focus) buttons.find((button) => button.dataset.value === choice)?.focus();
    onChange(choice);
  }
  container.addEventListener("keydown", (event) => {
    const index = buttons.indexOf(document.activeElement);
    if (index === -1) return;
    const next = {
      ArrowRight: index + 1,
      ArrowDown: index + 1,
      ArrowLeft: index - 1,
      ArrowUp: index - 1,
      Home: 0,
      End: buttons.length - 1,
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    select(buttons[(next + buttons.length) % buttons.length].dataset.value, true);
  });
  check(value);
  return {
    check,
    /** Places the chip again, once the control is laid out (a popover shown). */
    layout: () =>
      place(
        buttons.find((button) => button.getAttribute("aria-checked") === "true"),
        true,
      ),
    buttons,
  };
}
