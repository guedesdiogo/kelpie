// A popover that grows from its trigger (docs/design-system.md §5.8): from a click, with
// `--spring-fast`; from the keyboard, at once. Escape closes it and returns focus to the trigger,
// and a press outside closes it. `arrows` moves focus between its items with the arrow keys.

import { DUR, EASE, fadeIn, fromKeyboard, play, reduced, SPRINGS } from "./motion.js";

export function popover(trigger, panel, { arrows = false, onOpen = () => {} } = {}) {
  let open = false;
  const items = () => [...panel.querySelectorAll("a[href], button:not(:disabled)")];

  function show() {
    open = true;
    panel.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    onOpen();
    if (!fromKeyboard()) {
      if (reduced()) fadeIn(panel);
      else
        play(
          panel,
          [
            { opacity: 0, transform: "translateY(-6px) scale(0.97)" },
            { opacity: 1, transform: "none" },
          ],
          SPRINGS.fast,
        );
    }
    const current = panel.querySelector('[aria-current="page"], [aria-checked="true"]');
    (current ?? items()[0])?.focus();
  }

  function hide({ restore = true } = {}) {
    if (!open) return;
    open = false;
    trigger.setAttribute("aria-expanded", "false");
    if (restore) trigger.focus();
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

  trigger.addEventListener("click", () => {
    if (trigger.getAttribute("aria-disabled") === "true") return;
    if (open) hide();
    else show();
  });
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
    if (open && !panel.contains(event.target) && !trigger.contains(event.target)) {
      hide({ restore: false });
    }
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
 * focus together, with only the checked one in the tab order (invokta's theme switch).
 */
export function segmented(container, { label, choices, value, disabled = false, onChange }) {
  container.replaceChildren();
  container.className = "segmented";
  container.setAttribute("role", "radiogroup");
  container.setAttribute("aria-label", label);
  const buttons = Object.entries(choices).map(([choice, text]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("role", "radio");
    button.dataset.value = choice;
    button.textContent = text;
    button.disabled = disabled;
    button.addEventListener("click", () => select(choice, false));
    container.append(button);
    return button;
  });
  function check(choice) {
    for (const button of buttons) {
      const checked = button.dataset.value === choice;
      button.setAttribute("aria-checked", String(checked));
      button.tabIndex = checked ? 0 : -1;
    }
  }
  function select(choice, focus) {
    check(choice);
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
  return { check };
}
