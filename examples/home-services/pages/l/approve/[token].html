<r-layout use="main">
  <r-group slot="title">{{ quote.number }} · {{ brand.name }}</r-group>
  <h1><r-t key="approve.title" :number="quote.number" /></h1>
  <p><r-t key="approve.for" :name="customer_name" /></p>
  <p class="notice" id="state-approved" r-if="is_approved"><r-t key="approve.state.approved" /></p>
  <p class="notice" id="state-rejected" r-if="is_rejected"><r-t key="approve.state.rejected" /></p>
  <p class="notice" id="state-expired" r-if="is_expired"><r-t key="approve.state.expired" /></p>
  <table id="lines">
    <caption class="visually-hidden"><r-t key="quotes.lines" /></caption>
    <thead><tr><th scope="col"><r-t key="quotes.f.desc" /></th><th scope="col"><r-t key="quotes.f.qty" /></th><th scope="col"><r-t key="quotes.f.unit_price" /></th><th scope="col"><r-t key="quotes.f.net" /></th><th scope="col"><r-t key="quotes.f.vat" /></th><th scope="col"><r-t key="quotes.f.total" /></th></tr></thead>
    <tbody>
      <tr r-for="l in lines">
        <td>{{ l.description }}</td>
        <td dir="ltr">{{ l.qty }}</td>
        <td dir="ltr">{{ l.unit_price | money }}</td>
        <td dir="ltr">{{ l.net | money }}</td>
        <td dir="ltr">{{ l.vat | money }} ({{ l.vat_rate }}%)</td>
        <td dir="ltr">{{ l.total | money }}</td>
      </tr>
    </tbody>
    <tfoot>
      <tr><th scope="row" colspan="5"><r-t key="quotes.f.subtotal" /></th><td dir="ltr">{{ quote.subtotal | money }}</td></tr>
      <tr><th scope="row" colspan="5"><r-t key="quotes.f.vat" /></th><td dir="ltr">{{ quote.vat | money }}</td></tr>
      <tr><th scope="row" colspan="5"><r-t key="quotes.f.total" /></th><td dir="ltr"><strong>{{ quote.total | money }}</strong></td></tr>
    </tfoot>
  </table>
  <p><r-t key="quotes.f.valid_until" />: <span dir="ltr">{{ quote.valid_until }}</span></p>
  <p r-if="quote.notes">{{ quote.notes }}</p>
  <section r-if="is_open" id="answer">
    <x-form action="approve" class="stack narrow"><button type="submit" class="btn-brand"><r-t key="approve.approve" /></button></x-form>
    <x-form action="reject" class="stack narrow"><button type="submit"><r-t key="approve.reject" /></button></x-form>
  </section>
</r-layout>
