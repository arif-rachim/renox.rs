<r-layout use="back-office">
  <r-group slot="title"><r-t key="backoffice.title" /> · {{ brand.name }}</r-group>
  <h1><r-t key="backoffice.title" /></h1>
  <p><r-t key="backoffice.tiles.branch" :branch="branch_name" /></p>
  <section class="tiles" id="tiles">
    <article class="tile" id="tile-jobs"><span><r-t key="backoffice.tiles.jobs_today" /></span><strong dir="ltr">{{ tiles.jobs_today }}</strong><a href="/jobs"><r-t key="app.nav.jobs" /></a></article>
    <article class="tile" id="tile-invoices"><span><r-t key="backoffice.tiles.open_invoices" /></span><strong dir="ltr">{{ tiles.open_invoices }}</strong><a href="/invoices?status=open"><r-t key="invoices.title" /></a></article>
    <article class="tile" id="tile-amc"><span><r-t key="backoffice.tiles.amc_renewals" /></span><strong dir="ltr">{{ tiles.amc_renewals }}</strong><a href="/reports/amc"><r-t key="appreports.nav.amc" /></a></article>
  </section>
</r-layout>
