<r-layout use="main">
  <r-group slot="title"><r-t key="appreports.technicians.title" /> · {{ brand.name }}</r-group>
  <nav class="work-links" id="report-nav">
    <a href="/reports"><r-t key="appreports.nav.sales" /></a>
    <a href="/reports/technicians"><r-t key="appreports.nav.technicians" /></a>
    <a href="/reports/amc"><r-t key="appreports.nav.amc" /></a>
    <a href="/reports/outstanding"><r-t key="appreports.nav.outstanding" /></a>
  </nav>
  <h1><r-t key="appreports.technicians.title" /></h1>
  <form class="search" action="/reports/technicians" method="get">
    <label><r-t key="appreports.from" /> <input type="date" name="from" :value="from" dir="ltr"></label>
    <label><r-t key="appreports.to" /> <input type="date" name="to" :value="to" dir="ltr"></label>
    <button type="submit"><r-t key="appreports.show" /></button>
  </form>
  <table id="report-technicians">
    <thead><tr><th><r-t key="appreports.col.technician" /></th><th><r-t key="appreports.col.jobs_done" /></th><th><r-t key="appreports.col.hours" /></th><th><r-t key="appreports.col.parts" /></th></tr></thead>
    <tbody>
      <tr r-for="r in rows"><td>{{ r.technician }}</td><td dir="ltr">{{ r.jobs_done }}</td><td dir="ltr">{{ r.hours }}</td><td dir="ltr">{{ r.parts | money }}</td></tr>
      <tr r-empty="rows"><td colspan="4" id="no-data"><r-t key="appreports.none" /></td></tr>
    </tbody>
  </table>
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
