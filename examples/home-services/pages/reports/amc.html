<r-layout use="main">
  <r-group slot="title"><r-t key="appreports.amc.title" /> · {{ brand.name }}</r-group>
  <nav class="work-links" id="report-nav">
    <a href="/reports"><r-t key="appreports.nav.sales" /></a>
    <a href="/reports/technicians"><r-t key="appreports.nav.technicians" /></a>
    <a href="/reports/amc"><r-t key="appreports.nav.amc" /></a>
    <a href="/reports/outstanding"><r-t key="appreports.nav.outstanding" /></a>
  </nav>
  <h1><r-t key="appreports.amc.title" /></h1>
  <p class="muted"><r-t key="appreports.amc.hint" /></p>
  <form class="search" action="/reports/amc" method="get">
    <label><r-t key="appreports.from" /> <input type="date" name="from" :value="from" dir="ltr"></label>
    <label><r-t key="appreports.to" /> <input type="date" name="to" :value="to" dir="ltr"></label>
    <button type="submit"><r-t key="appreports.show" /></button>
  </form>
  <div class="table-scroll" tabindex="0"><table id="report-amc">
    <caption class="visually-hidden"><r-t key="appreports.amc.title" /></caption>
    <thead><tr><th scope="col"><r-t key="appreports.col.contract" /></th><th scope="col"><r-t key="appreports.col.customer" /></th><th scope="col"><r-t key="appreports.col.ends_on" /></th><th scope="col"><r-t key="appreports.col.price" /></th><th scope="col"><r-t key="appreports.col.renewal" /></th></tr></thead>
    <tbody>
      <tr r-for="r in rows" :id="'amc-' ~ r.contract">
        <td dir="ltr"><a :href="'/contracts/' ~ r.id">{{ r.contract }}</a></td>
        <td><a :href="'/customers/' ~ r.customer_id">{{ r.customer }}</a></td>
        <td dir="ltr">{{ r.ends_on }}</td>
        <td dir="ltr">{{ r.price | money }}</td>
        <td><span :class="'status status-renewal-' ~ r.renewal">{{ ('appreports.renewal.' ~ r.renewal) | t }}</span> <span dir="ltr" r-if="r.renewed_by">{{ r.renewed_by }}</span></td>
      </tr>
      <tr r-empty="rows"><td colspan="5" id="no-data"><r-t key="appreports.none" /></td></tr>
    </tbody>
  </table></div>
  <section id="export" r-if="can_export">
    <h2><r-t key="appreports.export" /></h2>
    <x-form action="export" class="stack narrow">
      <input type="hidden" name="from" :value="from"><input type="hidden" name="to" :value="to">
      <p><label><r-t key="appreports.format" />
        <select name="format"><option value="csv">CSV</option><option value="xlsx">Excel (.xlsx)</option></select></label></p>
      <p><button type="submit"><r-t key="appreports.download" /></button></p>
    </x-form>
  </section>
</r-layout>
