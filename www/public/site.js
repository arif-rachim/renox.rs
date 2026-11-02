// www: the landing page's behaviour. Everything here enhances a page that
// already reads in full without it: the deploy list is a table, the module
// switches show every module's text, the stages and the showcase are radios.
// Loaded with <x-script> (the request's CSP nonce); no other origin.
(() => {
  const root = document.documentElement;

  // The live thing: the deploy list in the hero promotes and rolls back.
  const deploys = document.querySelector("[data-deploys]");
  if (deploys) {
    const rows = [...deploys.querySelectorAll("tr[data-hash]")];
    const label = deploys.querySelector("[data-live-label]");
    const note = deploys.querySelector("[data-deploy-note]");
    const show = (live) => {
      const at = rows.indexOf(live);
      rows.forEach((row, i) => {
        const isLive = row === live;
        row.classList.toggle("is-live", isLive);
        row.querySelector("[data-state]").textContent = isLive ? "live" : "superseded";
        const btn = row.querySelector("[data-act]");
        btn.textContent = isLive ? "Live" : i < at ? "Promote" : "Roll back";
        btn.disabled = isLive;
      });
    };
    rows.forEach((row) =>
      row.querySelector("[data-act]").addEventListener("click", () => {
        const before = rows.find((r) => r.classList.contains("is-live"));
        const back = rows.indexOf(row) > rows.indexOf(before);
        show(row);
        label.textContent = `Live: ${row.dataset.hash}`;
        note.textContent = `${back ? "Rolled back" : "Promoted"} to ${row.dataset.hash}. The previous version is one click away.`;
      }),
    );
    show(rows.find((r) => r.classList.contains("is-live")) ?? rows[0]);
  }

  // Module switches: a band is lit when its module is on.
  for (const band of document.querySelectorAll("[data-band]")) {
    const sw = band.querySelector('[role="switch"]');
    const set = (on) => {
      sw.setAttribute("aria-checked", String(on));
      band.classList.toggle("on", on);
    };
    set(sw.getAttribute("aria-checked") === "true");
    sw.addEventListener("click", () => set(sw.getAttribute("aria-checked") !== "true"));
  }

  // The closing sentence: the app's name becomes its address as it is typed.
  const name = document.querySelector("[data-app-name]");
  const host = document.querySelector("[data-app-host]");
  if (name && host) {
    const update = () => {
      const slug = name.value.toLowerCase().replace(/[^a-z0-9-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 40) || "my-shop";
      host.textContent = `${slug}.renoxium.app`;
    };
    name.addEventListener("input", update);
    update();
  }

  // Entrances: the parts of each section rise in, once, as the section arrives.
  if (matchMedia("(prefers-reduced-motion: reduce)").matches || !("IntersectionObserver" in window)) {
    root.classList.add("rx-still");
    return;
  }
  const parts = "h2, .lede, .flow-intro p, .show-names label, .show-stage, .band, .stage, .uae-left, .uae-right > *, .tile, .plans-head p, .close-note, .node";
  const sections = document.querySelectorAll("main > section, main > .node");
  const seen = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add("rx-in");
        seen.unobserve(e.target);
      }
    },
    { rootMargin: "0px 0px -10% 0px" },
  );
  for (const section of sections) {
    const items = section.matches(".node") ? [section] : [...section.querySelectorAll(parts)];
    items.forEach((el, i) => {
      el.classList.add("rx-enter", `rx-d${Math.min(i, 5)}`);
      seen.observe(el);
    });
  }
})();
