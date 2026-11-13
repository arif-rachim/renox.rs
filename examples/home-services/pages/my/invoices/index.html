<r-layout use="portal">
  <r-group slot="title"><r-t key="my.invoices.title" /> · {{ brand.name }}</r-group>
  <p><a href="/my"><r-t key="my.visit.back" /></a></p>
  <h1><r-t key="my.invoices.title" /></h1>
  <p r-if="invoices.open_count" class="notice" id="open-sum"><r-t key="my.invoices.open_sum" /> <strong dir="ltr">{{ invoices.open_sum | money }}</strong> (<span dir="ltr">{{ invoices.open_count }}</span> <r-t key="my.invoices.open_count" />)</p>
  <p r-else-if="invoices.total" class="muted" id="open-sum"><r-t key="my.invoices.nothing_open" /></p>
  <div class="table-scroll" tabindex="0" r-if="invoices.items"><table id="my-invoices">
    <caption class="visually-hidden"><r-t key="my.invoices.title" /></caption>
    <thead><tr><th scope="col"><r-t key="my.invoices.number" /></th><th scope="col"><r-t key="my.invoices.date" /></th><th scope="col"><r-t key="my.invoices.for" /></th><th scope="col"><r-t key="my.invoices.total" /></th><th scope="col"><r-t key="my.invoices.status" /></th></tr></thead>
    <tbody>
      <tr r-for="i in invoices.items" :id="'invoice-' ~ i.id">
        <td dir="ltr"><a :href="i.href">{{ i.id }}</a></td>
        <td dir="ltr">{{ i.day }}</td>
        <td><r-group r-if="i.service">{{ i.service }}</r-group><r-group r-else-if="i.contract"><r-t key="my.invoices.contract" /> <span dir="ltr">{{ i.contract }}</span></r-group></td>
        <td dir="ltr">{{ i.total | money }}</td>
        <td>
          <r-group r-if="i.state == 'paid'"><span class="status status-paid"><r-t key="my.invoices.paid_on" /></span> <span dir="ltr">{{ i.paid_on }}</span></r-group>
          <r-group r-else-if="i.state == 'credited'"><span class="status status-credited"><r-t key="invoices.status.credited" /></span></r-group>
          <r-group r-else><span class="status status-open"><r-t key="my.invoices.open_due" /></span> <span dir="ltr">{{ i.due }}</span></r-group>
        </td>
      </tr>
    </tbody>
  </table></div>
  <p r-else class="muted" id="invoices-empty"><r-t key="my.invoices.empty" /></p>
  <nav r-if="invoices.pages > 1" class="pager" :aria-label="'my.invoices.pages' | t">
    <a r-if="invoices.prev" :href="invoices.prev" rel="prev" id="invoices-prev"><r-t key="my.invoices.prev" /></a>
    <span><r-t key="my.past.page" /> <span dir="ltr">{{ invoices.page }} / {{ invoices.pages }}</span></span>
    <a r-if="invoices.next" :href="invoices.next" rel="next" id="invoices-next"><r-t key="my.invoices.next" /></a>
  </nav>
</r-layout>
