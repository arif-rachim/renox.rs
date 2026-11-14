<r-layout use="back-office">
  <r-group slot="title"><r-t key="stock.history.title" :sku="part.sku" /> · {{ brand.name }}</r-group>
  <p><a :href="back_href" id="back-to-stock"><r-t key="stock.history.back" /></a></p>
  <h1><r-t key="stock.history.title" :sku="part.sku" /></h1>
  <p id="part-name">{{ part.name }} · {{ ('parts.unit.' ~ part.unit) | t }} · <span id="history-branch">{{ branch_name }}</span></p>
  <div class="table-scroll" tabindex="0"><table id="moves">
    <caption class="visually-hidden"><r-t key="stock.history.caption" /></caption>
    <thead>
      <tr><th scope="col"><r-t key="stock.h.when" /></th><th scope="col"><r-t key="stock.h.kind" /></th><th scope="col"><r-t key="stock.h.qty" /></th><th scope="col"><r-t key="stock.h.balance" /></th><th scope="col"><r-t key="stock.h.cost" /></th><th scope="col"><r-t key="stock.h.reason" /></th><th scope="col"><r-t key="stock.h.ref" /></th><th scope="col"><r-t key="stock.h.who" /></th></tr>
    </thead>
    <tbody>
      <tr r-for="m in moves" :id="'move-' ~ m.id">
        <td dir="ltr">{{ m.at }}</td>
        <td>{{ ('stock.kind.' ~ m.kind) | t }}</td>
        <td dir="ltr">{{ m.qty }}</td>
        <td dir="ltr">{{ m.balance }}<r-group r-if="m.flagged"> <strong class="badge" :id="'flag-' ~ m.id"><r-t key="stock.negative" /></strong></r-group></td>
        <td dir="ltr"><r-group r-if="m.has_cost">{{ m.cost | money }}</r-group></td>
        <td>{{ m.reason }}</td>
        <td>{{ m.ref.label | t }}<r-group r-if="m.ref.text"> <a r-if="m.ref.href" :href="m.ref.href" dir="ltr">{{ m.ref.text }}</a><span r-else dir="ltr">{{ m.ref.text }}</span></r-group></td>
        <td>{{ m.who }}</td>
      </tr>
      <tr r-empty="moves"><td colspan="8"><r-t key="stock.history.none" /></td></tr>
    </tbody>
  </table></div>
  <nav class="pager" :aria-label="'stock.history.pages' | t" r-if="pages > 1">
    <a r-if="prev_href" :href="prev_href" rel="prev"><r-t key="parts.prev" /></a>
    <span><r-t key="parts.page_of" :n="page_no" :pages="pages" /></span>
    <a r-if="next_href" :href="next_href" rel="next"><r-t key="parts.next" /></a>
  </nav>
</r-layout>
