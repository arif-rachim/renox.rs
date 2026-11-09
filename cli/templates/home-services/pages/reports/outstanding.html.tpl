<r-layout use="main">
  <r-group slot="title"><r-t key="appreports.outstanding.title" /> · {{ brand.name }}</r-group>
  <nav class="work-links" id="report-nav">
    <a href="/reports"><r-t key="appreports.nav.sales" /></a>
    <a href="/reports/technicians"><r-t key="appreports.nav.technicians" /></a>
    <a href="/reports/amc"><r-t key="appreports.nav.amc" /></a>
    <a href="/reports/outstanding"><r-t key="appreports.nav.outstanding" /></a>
  </nav>
  <h1><r-t key="appreports.outstanding.title" /></h1>
  <p class="muted"><r-t key="appreports.outstanding.hint" /> <span dir="ltr">{{ as_of }}</span></p>
  <table id="report-outstanding">
    <thead><tr><th><r-t key="appreports.col.customer" /></th><th><r-t key="appreports.col.days_0_30" /></th><th><r-t key="appreports.col.days_31_60" /></th><th><r-t key="appreports.col.days_over_60" /></th><th><r-t key="appreports.col.balance" /></th></tr></thead>
    <tbody>
      <tr r-for="r in rows"><td><a :href="'/customers/' ~ r.customer_id">{{ r.customer }}</a></td><td dir="ltr">{{ r.a | money }}</td><td dir="ltr">{{ r.b | money }}</td><td dir="ltr">{{ r.c | money }}</td><td dir="ltr"><strong>{{ r.balance | money }}</strong></td></tr>
      <tr r-empty="rows"><td colspan="5" id="no-data"><r-t key="appreports.none" /></td></tr>
    </tbody>
    <tfoot r-if="rows">
      <tr><th><r-t key="appreports.col.total" /></th><td dir="ltr">{{ totals.a | money }}</td><td dir="ltr">{{ totals.b | money }}</td><td dir="ltr">{{ totals.c | money }}</td><td dir="ltr"><strong>{{ totals.balance | money }}</strong></td></tr>
    </tfoot>
  </table>
  <section id="export" r-if="can_export">
    <h2><r-t key="appreports.export" /></h2>
    <x-form action="export" class="stack narrow">
      
      <p><label><r-t key="appreports.format" />
        <select name="format"><option value="csv">CSV</option><option value="xlsx">Excel (.xlsx)</option></select></label></p>
      <p><button type="submit"><r-t key="appreports.download" /></button></p>
    </x-form>
  </section>
</r-layout>
