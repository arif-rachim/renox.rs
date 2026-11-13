<r-layout use="main">
  <r-group slot="title">{{ report.job_number }} · {{ brand.name }}</r-group>
  <h1><r-t key="report_page.title" :job="report.job_number" /></h1>
  <p><r-t key="approve.for" :name="customer_name" /></p>
  <dl class="detail" id="report-details">
    <dt><r-t key="report_page.service" /></dt>
    <dd>{{ report.service }}</dd>
    <dt><r-t key="report_page.technician" /></dt>
    <dd>{{ report.technician }}</dd>
    <dt><r-t key="report_page.visit" /></dt>
    <dd dir="ltr">{{ report.checkin }} → {{ report.checkout }}</dd>
  </dl>
  <section id="report-summary" r-if="report.summary">
    <h2><r-t key="report_page.summary" /></h2>
    <p>{{ report.summary }}</p>
  </section>
  <section id="report-parts" r-if="has_parts">
    <h2><r-t key="report_page.parts" /></h2>
    <div class="table-scroll" tabindex="0"><table>
    <caption class="visually-hidden"><r-t key="report_page.parts" /></caption>
      <thead><tr><th scope="col"><r-t key="quotes.f.desc" /></th><th scope="col"><r-t key="quotes.f.qty" /></th><th scope="col"><r-t key="quotes.f.total" /></th></tr></thead>
      <tbody>
        <tr r-for="p in parts"><td>{{ p.description }}</td><td dir="ltr">{{ p.qty }}</td><td dir="ltr">{{ p.total | money }}</td></tr>
      </tbody>
    </table></div>
  </section>
  <p id="report-pdf"><a :href="'/l/report/' ~ token ~ '/pdf'"><r-t key="report_page.pdf" /></a></p>
  <p id="see-all-invoices"><a href="/my/invoices"><r-t key="my.invoices.see_all" /></a></p>
</r-layout>
