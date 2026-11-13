<r-layout use="main">
  <r-group slot="title"><r-t key="dispatch.title" /> · {{ brand.name }}</r-group>
  <h1><r-t key="dispatch.title" /></h1><p class="notice" id="online-to-confirm" r-if="to_confirm"><a href="/jobs?source=self_booking"><r-t key="dispatch.to_confirm" :n="to_confirm" /></a></p>
  <p class="muted" id="board-state" :data-socket="socket" :data-offline="'dispatch.offline' | t"><r-t key="dispatch.live" /></p>
  <div aria-live="polite" class="visually-hidden" id="board-announcer" :data-new="'dispatch.announce.new' | t" :data-moved="'dispatch.announce.moved' | t" :data-updated="'dispatch.announce.updated' | t"></div>
  <div class="board" id="board">
    <section r-for="c in columns" class="board-column" :aria-labelledby="'head-' ~ c.status">
      <h2 :id="'head-' ~ c.status">{{ ('jobs.status.' ~ c.status) | t }}</h2>
      <div :id="'col-' ~ c.status" class="board-cards">
        <article r-for="j in c.jobs" :id="'job-' ~ j.id" :class="'job-card priority-' ~ j.priority"><a :href="'/jobs/' ~ j.id" dir="ltr">{{ j.number }}</a> <strong>{{ j.customer }}</strong> <span>{{ j.service }}</span> <small dir="ltr">{{ j.start }}</small> <em r-if="j.technician">{{ j.technician }}</em> <span r-if="j.priority != 'normal'" class="priority">{{ ('jobs.priority.' ~ j.priority) | t }}</span><r-group r-if="j.online"> <span class="badge"><r-t key="jobs.badge.self_booking" /></span></r-group><r-group r-if="j.wants"> <small class="wants"><r-t key="dispatch.wants" /> {{ ('backoffice.hours.day.' ~ j.wants_wd) | t }} <span dir="ltr">{{ j.wants }}</span></small></r-group></article>
      </div>
      <p r-if="c.more"><a :href="c.all_href"><r-t key="dispatch.show_all" :n="c.total" /></a></p>
    </section>
  </div>
  <p><a href="/jobs"><r-t key="jobs.title" /></a></p>
  <script src="/board.js" defer></script>
</r-layout>
