// The live Logs view (#307): opens the page's SSE route and puts each
// published batch of rows on top of the table. If the stream cannot open or
// ends, it turns on the page's 2-second poll (the hx-trigger condition on
// #log-poll) instead.
(function () {
  const live = document.getElementById("log-live");
  const url = live && live.dataset.sse;
  window.renoxLogsPoll = true;
  if (!url || !window.EventSource) return;
  const es = new EventSource(url);
  es.addEventListener("open", () => (window.renoxLogsPoll = false));
  es.addEventListener("log-rows", (e) => {
    const rows = document.getElementById("log-rows");
    if (!rows) return;
    const empty = rows.querySelector("td.muted:only-child");
    if (empty) empty.parentElement.remove();
    rows.insertAdjacentHTML("afterbegin", e.data);
    while (rows.children.length > 200) rows.lastElementChild.remove();
  });
  const fallback = () => {
    es.close();
    window.renoxLogsPoll = true;
  };
  es.addEventListener("log-end", fallback);
  es.addEventListener("error", () => {
    if (es.readyState === EventSource.CLOSED) fallback();
    else window.renoxLogsPoll = true;
  });
})();
