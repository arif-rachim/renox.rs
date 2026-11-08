<r-layout use="main">
  <r-group slot="title">{{ contract.number }} · {{ brand.name }}</r-group>
  <p><a href="/contracts"><r-t key="contracts.back" /></a></p>
  <h1 dir="ltr">{{ contract.number }}</h1>
  <p><span :class="'status status-' ~ contract.status" id="contract-status">{{ ('contracts.status.' ~ contract.status) | t }}</span></p>
  <dl class="detail">
    <dt><r-t key="contracts.f.customer" /></dt>
    <dd><a r-if="customer" :href="'/customers/' ~ customer.id">{{ customer.name }}</a></dd>
    <dt><r-t key="contracts.f.term" /></dt>
    <dd dir="ltr">{{ contract.starts_on }} → {{ contract.ends_on }}</dd>
    <dt><r-t key="contracts.f.price_year" /></dt>
    <dd dir="ltr" id="contract-price">{{ contract.price | money }}</dd>
    <dt><r-t key="contracts.f.vat" /></dt>
    <dd dir="ltr">{{ contract.vat | money }}</dd>
    <dt><r-t key="contracts.f.total" /></dt>
    <dd dir="ltr"><strong>{{ contract.total | money }}</strong></dd>
    <dt r-if="contract.invoice_id"><r-t key="contracts.f.invoice" /></dt>
    <dd r-if="contract.invoice_id" dir="ltr"><a id="contract-invoice" :href="'/invoices/' ~ contract.invoice_id">{{ contract.invoice_id }}</a></dd>
    <dt r-if="renewed_from"><r-t key="contracts.f.renewed_from" /></dt>
    <dd r-if="renewed_from" dir="ltr"><a :href="'/contracts/' ~ renewed_from.id">{{ renewed_from.number }}</a></dd>
    <dt r-if="renewal"><r-t key="contracts.f.renewal" /></dt>
    <dd r-if="renewal" dir="ltr"><a id="contract-renewal" :href="'/contracts/' ~ renewal.id">{{ renewal.number }}</a></dd>
  </dl>
  <p r-if="contract.notes" class="muted">{{ contract.notes }}</p>
  <p class="work-links"><a :href="'/contracts/' ~ contract.id ~ '/pdf?lang=en'"><r-t key="contracts.pdf_en" /></a> <a :href="'/contracts/' ~ contract.id ~ '/pdf?lang=ar'"><r-t key="contracts.pdf_ar" /></a></p>

  <section id="items">
    <h2><r-t key="contracts.items" /></h2>
    <table id="item-list">
      <thead><tr><th><r-t key="contracts.f.site" /></th><th><r-t key="contracts.f.service" /></th><th><r-t key="contracts.f.visits" /></th><th><r-t key="contracts.f.next_visit" /></th><th r-if="can_edit"></th></tr></thead>
      <tbody>
        <tr r-for="i in items" :id="'item-' ~ i.id">
          <td>{{ i.site }}<br><small class="muted">{{ i.address }}</small></td>
          <td>{{ i.service }}</td>
          <td dir="ltr">{{ i.visits_per_year }}</td>
          <td dir="ltr">{{ i.next_visit_on }}</td>
          <td r-if="can_edit"><x-form action="remove"><input type="hidden" name="item" :value="i.id"><button type="submit"><r-t key="contracts.remove" /></button></x-form></td>
        </tr>
        <tr r-empty="items"><td colspan="5"><r-t key="contracts.no_items" /></td></tr>
      </tbody>
    </table>
  </section>

  <section id="add-item" r-if="can_edit">
    <h2><r-t key="contracts.add_item" /></h2>
    <x-form action="item" class="stack narrow">
      <p><label><r-t key="contracts.f.site" />
        <select name="site_id" required>
          <option r-for="x in sites" :value="x.id">{{ x.name }}</option>
        </select></label></p>
      <p><label><r-t key="contracts.f.service" />
        <select name="service" required>
          <option r-for="x in catalogue" :value="x.sid">{{ x.name }}</option>
        </select></label></p>
      <p><label><r-t key="contracts.f.visits" /> <input name="visits" inputmode="numeric" dir="ltr" maxlength="2" required></label></p>
      <p><button type="submit"><r-t key="contracts.add_item" /></button></p>
    </x-form>
  </section>

  <section id="visits">
    <h2><r-t key="contracts.visits" /></h2>
    <table r-if="visits" id="visit-list">
      <thead><tr><th><r-t key="contracts.f.due" /></th><th><r-t key="contracts.f.job" /></th><th><r-t key="contracts.f.service" /></th><th><r-t key="contracts.f.site" /></th><th><r-t key="contracts.f.status" /></th></tr></thead>
      <tbody>
        <tr r-for="v in visits" :id="'visit-' ~ v.number">
          <td dir="ltr">{{ v.due_on }}</td>
          <td dir="ltr"><a :href="'/jobs/' ~ v.job_id">{{ v.number }}</a></td>
          <td>{{ v.service }}</td>
          <td>{{ v.site }}</td>
          <td>{{ ('jobs.status.' ~ v.status) | t }}</td>
        </tr>
      </tbody>
    </table>
    <p r-else class="muted"><r-t key="contracts.no_visits" /></p>
  </section>

  <section id="actions" r-if="can_activate">
    <h2><r-t key="contracts.activate.title" /></h2>
    <p class="muted"><r-t key="contracts.activate.hint" /></p>
    <x-form action="activate" class="stack narrow"><p><button type="submit" class="btn-brand" id="contract-activate"><r-t key="contracts.activate.submit" /></button></p></x-form>
  </section>
  <section id="renew" r-if="can_renew">
    <h2><r-t key="contracts.renew.title" /></h2>
    <p class="muted"><r-t key="contracts.renew.hint" /></p>
    <x-form action="renew" class="stack narrow"><p><button type="submit" id="contract-renew"><r-t key="contracts.renew.submit" /></button></p></x-form>
  </section>
  <section id="cancel" r-if="can_cancel">
    <x-form action="cancel" class="stack narrow"><p><button type="submit"><r-t key="contracts.cancel" /></button></p></x-form>
  </section>
</r-layout>
