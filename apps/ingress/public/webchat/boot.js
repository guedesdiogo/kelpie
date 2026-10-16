// The owner's display choices (#140), applied before the first paint. A classic script, not a
// module, so it runs before anything is drawn; the page's policy forbids inline scripts. It sets
// on <html> what tokens.css and style.css read: `data-theme` (light or dark; absent follows the
// system), `data-contrast="more"`, and `data-reduced` when the system asks for reduced motion or
// the owner turned the less-motion switch on (docs/design-system.md §4.4 rule 10). The page's
// Display menu changes them through `globalThis.kelpieDisplay`.

(() => {
  const KEY = "kelpie.display";
  const CHOICES = {
    theme: ["system", "light", "dark"],
    motion: ["system", "less"],
    contrast: ["system", "more"],
  };
  const root = document.documentElement;
  const media = {
    dark: matchMedia("(prefers-color-scheme: dark)"),
    reduced: matchMedia("(prefers-reduced-motion: reduce)"),
    more: matchMedia("(prefers-contrast: more)"),
  };

  /** A stored choice, or "system" for anything else. */
  function valid(stored) {
    const display = {};
    for (const [name, values] of Object.entries(CHOICES)) {
      display[name] = values.includes(stored?.[name]) ? stored[name] : "system";
    }
    return display;
  }

  function load() {
    try {
      return valid(JSON.parse(localStorage.getItem(KEY) ?? "null"));
    } catch {
      return valid(null);
    }
  }

  // Without storage, a choice lasts until the page closes.
  let current = load();
  const listeners = new Set();

  function apply() {
    if (current.theme === "system") root.removeAttribute("data-theme");
    else root.dataset.theme = current.theme;
    if (current.contrast === "more" || media.more.matches) root.dataset.contrast = "more";
    else root.removeAttribute("data-contrast");
    root.toggleAttribute("data-reduced", current.motion === "less" || media.reduced.matches);
    // The phone's browser bar takes the page's background, in the theme that is showing.
    const meta = document.querySelector('meta[name="theme-color"]');
    const background = getComputedStyle(root).getPropertyValue("--bg").trim();
    if (meta && background) meta.content = background;
    for (const listener of listeners) listener();
  }

  globalThis.kelpieDisplay = {
    get current() {
      return { ...current };
    },
    /** Whether motion is reduced, by the system or the less-motion switch. */
    get reduced() {
      return root.hasAttribute("data-reduced");
    },
    /** Whether the system itself asks for reduced motion, which the switch can't turn off. */
    get systemReduced() {
      return media.reduced.matches;
    },
    set(change) {
      current = valid({ ...current, ...change });
      try {
        localStorage.setItem(KEY, JSON.stringify(current));
      } catch {
        // Kept for this page only.
      }
      apply();
    },
    /** Runs `listener` after every change, the system's included. */
    onChange(listener) {
      listeners.add(listener);
    },
  };

  apply();
  for (const query of Object.values(media)) query.addEventListener("change", apply);
})();
