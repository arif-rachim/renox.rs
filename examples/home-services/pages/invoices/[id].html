<r-layout use="main">
  <r-group slot="title">{{ invoice.id }} · {{ brand.name }}</r-group>
  <p><a href="/invoices"><r-t key="invoices.back" /></a></p>
  <h1 dir="ltr">{{ invoice.id }}</h1>
  <p><span :class="'status status-' ~ invoice.status" id="invoice-status">{{ ('invoices.status.' ~ invoice.status) | t }}</span> <span class="status status-overdue" id="invoice-overdue" r-if="invoice.overdue"><r-t key="invoices.status.overdue" /></span></p>
  <dl class="detail">
    <dt><r-t key="invoices.f.customer" /></dt>
    <dd><a r-if="customer" :href="'/customers/' ~ customer.id">{{ customer.name }}</a></dd>
    <dt r-if="invoice.job_id"><r-t key="invoices.f.job" /></dt><dt r-else><r-t key="invoices.f.contract" /></dt>
    <dd dir="ltr"><a :href="invoice.origin_href">{{ invoice.job_number }}</a></dd>
    <dt><r-t key="invoices.f.issued" /></dt>
    <dd dir="ltr">{{ invoice.issued }}</dd>
    <dt><r-t key="invoices.f.due" /></dt>
    <dd dir="ltr">{{ invoice.due }}</dd>
    <dt r-if="invoice.credit_note"><r-t key="invoices.f.credit_note" /></dt>
    <dd r-if="invoice.credit_note" dir="ltr" id="credit-note">{{ invoice.credit_note }}</dd>
  </dl>
  <p class="work-links"><a :href="'/invoices/' ~ invoice.id ~ '/pdf?lang=en'"><r-t key="invoices.pdf_en" /></a> <a :href="'/invoices/' ~ invoice.id ~ '/pdf?lang=ar'"><r-t key="invoices.pdf_ar" /></a> <a r-if="customer" :href="'/customers/' ~ customer.id ~ '/statement.pdf?lang=' ~ pdf_lang"><r-t key="invoices.statement" /></a></p>

  <div class="table-scroll" tabindex="0"><table id="invoice-lines">
    <caption class="visually-hidden"><r-t key="quotes.lines" /></caption>
    <thead><tr><th scope="col"><r-t key="quotes.f.desc" /></th><th scope="col"><r-t key="quotes.f.qty" /></th><th scope="col"><r-t key="quotes.f.unit_price" /></th><th scope="col"><r-t key="quotes.f.net" /></th><th scope="col"><r-t key="quotes.f.vat" /></th></tr></thead>
    <tbody>
      <tr r-for="l in document.lines">
        <td>{{ l.description }}</td>
        <td dir="ltr">{{ l.qty }}</td>
        <td dir="ltr">{{ l.unit_price | money }}</td>
        <td dir="ltr">{{ l.net | money }}</td>
        <td dir="ltr">{{ l.vat | money }} <bdi dir="ltr">({{ l.rate }})</bdi></td>
      </tr>
    </tbody>
    <tfoot>
      <tr><th scope="row" colspan="4"><r-t key="quotes.f.subtotal" /></th><td dir="ltr">{{ document.totals.standard | money }}</td></tr>
      <tr><th scope="row" colspan="4"><r-t key="quotes.f.vat" /></th><td dir="ltr">{{ document.totals.vat | money }}</td></tr>
      <tr><th scope="row" colspan="4"><r-t key="quotes.f.total" /></th><td dir="ltr"><strong id="invoice-total">{{ document.totals.total | money }}</strong></td></tr>
      <tr><th scope="row" colspan="4"><r-t key="invoices.f.paid" /></th><td dir="ltr" id="invoice-paid">{{ invoice.paid | money }}</td></tr>
      <tr><th scope="row" colspan="4"><r-t key="invoices.f.balance" /></th><td dir="ltr" id="invoice-balance">{{ invoice.balance | money }}</td></tr>
    </tfoot>
  </table></div>

  <section id="payments">
    <h2><r-t key="invoices.payments" /></h2>
    <div class="table-scroll" tabindex="0" r-if="payments"><table id="payment-list">
    <caption class="visually-hidden"><r-t key="invoices.payments" /></caption>
      <thead><tr><th scope="col"><r-t key="invoices.f.date" /></th><th scope="col"><r-t key="invoices.f.method" /></th><th scope="col"><r-t key="invoices.f.amount" /></th><th scope="col"><r-t key="invoices.f.reference" /></th></tr></thead>
      <tbody>
        <tr r-for="p in payments" :id="'payment-' ~ p.id">
          <td dir="ltr">{{ p.date }}</td>
          <td>{{ ('invoices.method.' ~ p.method) | t }}<r-group r-if="p.cheque_number"> <span dir="ltr">#{{ p.cheque_number }} · {{ p.cheque_date }}</span></r-group></td>
          <td dir="ltr">{{ p.amount | money }}</td>
          <td>{{ p.reference }}</td>
        </tr>
      </tbody>
    </table></div>
    <p r-else class="muted"><r-t key="invoices.no_payments" /></p>
  </section>

  <section id="pay" r-if="can_pay">
    <h2><r-t key="invoices.pay.title" /></h2>
    <x-form action="pay" class="stack narrow">
      <p><label><r-t key="invoices.f.method" />
        <select name="method" id="pay-method">
          <option r-for="m in methods" :value="m.value" :selected="m.value == values.method">{{ ('invoices.method.' ~ m.value) | t }}</option>
        </select></label></p>
      <p><label><r-t key="invoices.f.amount" /> <input name="amount" inputmode="decimal" dir="ltr" :value="values.amount" required id="f-amount" :aria-invalid="'true' if errors.amount else 'false'" :aria-describedby="'err-amount' if errors.amount else ''" aria-required="true"></label></p>
      <p><label><r-t key="invoices.f.date" /> <input type="date" name="received_on" :value="values.received_on if values.received_on is defined else today" dir="ltr" id="f-received_on" :aria-invalid="'true' if errors.received_on else 'false'" :aria-describedby="'err-received_on' if errors.received_on else ''"></label></p>
      <p><label><r-t key="invoices.f.reference" /> <input name="reference" maxlength="120" :value="values.reference" id="f-reference" :aria-invalid="'true' if errors.reference else 'false'" :aria-describedby="'err-reference' if errors.reference else ''"></label></p>
      <p><label><r-t key="invoices.f.cheque_number" /> <input name="cheque_number" maxlength="40" dir="ltr" :value="values.cheque_number" id="f-cheque_number" :aria-invalid="'true' if errors.cheque_number else 'false'" :aria-describedby="'err-cheque_number' if errors.cheque_number else ''"></label></p>
      <p><label><r-t key="invoices.f.cheque_date" /> <input type="date" name="cheque_date" dir="ltr" :value="values.cheque_date" id="f-cheque_date" :aria-invalid="'true' if errors.cheque_date else 'false'" :aria-describedby="'err-cheque_date' if errors.cheque_date else ''"></label></p>
      <p><small class="muted"><r-t key="invoices.pay.hint" /></small></p>
      <p><button type="submit" class="btn-brand"><r-t key="invoices.pay.submit" /></button></p>
    </x-form>
  </section>

  <section id="link" r-if="can_link">
    <h2><r-t key="invoices.link.title" /></h2>
    <p id="customer-link" r-if="link" dir="ltr">{{ link }}</p>
    <x-form action="link" class="stack narrow"><p><button type="submit"><r-t key="invoices.link.submit" /></button></p></x-form>
  </section>

  <section id="credit" r-if="can_credit">
    <h2><r-t key="invoices.credit.title" /></h2>
    <p class="muted"><r-t key="invoices.credit.hint" /></p>
    <x-form action="credit" class="stack narrow">
      <p><label><r-t key="invoices.f.reason" /> <input name="reason" maxlength="200" :value="values.reason" required id="f-reason" :aria-invalid="'true' if errors.reason else 'false'" :aria-describedby="'err-reason' if errors.reason else ''" aria-required="true"></label></p>
      <p><button type="submit"><r-t key="invoices.credit.submit" /></button></p>
    </x-form>
  </section>
</r-layout>
