<r-layout use="main">
  <r-group slot="title">{{ job.number }} · {{ brand.name }}</r-group>
  <p><a href="/jobs"><r-t key="jobs.back" /></a></p>
  <h1 dir="ltr">{{ job.number }}</h1>
  <p><span :class="'status status-' ~ job.status" id="job-status">{{ ('jobs.status.' ~ job.status) | t }}</span> <span :class="'priority priority-' ~ job.priority">{{ ('jobs.priority.' ~ job.priority) | t }}</span></p>
  <dl class="detail">
    <dt><r-t key="jobs.f.customer" /></dt>
    <dd><a r-if="customer" :href="'/customers/' ~ customer.id">{{ customer.name }}</a> <span dir="ltr" r-if="customer">{{ customer.phone }}</span></dd>
    <dt><r-t key="jobs.f.site" /></dt>
    <dd r-if="site">{{ site.label }} · {{ site.area }}, {{ site.address }}</dd>
    <dt><r-t key="jobs.f.service" /></dt>
    <dd>{{ job.service }}</dd>
    <dt r-if="quote"><r-t key="jobs.f.quote" /></dt>
    <dd r-if="quote" dir="ltr"><a :href="'/quotes/' ~ quote.id">{{ quote.number }}</a></dd>
    <dt><r-t key="jobs.f.when" /></dt>
    <dd dir="ltr" id="job-when"><r-group r-if="job.start">{{ job.start }}–{{ job.end }}</r-group><r-group r-else><r-t key="jobs.unscheduled" /></r-group></dd>
    <dt><r-t key="jobs.f.technician" /></dt>
    <dd id="job-technician">{{ job.technician }}</dd>
  </dl>
  <p r-if="job.description">{{ job.description }}</p>

  <section id="schedule" r-if="can_schedule">
    <h2><r-t key="jobs.schedule.title" /></h2>
    <form class="search" action="" method="get">
      <label><r-t key="jobs.schedule.day" /> <input type="date" name="day" :value="pick_day" dir="ltr"></label>
      <label><r-t key="jobs.schedule.technician" />
        <select name="technician">
          <option value="">—</option>
          <option r-for="t in technicians" :value="t.id" :selected="t.picked">{{ t.name }}</option>
        </select></label>
      <button type="submit"><r-t key="jobs.schedule.show" /></button>
    </form>
    <x-form action="schedule" class="stack narrow">
      <p r-if="slots"><label><r-t key="jobs.schedule.pick" />
        <select name="slot" id="slots" size="8">
          <option r-for="s in slots" :value="s.value" :selected="values.form == 'schedule' and values.slot == s.value">{{ s.label }}</option>
        </select></label></p>
      <p r-else id="no-slots"><r-t key="jobs.schedule.none" /></p>
      <p><label><r-t key="jobs.f.note" /> <input name="note" maxlength="200" :value="values.note if values.form == 'schedule' else ''"></label></p>
      <p><button type="submit" class="btn-brand"><r-t key="jobs.schedule.submit" /></button></p>
    </x-form>
  </section>

  <section id="assign" r-if="can_schedule">
    <h2><r-t key="jobs.assign.title" /></h2>
    <x-form action="assign" class="stack narrow">
      <p><select name="technician" required>
        <option r-for="t in technicians" :value="t.id" :selected="(values.form == 'assign' and t.id == values.technician) or (values.form != 'assign' and t.assigned)">{{ t.name }}</option>
      </select></p>
      <p><button type="submit"><r-t key="jobs.assign.submit" /></button></p>
    </x-form>
  </section>

  <section id="move" r-if="next">
    <h2><r-t key="jobs.move.title" /></h2>
    <r-group r-for="s in next">
      <x-form action="status" class="stack narrow">
        <input type="hidden" name="to" :value="s">
        <p><button type="submit">{{ ('jobs.status.' ~ s) | t }}</button></p>
      </x-form>
    </r-group>
  </section>

  <section id="cancel" r-if="can_cancel">
    <h2><r-t key="jobs.cancel.title" /></h2>
    <x-form action="cancel" class="stack narrow">
      <p><label><r-t key="jobs.f.note" /> <input name="note" maxlength="200" :value="values.note if values.form == 'cancel' else ''"></label></p>
      <p><button type="submit"><r-t key="jobs.cancel.submit" /></button></p>
    </x-form>
  </section>

  <section id="visit" r-if="visit">
    <h2><r-t key="visits.visit" /></h2>
    <p dir="ltr" id="visit-times">{{ visit.checkin }}<r-group r-if="visit.checkout"> → {{ visit.checkout }}</r-group></p>
    <p r-if="visit.notes" dir="auto">{{ visit.notes }}</p>
    <ul class="photos" r-if="visit.before" id="photos-before">
      <li r-for="p in visit.before"><x-image r-if="p.image" :src="p.image" width="120" :alt="p.caption" class="thumb"></x-image><small r-else><r-t key="visits.photos.not_stored" /></small><small r-if="p.caption">{{ p.caption }}</small></li>
    </ul>
    <ul class="photos" r-if="visit.after" id="photos-after">
      <li r-for="p in visit.after"><x-image r-if="p.image" :src="p.image" width="120" :alt="p.caption" class="thumb"></x-image><small r-else><r-t key="visits.photos.not_stored" /></small><small r-if="p.caption">{{ p.caption }}</small></li>
    </ul>
    <ul r-if="visit.parts" id="visit-parts">
      <li r-for="p in visit.parts" dir="auto">{{ p.qty }} × {{ p.description }} · <span dir="ltr">{{ p.total }}</span></li>
    </ul>
    <p r-if="visit.signed_by" id="signed-by"><r-t key="visits.signature.saved" :name="visit.signed_by" /></p>
    <r-group r-if="can_edit_summary">
      <x-form action="summary" class="stack narrow">
        <p><label><r-t key="visits.summary.en" /> <textarea name="summary_en" rows="3" maxlength="400" dir="ltr">{{ values.summary_en if values.summary_en is defined else visit.summary_en }}</textarea></label></p>
        <p><label><r-t key="visits.summary.ar" /> <textarea name="summary_ar" rows="3" maxlength="400" dir="rtl">{{ values.summary_ar if values.summary_ar is defined else visit.summary_ar }}</textarea></label></p>
        <p><button type="submit"><r-t key="visits.summary.save" /></button></p>
      </x-form>
    </r-group>
    <p r-if="visit.closed" class="work-links"><a :href="'/visits/' ~ visit.id ~ '/report?lang=en'"><r-t key="visits.report.en" /></a> <a :href="'/visits/' ~ visit.id ~ '/report?lang=ar'"><r-t key="visits.report.ar" /></a></p>
  </section>

  <section id="invoice" r-if="invoice">
    <h2><r-t key="invoices.f.number" /></h2>
    <p><a :href="'/invoices/' ~ invoice.id" dir="ltr">{{ invoice.id }}</a> · {{ ('invoices.status.' ~ invoice.status) | t }}</p>
  </section>

  <section id="invoice-issue" r-if="can_invoice">
    <h2><r-t key="invoices.issue" /></h2>
    <p class="muted"><r-t key="invoices.issue_hint" /></p>
    <form method="post" :action="'/jobs/' ~ job.id ~ '/invoice?/default'" class="stack narrow"><x-csrf /><p><button type="submit" class="btn-brand"><r-t key="invoices.issue" /></button></p></form>
  </section>

  <section id="timeline">
    <h2><r-t key="jobs.timeline" /></h2>
    <ol class="timeline">
      <li r-for="e in events" :id="'event-' ~ e.id">
        <span dir="ltr">{{ e.at }}</span>
        <strong r-if="e.created"><r-t key="jobs.created_event" /></strong>
        <strong r-else>{{ ('jobs.status.' ~ e.from) | t }} → {{ ('jobs.status.' ~ e.to) | t }}</strong>
        <span r-if="e.by">· {{ e.by }}</span>
        <span r-if="e.note">· {{ e.note }}</span>
      </li>
    </ol>
  </section>
</r-layout>
