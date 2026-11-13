<r-layout use="portal">
  <r-group slot="title"><r-t key="my.visit.title" /> · {{ brand.name }}</r-group>
  <p><a href="/my"><r-t key="my.visit.back" /></a></p>
  <h1>{{ visit.service }} <span dir="ltr">{{ visit.number }}</span></h1>
  <p><span :class="'status status-' ~ visit.status" id="visit-status">{{ visit.status_key | t }}</span></p>
  <dl class="detail" id="visit-detail">
    <dt><r-t key="my.visit.when" /></dt>
    <dd r-if="visit.has_time">{{ visit.weekday }} <span dir="ltr">{{ visit.day }}</span> <span dir="ltr">{{ visit.from }}–{{ visit.to }}</span><r-group r-if="visit.waiting"> · <r-t key="my.visit.waiting" /></r-group></dd>
    <dd r-else><r-t key="my.upcoming.no_time" /></dd>
    <dt><r-t key="my.visit.where" /></dt>
    <dd>{{ visit.site }}<r-group r-if="visit.address"> · {{ visit.address }}</r-group></dd>
    <dt r-if="visit.technician"><r-t key="my.technician" /></dt>
    <dd r-if="visit.technician" id="visit-technician">{{ visit.technician }}</dd>
    <dt r-if="visit.notes"><r-t key="my.visit.notes" /></dt>
    <dd r-if="visit.notes" dir="auto" id="visit-notes">{{ visit.notes }}</dd>
    <dt><r-t key="my.visit.contact" /></dt>
    <dd>{{ visit.branch_name }}<r-group r-if="visit.branch_phone"> · <a :href="'tel:' ~ visit.branch_phone" dir="ltr" id="branch-phone">{{ visit.branch_phone }}</a></r-group></dd>
  </dl>

  <section aria-labelledby="timeline-title">
    <h2 id="timeline-title"><r-t key="my.visit.timeline" /></h2>
    <ol class="my-timeline" r-if="visit.timeline" id="timeline">
      <li r-for="e in visit.timeline">{{ e.key | t }} · <span dir="ltr">{{ e.day }} {{ e.time }}</span></li>
    </ol>
    <p r-else class="muted"><r-t key="my.visit.no_timeline" /></p>
  </section>

  <section r-if="report" aria-labelledby="report-title" id="visit-report">
    <h2 id="report-title"><r-t key="my.report.title" /></h2>
    <r-group r-if="report.summary">
      <h3><r-t key="my.report.done" /></h3>
      <p dir="auto" id="report-summary">{{ report.summary }}</p>
    </r-group>
    <r-group r-if="report.has_parts">
      <h3><r-t key="report_page.parts" /></h3>
      <ul id="report-parts">
        <li r-for="p in report.parts">{{ p.description }} × <span dir="ltr">{{ p.qty }}</span></li>
      </ul>
    </r-group>
    <r-group r-if="report.before">
      <h3><r-t key="visits.photos.before" /></h3>
      <ul class="photos" id="photos-before">
        <li r-for="p in report.before"><a :href="p.href"><x-image r-if="p.image" :src="p.image" width="160" loading="lazy" :alt="p.caption or ('visits.photos.alt' | t)" class="thumb"></x-image><r-group r-else><r-t key="my.report.open_photo" /></r-group></a><small r-if="p.caption">{{ p.caption }}</small></li>
      </ul>
    </r-group>
    <r-group r-if="report.after">
      <h3><r-t key="visits.photos.after" /></h3>
      <ul class="photos" id="photos-after">
        <li r-for="p in report.after"><a :href="p.href"><x-image r-if="p.image" :src="p.image" width="160" loading="lazy" :alt="p.caption or ('visits.photos.alt' | t)" class="thumb"></x-image><r-group r-else><r-t key="my.report.open_photo" /></r-group></a><small r-if="p.caption">{{ p.caption }}</small></li>
      </ul>
    </r-group>
    <p r-if="report.signed_by" id="report-signed"><r-t key="my.report.signed_by" /> {{ report.signed_by }} · <span dir="ltr">{{ report.signed_day }} {{ report.signed_time }}</span></p>
    <p><a :href="report.pdf" class="btn-brand" id="report-pdf"><r-t key="my.report.pdf" /></a></p>
  </section>
</r-layout>
