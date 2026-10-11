// Palette picker: the swatch button in the rail foot.
//
// The stylesheet reads three custom properties off <html>: --p-ground (the background in dark mode),
// --p-ink (the text in dark mode) and --p-signal (the one accent). Everything else is mixed from
// those, and light mode swaps ground and ink, so a palette is a complete theme.
//
// index.html declares the default with data-palette="ground,ink,signal" on <html>. A chosen palette is
// remembered per browser. This file loads in <head> so the saved palette is applied before first paint.

(() => {
  "use strict";
  const KEY = "prompt-trials.palette";
  const root = document.documentElement;

  const PRESETS = [
    { name: "Steel and azure", colors: ["#101c2b", "#e6edf5", "#5b9dff"] },
    { name: "Aubergine and mint", colors: ["#241527", "#f0e6f1", "#35c892"] },
    { name: "Graphite and chartreuse", colors: ["#1d2021", "#ebece6", "#9cc030"] },
    { name: "Olive and pink", colors: ["#1c1e11", "#eceedd", "#ff7cc4"] },
    { name: "Obsidian and ice", colors: ["#090d18", "#e4e9f4", "#b8d0ff"] },
  ];

  const HEX = /^#[0-9a-f]{6}$/i;
  const valid = (c) => Array.isArray(c) && c.length === 3 && c.every((x) => typeof x === "string" && HEX.test(x));

  const pageDefault = (root.dataset.palette ?? "").split(",").filter(Boolean);
  const defaults = valid(pageDefault) ? pageDefault : PRESETS[0].colors;

  function read() {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) ?? "null");
      if (valid(saved)) return saved;
    } catch {
      /* fall through to the default */
    }
    return defaults;
  }

  function apply(colors) {
    const [ground, ink, signal] = colors;
    root.style.setProperty("--p-ground", ground);
    root.style.setProperty("--p-ink", ink);
    root.style.setProperty("--p-signal", signal);
  }

  function save(colors) {
    try {
      localStorage.setItem(KEY, JSON.stringify(colors));
    } catch {
      /* the choice just won't persist */
    }
  }

  let colors = read();
  apply(colors);

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "text") node.textContent = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    node.append(...children);
    return node;
  }

  function buildPanel() {
    const host = document.getElementById("rail-tools") ?? document.body;
    const code = el("code", { class: "pal-code", text: colors.join(", ") });
    const set = (next, persist = true) => {
      colors = next;
      apply(colors);
      if (persist) save(colors);
      inputs.forEach(({ input }, i) => (input.value = colors[i]));
      code.textContent = colors.join(", ");
      markActive();
    };
    const markActive = () => {
      PRESETS.forEach((p, i) => {
        const on = p.colors.every((c, j) => c.toLowerCase() === colors[j].toLowerCase());
        presetButtons[i]?.setAttribute("aria-pressed", String(on));
      });
    };

    const inputs = ["Background", "Text", "Accent"].map((label, i) => {
      const id = `pal-${i}`;
      const input = el("input", { type: "color", id, value: colors[i] });
      input.addEventListener("input", () => set(colors.map((c, j) => (j === i ? input.value : c))));
      return { input, row: el("div", { class: "pal-field" }, input, el("label", { for: id, text: label })) };
    });

    const presetButtons = PRESETS.map((p) =>
      el(
        "button",
        { type: "button", class: "pal-preset", title: p.name, "aria-label": `Use ${p.name}`, "aria-pressed": "false", onclick: () => set([...p.colors]) },
        ...p.colors.map((c) => el("span", { style: `background:${c}` }))
      )
    );
    const presets = el("div", { class: "pal-presets" }, ...presetButtons);

    const reset = el("button", {
      type: "button",
      class: "pal-reset",
      text: "Back to the default",
      onclick: () => {
        set([...defaults], false);
        try {
          localStorage.removeItem(KEY);
        } catch {
          /* nothing saved */
        }
      },
    });

    const panel = el("div", { class: "pal-panel", id: "pal-panel", role: "dialog", "aria-label": "Palette", hidden: "" },
      el("div", { class: "pal-heading", text: "Palette" }), presets, ...inputs.map((x) => x.row), code, reset);

    const toggle = el("button", { type: "button", class: "pal-toggle", "aria-expanded": "false", "aria-controls": "pal-panel", "aria-label": "Palette", title: "Palette",
      onclick: () => {
        panel.hidden = !panel.hidden;
        toggle.setAttribute("aria-expanded", String(!panel.hidden));
      } });
    toggle.append(...["ground", "ink", "signal"].map((n) => el("span", { style: `background:var(--p-${n})` })));

    markActive();
    const box = el("div", { class: "pal" }, panel, toggle);
    const close = () => {
      panel.hidden = true;
      toggle.setAttribute("aria-expanded", "false");
    };
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !panel.hidden) {
        close();
        toggle.focus();
      }
    });
    document.addEventListener("pointerdown", (e) => {
      if (!panel.hidden && !box.contains(e.target)) close();
    });
    host.append(box);
  }

  document.addEventListener("DOMContentLoaded", buildPanel);
})();
