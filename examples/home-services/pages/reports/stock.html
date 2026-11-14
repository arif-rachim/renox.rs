<r-layout use="back-office">
  <r-group slot="title"><r-t key="stockreport.title" /> · {{ brand.name }}</r-group>
  <h1><r-t key="stockreport.title" /></h1>
  <p class="muted"><r-t key="stockreport.hint" /> <span dir="ltr">{{ as_of }}</span></p>
  <p><a href="/admin/stock" id="to-stock"><r-t key="stockreport.to_stock" /></a></p>

  <r-group r-for="b in branches">
    <section :id="'branch-' ~ b.id">
      <h2>{{ b.name }}</h2>
      <div class="table-scroll" tabindex="0"><table :id="'report-stock-' ~ b.id">
        <caption class="visually-hidden"><r-t key="stockreport.stock_caption" :branch="b.name" /></caption>
        <thead><tr><th scope="col"><r-t key="stock.f.sku" /></th><th scope="col"><r-t key="stock.f.name" /></th><th scope="col"><r-t key="stock.f.unit" /></th><th scope="col"><r-t key="stock.f.on_hand" /></th><th scope="col"><r-t key="stock.f.min" /></th><th scope="col"><r-t key="stock.f.avg" /></th><th scope="col"><r-t key="stock.f.value" /></th></tr></thead>
        <tbody>
          <tr r-for="r in b.stock" :id="'stock-' ~ b.id ~ '-' ~ r.id">
            <td dir="ltr"><a :href="r.href">{{ r.sku }}</a></td>
            <td>{{ r.name }}</td>
            <td>{{ ('parts.unit.' ~ r.unit) | t }}</td>
            <td dir="ltr">{{ r.qty }} <strong class="badge" r-if="r.low"><r-t key="stock.low" /></strong></td>
            <td dir="ltr">{{ r.min }}</td>
            <td dir="ltr">{{ r.avg | money }}</td>
            <td dir="ltr">{{ r.value | money }}</td>
          </tr>
          <tr r-empty="b.stock"><td colspan="7"><r-t key="stock.none" /></td></tr>
        </tbody>
        <tfoot r-if="b.stock">
          <tr><th scope="row" colspan="6"><r-t key="appreports.col.total" /></th><td dir="ltr" :id="'total-' ~ b.id"><strong>{{ b.total | money }}</strong></td></tr>
        </tfoot>
      </table></div>
    </section>
  </r-group>
  <p r-if="multi"><strong><r-t key="stockreport.grand_total" /></strong> <span dir="ltr" id="grand-total">{{ grand_total | money }}</span></p>

  <h2><r-t key="stockreport.moves_title" /></h2>
  <form class="search" action="/reports/stock" method="get">
    <label><r-t key="appreports.from" /> <input type="date" name="from" :value="from" dir="ltr"></label>
    <label><r-t key="appreports.to" /> <input type="date" name="to" :value="to" dir="ltr"></label>
    <button type="submit"><r-t key="appreports.show" /></button>
  </form>
  <r-group r-for="b in branches">
    <section :id="'moves-' ~ b.id">
      <h3>{{ b.name }}</h3>
      <div class="table-scroll" tabindex="0"><table :id="'report-moves-' ~ b.id">
        <caption class="visually-hidden"><r-t key="stockreport.moves_caption" :branch="b.name" /></caption>
        <thead><tr><th scope="col"><r-t key="stock.f.sku" /></th><th scope="col"><r-t key="stock.f.name" /></th><th scope="col"><r-t key="stock.f.unit" /></th><th scope="col"><r-t key="stockreport.col.received" /></th><th scope="col"><r-t key="stockreport.col.used" /></th><th scope="col"><r-t key="stockreport.col.adjusted" /></th><th scope="col"><r-t key="stockreport.col.transferred" /></th></tr></thead>
        <tbody>
          <tr r-for="r in b.moves" :id="'moves-' ~ b.id ~ '-' ~ r.id">
            <td dir="ltr"><a :href="r.href">{{ r.sku }}</a></td>
            <td>{{ r.name }}</td>
            <td>{{ ('parts.unit.' ~ r.unit) | t }}</td>
            <td dir="ltr">{{ r.received }}</td>
            <td dir="ltr">{{ r.used }}</td>
            <td dir="ltr">{{ r.adjusted }}</td>
            <td dir="ltr">{{ r.transferred }}</td>
          </tr>
          <tr r-empty="b.moves"><td colspan="7"><r-t key="appreports.none" /></td></tr>
        </tbody>
      </table></div>
    </section>
  </r-group>

  <section id="export">
    <h2><r-t key="appreports.export" /></h2>
    <x-form action="export" class="stack narrow">
      <input type="hidden" name="from" :value="from"><input type="hidden" name="to" :value="to">
      <p><label><r-t key="stockreport.which" />
        <select name="report"><option value="stock"><r-t key="stockreport.which_stock" /></option><option value="moves"><r-t key="stockreport.which_moves" /></option></select></label></p>
      <p><label><r-t key="appreports.format" />
        <select name="format"><option value="csv">CSV</option><option value="xlsx">Excel (.xlsx)</option></select></label></p>
      <p><button type="submit"><r-t key="appreports.download" /></button></p>
    </x-form>
  </section>
</r-layout>
