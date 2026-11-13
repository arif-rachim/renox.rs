<r-layout use="back-office">
  <r-group slot="title"><r-t key="backoffice.title" /> · {{ brand.name }}</r-group>
  <h1><r-t key="backoffice.title" /></h1>
  <article id="home-services-tile" class="tile-card" r-fragment="tile">
    <h2><r-t key="backoffice.tiles.branch" :branch="branch_name" /></h2>
    <section class="tiles" id="tiles">
      <article class="tile" id="tile-jobs"><span><r-t key="backoffice.tiles.jobs_today" /></span><strong dir="ltr">{{ tiles.jobs_today }}</strong><a href="/jobs"><r-t key="app.nav.jobs" /></a></article>
      <article class="tile" id="tile-invoices"><span><r-t key="backoffice.tiles.open_invoices" /></span><strong dir="ltr">{{ tiles.open_invoices }}</strong><a href="/invoices?status=open"><r-t key="invoices.title" /></a></article>
      <article class="tile" id="tile-amc"><span><r-t key="backoffice.tiles.amc_renewals" /></span><strong dir="ltr">{{ tiles.amc_renewals }}</strong><a href="/reports/amc"><r-t key="appreports.nav.amc" /></a></article>
      <article class="tile" id="tile-online"><span><r-t key="backoffice.tiles.online_to_confirm" /></span><strong dir="ltr">{{ tiles.online_to_confirm }}</strong><a href="/jobs?source=self_booking"><r-t key="jobs.badge.self_booking" /></a></article>
    </section>
  </article>
</r-layout>
