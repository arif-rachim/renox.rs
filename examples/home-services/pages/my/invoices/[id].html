<r-layout use="portal">
  <r-group slot="title">{{ invoice.id }} · {{ brand.name }}</r-group>
  <p><a href="/my/invoices"><r-t key="my.invoice.back" /></a></p>
  <h1><r-t key="my.invoice.title" /> <span dir="ltr">{{ invoice.id }}</span></h1>
  <p><span :class="'status status-' ~ invoice.status" id="invoice-status">{{ ('invoices.status.' ~ invoice.status) | t }}</span> · <r-t key="invoices.f.issued" />: <span dir="ltr">{{ invoice.issued }}</span></p>
  <div class="table-scroll" tabindex="0"><table id="invoice-lines">
    <caption class="visually-hidden"><r-t key="quotes.lines" /></caption>
    <thead><tr><th scope="col"><r-t key="quotes.f.desc" /></th><th scope="col"><r-t key="quotes.f.qty" /></th><th scope="col"><r-t key="quotes.f.net" /></th><th scope="col"><r-t key="quotes.f.vat" /></th></tr></thead>
    <tbody>
      <tr r-for="l in document.lines">
        <td>{{ l.description }}</td>
        <td dir="ltr">{{ l.qty }}</td>
        <td dir="ltr">{{ l.net | money }}</td>
        <td dir="ltr">{{ l.vat | money }} <bdi dir="ltr">({{ l.rate }})</bdi></td>
      </tr>
    </tbody>
    <tfoot>
      <tr><th scope="row" colspan="3"><r-t key="quotes.f.vat" /></th><td dir="ltr">{{ document.totals.vat | money }}</td></tr>
      <tr><th scope="row" colspan="3"><r-t key="quotes.f.total" /></th><td dir="ltr"><strong>{{ document.totals.total | money }}</strong></td></tr>
      <tr><th scope="row" colspan="3"><r-t key="invoices.f.balance" /></th><td dir="ltr" id="invoice-balance">{{ invoice.balance | money }}</td></tr>
    </tfoot>
  </table></div>
  <p r-if="open"><r-t key="invoices.f.due" />: <span dir="ltr" id="invoice-due">{{ invoice.due }}</span></p>
  <p id="invoice-pdf"><a :href="pdf" class="btn-brand"><r-t key="my.invoice.pdf" /></a></p>
  <section r-if="instructions" aria-labelledby="how-to-pay" id="payment-instructions">
    <h2 id="how-to-pay"><r-t key="my.invoice.how_to_pay" /></h2>
    <p r-for="line in instructions" dir="auto">{{ line }}</p>
  </section>
</r-layout>
