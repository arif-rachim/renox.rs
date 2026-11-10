// The dispatch board's live updates (pages/dispatch/index.html), a file of its own (#728): cacheable,
// loaded with `defer`, and the page needs no inline script allowance in its CSP.
(() => {
  // One socket per page. Every message is a fragment the server rendered
  // (partials/job-card.html): a `delete` of the card's old place, then the
  // card put first in its column. The feed's `{ table, rowid, op }` frames
  // are JSON, not HTML, and are skipped. Every change is also written, as
  // one sentence, to the polite live region (#board-announcer) for a screen
  // reader: a new card, a card in another column, a card changed in place.
  const state = document.getElementById("board-state");
  const announcer = document.getElementById("board-announcer");
  const say = (text) => {
    announcer.textContent = "";
    setTimeout(() => { announcer.textContent = text; }, 50);
  };
  const sentence = (kind, number, column) => (announcer.dataset[kind] || "").replace("{number}", number).replace("{column}", column);
  const columnName = (colId) => { const h = document.getElementById("head-" + colId.slice(4)); return h ? h.textContent.trim() : ""; };
  const url = new URL(state.dataset.socket, location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url);
  socket.addEventListener("message", (e) => {
    if (typeof e.data !== "string" || e.data.trimStart().startsWith("{")) return;
    const tpl = document.createElement("template");
    tpl.innerHTML = e.data;
    const was = new Map();
    for (const el of tpl.content.querySelectorAll("[hx-swap-oob]")) {
      const mode = el.getAttribute("hx-swap-oob");
      if (mode === "delete") {
        const old = document.getElementById(el.id);
        if (old) {
          was.set(el.id, old.parentElement ? old.parentElement.id : "");
          old.remove();
        }
      } else if (mode === "afterbegin") {
        const col = document.getElementById(el.id);
        if (!col) continue;
        const card = el.firstElementChild;
        col.prepend(...el.childNodes);
        const number = card && card.querySelector("a") ? card.querySelector("a").textContent.trim() : "";
        const before = card ? was.get(card.id) : undefined;
        if (before === undefined) say(sentence("new", number, columnName(el.id)));
        else if (before !== el.id) say(sentence("moved", number, columnName(el.id)));
        else say(sentence("updated", number, columnName(el.id)));
      }
    }
  });
  socket.addEventListener("close", () => { state.textContent = state.dataset.offline || "Not connected. Reload the page."; say(state.textContent); });
})();
