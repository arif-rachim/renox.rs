<r-layout use="main">
  <r-group slot="title"><r-t key="dispatch.title" /> · {{ brand.name }}</r-group>
  <h1><r-t key="dispatch.title" /></h1>
  <p class="muted" id="board-state" :data-socket="socket" :data-offline="'dispatch.offline' | t"><r-t key="dispatch.live" /></p>
  <div class="board" id="board">
    <section r-for="c in columns" class="board-column" :aria-labelledby="'head-' ~ c.status">
      <h2 :id="'head-' ~ c.status">{{ ('jobs.status.' ~ c.status) | t }}</h2>
      <div :id="'col-' ~ c.status" class="board-cards">
        <article r-for="j in c.jobs" :id="'job-' ~ j.id" :class="'job-card priority-' ~ j.priority"><a :href="'/jobs/' ~ j.id" dir="ltr">{{ j.number }}</a> <strong>{{ j.customer }}</strong> <span>{{ j.service }}</span> <small dir="ltr">{{ j.start }}</small> <em r-if="j.technician">{{ j.technician }}</em></article>
      </div>
    </section>
  </div>
  <p><a href="/jobs"><r-t key="jobs.title" /></a></p>
  <script>
    (() => {
      // One socket per page. Every message is a fragment the server rendered
      // (partials/job-card.html): a `delete` of the card's old place, then the
      // card put first in its column. The feed's `{ table, rowid, op }` frames
      // are JSON, not HTML, and are skipped.
      const state = document.getElementById("board-state");
      const url = new URL(state.dataset.socket, location.href);
      url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(url);
      socket.addEventListener("message", (e) => {
        if (typeof e.data !== "string" || e.data.trimStart().startsWith("{")) return;
        const tpl = document.createElement("template");
        tpl.innerHTML = e.data;
        for (const el of tpl.content.querySelectorAll("[hx-swap-oob]")) {
          const mode = el.getAttribute("hx-swap-oob");
          if (mode === "delete") {
            const old = document.getElementById(el.id);
            if (old) old.remove();
          } else if (mode === "afterbegin") {
            const col = document.getElementById(el.id);
            if (col) col.prepend(...el.childNodes);
          }
        }
      });
      socket.addEventListener("close", () => { state.textContent = state.dataset.offline || "Not connected. Reload the page."; });
    })();
  </script>
</r-layout>
