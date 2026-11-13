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

<r-group r-if="notice or conflict or step or change.can_reschedule or change.can_cancel or change.why">
  <p r-if="notice" class="notice" role="status" id="change-done">{{ notice | t }}</p>
  <p r-if="conflict" class="notice" role="alert" id="change-conflict">{{ conflict | t({"hours": change.hours, "n": change.moves}) }}</p>

  <section r-if="step == 'change'" aria-labelledby="change-title" id="visit-change-time">
    <h2 id="change-title"><r-t key="my.change.change_title" /></h2>
    <p r-if="pending" class="muted"><r-t key="my.change.pending_hint" /></p>
    <nav class="book-days" :aria-label="'my.change.days' | t">
      <ul class="row">
        <li r-for="d in days"><strong r-if="d.current" aria-current="date">{{ d.label }} <span dir="ltr">{{ d.key }}</span></strong><a r-else :href="d.href">{{ d.label }} <span dir="ltr">{{ d.key }}</span></a></li>
      </ul>
    </nav>
    <x-form action="reschedule" class="stack narrow" id="change-form">
      <input type="hidden" name="day" :value="day">
      <fieldset r-if="slots" id="f-slot" :aria-describedby="'err-slot' if errors.slot else none">
        <legend><r-t key="book.f.slot" /> · {{ day_label }} <span dir="ltr">{{ day }}</span></legend>
        <p r-for="s in slots"><label><input type="radio" name="slot" :value="s.value" :checked="s.checked" required> <span dir="ltr">{{ s.from }}–{{ s.to }}</span></label></p>
      </fieldset>
      <p r-else id="f-slot" tabindex="-1"><r-t key="book.no_slots" /></p>
      <p><button r-if="slots" type="submit" class="btn-brand"><r-t key="my.change.submit_move" /></button> <a :href="change.href_back"><r-t key="my.change.keep" /></a></p>
    </x-form>
  </section>

  <section r-if="step == 'cancel'" aria-labelledby="cancel-title" id="visit-cancel">
    <h2 id="cancel-title"><r-t key="my.change.cancel_title" /></h2>
    <x-form action="cancel" class="stack narrow" id="cancel-form">
      <p><label><r-t key="my.change.f.reason" /> <select name="reason" id="f-reason" :aria-invalid="true if errors.reason else false" :aria-describedby="'err-reason' if errors.reason else none">
        <option value=""><r-t key="my.change.reason.none" /></option>
        <option value="no_longer_needed" :selected="values.reason == 'no_longer_needed'"><r-t key="my.change.reason.no_longer_needed" /></option>
        <option value="found_other_time" :selected="values.reason == 'found_other_time'"><r-t key="my.change.reason.found_other_time" /></option>
        <option value="other" :selected="values.reason == 'other'"><r-t key="my.change.reason.other" /></option>
      </select></label></p>
      <p><label><r-t key="my.change.f.other" /> <textarea name="reason_other" maxlength="200" dir="auto" id="f-reason_other" :aria-invalid="true if errors.reason_other else false" :aria-describedby="'err-reason_other' if errors.reason_other else none">{{ values.reason_other }}</textarea></label></p>
      <p><button type="submit" class="btn-brand" id="cancel-submit"><r-t key="my.change.submit_cancel" /></button> <a :href="change.href_back"><r-t key="my.change.keep" /></a></p>
    </x-form>
  </section>

  <section r-if="step == '' and (change.can_reschedule or change.can_cancel or change.why)" aria-labelledby="change-links-title" id="visit-change">
    <h2 id="change-links-title"><r-t key="my.change.title" /></h2>
    <p r-if="change.can_reschedule or change.can_cancel" class="row">
      <a r-if="change.can_reschedule" :href="change.href_change" id="change-link"><r-t key="my.change.change_link" /></a>
      <a r-if="change.can_cancel" :href="change.href_cancel" id="cancel-link"><r-t key="my.change.cancel_link" /></a>
    </p>
    <p r-if="change.why" id="change-why">{{ change.why | t({"hours": change.hours, "n": change.moves}) }} <r-group r-if="change.phone"><r-t key="my.change.call" /> <a :href="'tel:' ~ change.phone" dir="ltr">{{ change.phone }}</a>.</r-group><r-group r-else><r-t key="my.change.call_us" /></r-group></p>
  </section>

</r-group>  <section aria-labelledby="timeline-title">
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
