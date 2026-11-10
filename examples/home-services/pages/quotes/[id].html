<r-layout use="main">
  <r-group slot="title">{{ quote.number }} · {{ brand.name }}</r-group>
  <p><a href="/quotes"><r-t key="quotes.back" /></a></p>
  <h1 dir="ltr">{{ quote.number }}</h1>
  <p><span :class="'status status-' ~ quote.status" id="quote-status">{{ ('quotes.status.' ~ quote.status) | t }}</span></p>
  <dl class="detail">
    <dt><r-t key="quotes.f.customer" /></dt>
    <dd><a r-if="customer" :href="'/customers/' ~ customer.id">{{ customer.name }}</a> <span dir="ltr" r-if="customer">{{ customer.phone }}</span></dd>
    <dt><r-t key="quotes.f.site" /></dt>
    <dd r-if="site">{{ site.label }} · {{ site.area }}, {{ site.address }}</dd>
    <dt><r-t key="quotes.f.valid_until" /></dt>
    <dd dir="ltr">{{ quote.valid_until }}</dd>
    <dt r-if="quote.approved_at"><r-t key="quotes.f.answered_at" /></dt>
    <dd r-if="quote.approved_at" dir="ltr">{{ quote.approved_at }} <small r-if="quote.approved_ip">({{ quote.approved_ip }})</small></dd>
  </dl>
  <table id="lines">
    <caption class="visually-hidden"><r-t key="quotes.lines" /></caption>
    <thead><tr><th scope="col"><r-t key="quotes.f.desc" /></th><th scope="col"><r-t key="quotes.f.qty" /></th><th scope="col"><r-t key="quotes.f.unit_price" /></th><th scope="col"><r-t key="quotes.f.net" /></th><th scope="col"><r-t key="quotes.f.vat" /></th><th scope="col"><r-t key="quotes.f.total" /></th></tr></thead>
    <tbody>
      <tr r-for="l in lines" :id="'line-' ~ l.id">
        <td>{{ l.description }}</td>
        <td dir="ltr">{{ l.qty }}</td>
        <td dir="ltr">{{ l.unit_price | money }}</td>
        <td dir="ltr">{{ l.net | money }}</td>
        <td dir="ltr">{{ l.vat | money }} ({{ l.vat_rate }}%)</td>
        <td dir="ltr">{{ l.total | money }}</td>
      </tr>
    </tbody>
    <tfoot>
      <tr><th scope="row" colspan="5"><r-t key="quotes.f.subtotal" /></th><td dir="ltr" id="subtotal">{{ quote.subtotal | money }}</td></tr>
      <tr><th scope="row" colspan="5"><r-t key="quotes.f.vat" /></th><td dir="ltr" id="vat">{{ quote.vat | money }}</td></tr>
      <tr><th scope="row" colspan="5"><r-t key="quotes.f.total" /></th><td dir="ltr" id="total"><strong>{{ quote.total | money }}</strong></td></tr>
    </tfoot>
  </table>
  <p r-if="quote.notes"><strong><r-t key="quotes.f.notes" />:</strong> {{ quote.notes }}</p>
  <p id="pdf-links"><r-t key="quotes.pdf" />: <a :href="'/quotes/' ~ quote.id ~ '/pdf?lang=en'" lang="en">English</a> · <a :href="'/quotes/' ~ quote.id ~ '/pdf?lang=ar'" lang="ar">العربية</a><r-group r-if="quote.status == 'approved'"> · <a id="make-job" r-can="job.write" :href="'/jobs/new?quote=' ~ quote.id"><r-t key="jobs.new" /></a></r-group></p>
  <section r-can="quote.write" r-if="can_send">
    <x-form action="send" class="stack narrow">
      <button type="submit" class="btn-brand" r-if="is_draft"><r-t key="quotes.send" /></button>
      <button type="submit" r-else><r-t key="quotes.new_link" /></button>
    </x-form>
  </section>
  <section class="notice" id="approval-link" r-if="link">
    <p><r-t key="quotes.link_note" /></p>
    <p><input type="text" readonly :value="link" :aria-label="'quotes.link_label' | t" dir="ltr" size="70"></p>
  </section>
</r-layout>
