<r-layout use="main">
  <r-group slot="title">{{ invoice.id }} · {{ brand.name }}</r-group>
  <h1><r-t key="invoice_page.title" :number="invoice.id" /></h1>
  <p><r-t key="approve.for" :name="customer_name" /></p>
  <p class="notice" id="invoice-status">{{ ('invoices.status.' ~ invoice.status) | t }}</p>
  <table id="invoice-lines">
    <thead><tr><th><r-t key="quotes.f.desc" /></th><th><r-t key="quotes.f.qty" /></th><th><r-t key="quotes.f.net" /></th><th><r-t key="quotes.f.vat" /></th></tr></thead>
    <tbody>
      <tr r-for="l in document.lines">
        <td>{{ l.description }}</td>
        <td dir="ltr">{{ l.qty }}</td>
        <td dir="ltr">{{ l.net | money }}</td>
        <td dir="ltr">{{ l.vat | money }} ({{ l.rate }})</td>
      </tr>
    </tbody>
    <tfoot>
      <tr><th colspan="3"><r-t key="quotes.f.vat" /></th><td dir="ltr">{{ document.totals.vat | money }}</td></tr>
      <tr><th colspan="3"><r-t key="quotes.f.total" /></th><td dir="ltr"><strong>{{ document.totals.total | money }}</strong></td></tr>
      <tr><th colspan="3"><r-t key="invoices.f.balance" /></th><td dir="ltr">{{ invoice.balance | money }}</td></tr>
    </tfoot>
  </table>
  <p><r-t key="invoices.f.due" />: <span dir="ltr">{{ invoice.due }}</span></p>
  <p id="invoice-pdf"><a :href="'/l/invoice/' ~ token ~ '/pdf'"><r-t key="invoices.pdf_en" /></a> · <a :href="'/l/invoice/' ~ token ~ '/pdf?lang=ar'"><r-t key="invoices.pdf_ar" /></a></p>
</r-layout>
