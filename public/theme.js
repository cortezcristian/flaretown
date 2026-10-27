// Theme: system (follows the OS), light or dark. Loaded in <head> without defer on every page,
// so the right colors apply before the first paint. Pages style dark mode with
// :root[data-theme="dark"] and @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) }.
(() => {
  const KEY = "flaretown.theme";
  const read = () => {
    try {
      const v = localStorage.getItem(KEY);
      return v === "light" || v === "dark" ? v : "system";
    } catch {
      return "system";
    }
  };
  const apply = (mode) => {
    if (mode === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = mode;
  };
  apply(read());
  window.flaretownTheme = {
    get: read,
    // mode: "system" | "light" | "dark". Fires "ft-theme" so canvases (Overview chart) can redraw.
    set(mode) {
      try {
        if (mode === "system") localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, mode);
      } catch {
        /* storage may be unavailable: applies to this page only */
      }
      apply(mode);
      window.dispatchEvent(new CustomEvent("ft-theme", { detail: mode }));
    },
  };
  // Another tab changed it.
  window.addEventListener("storage", (e) => {
    if (e.key === KEY) {
      apply(read());
      window.dispatchEvent(new CustomEvent("ft-theme", { detail: read() }));
    }
  });
})();
