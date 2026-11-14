<r-layout use="back-office">
  <r-group slot="title"><r-t key="stock.title" /> · {{ brand.name }}</r-group>
  <h1><r-t key="stock.title" /></h1>
  <p class="notice" id="saved" r-if="saved"><r-group r-if="saved == 'received'"><r-t key="stock.saved.received" /></r-group><r-group r-else-if="saved == 'adjusted'"><r-t key="stock.saved.adjusted" /></r-group><r-group r-else><r-t key="stock.saved.transferred" /></r-group></p>
  <nav class="pager" id="branch-picker" :aria-label="'stock.branches' | t" r-if="multi">
    <r-group r-for="b in branches"><strong r-if="b.current" :id="'branch-' ~ b.id" aria-current="page">{{ b.name }}</strong><a r-else :href="b.href" :id="'branch-' ~ b.id">{{ b.name }}</a> </r-group>
  </nav>
  <h2 id="branch-name">{{ sel_name }}</h2>
  <form class="search" role="search" action="/admin/stock" method="get">
    <input type="hidden" name="branch" :value="sel_id">
    <input type="search" name="q" :value="q" :placeholder="'stock.search' | t" :aria-label="'stock.search' | t" autocomplete="off">
    <label><input type="checkbox" name="low" value="1" :checked="low"> <r-t key="stock.low_only" /></label>
    <button type="submit"><r-t key="stock.search_submit" /></button>
  </form>
  <div class="table-scroll" tabindex="0"><table id="stock">
    <caption class="visually-hidden"><r-t key="stock.title" /></caption>
    <thead>
      <tr><th scope="col"><r-t key="stock.f.sku" /></th><th scope="col"><r-t key="stock.f.name" /></th><th scope="col"><r-t key="stock.f.unit" /></th><th scope="col"><r-t key="stock.f.on_hand" /></th><th scope="col"><r-t key="stock.f.min" /></th><th scope="col"><r-t key="stock.f.avg" /></th><th scope="col"><r-t key="stock.f.value" /></th><th scope="col"><r-t key="stock.f.status" /></th></tr>
    </thead>
    <tbody>
      <tr r-for="l in lines" :id="'stock-' ~ l.id">
        <td dir="ltr"><a :href="l.href">{{ l.sku }}</a></td>
        <td>{{ l.name }}</td>
        <td>{{ ('parts.unit.' ~ l.unit) | t }}</td>
        <td dir="ltr">{{ l.qty }}</td>
        <td dir="ltr">{{ l.min }}</td>
        <td dir="ltr">{{ l.avg | money }}</td>
        <td dir="ltr">{{ l.value | money }}</td>
        <td><strong class="badge" r-if="l.low" :id="'low-' ~ l.id"><r-t key="stock.low" /></strong><strong class="badge" r-if="l.negative" :id="'negative-' ~ l.id"><r-t key="stock.negative" /></strong></td>
      </tr>
      <tr r-empty="lines"><td colspan="8"><r-t key="stock.none" /></td></tr>
    </tbody>
  </table></div>
  <h2><r-t key="stock.totals" /></h2>
  <ul id="totals">
    <li r-for="b in branches" :id="'total-' ~ b.id">{{ b.name }}: <span dir="ltr">{{ b.value | money }}</span></li>
  </ul>
  <p><small class="muted"><r-t key="stock.note" /></small></p>
  <p><a href="/reports/stock" id="stock-report-link"><r-t key="stock.report_link" /></a></p>

  <section r-if="can_move" id="stock-forms">
    <h2><r-t key="stock.receive.title" /></h2>
    <x-form action="receive" class="stack narrow" id="receive-form">
      <input type="hidden" name="branch" :value="sel_id">
      <p><label><r-t key="stock.f.part" /> <select name="part" id="f-receive-part" required aria-required="true" :aria-invalid="true if values.form == 'receive' and errors.part else false" :aria-describedby="'err-part' if values.form == 'receive' and errors.part else none"><option value=""></option><option r-for="p in parts" :value="p.id" :selected="values.form == 'receive' and values.part == p.id">{{ p.label }}</option></select></label></p>
      <p><label><r-t key="stock.f.qty" /> <input name="qty" dir="ltr" inputmode="decimal" size="10" required aria-required="true" id="f-receive-qty" :value="values.qty if values.form == 'receive' else ''" :aria-invalid="true if values.form == 'receive' and errors.qty else false" :aria-describedby="'err-qty' if values.form == 'receive' and errors.qty else none"></label></p>
      <p><label><r-t key="stock.f.unit_cost" /> <input name="unit_cost" dir="ltr" inputmode="decimal" size="10" required aria-required="true" id="f-receive-unit_cost" :value="values.unit_cost if values.form == 'receive' else ''" :aria-invalid="true if values.form == 'receive' and errors.unit_cost else false" :aria-describedby="'err-unit_cost' if values.form == 'receive' and errors.unit_cost else none"></label></p>
      <p><label><r-t key="stock.f.reason" /> <input name="reason" maxlength="200" required aria-required="true" id="f-receive-reason" :value="values.reason if values.form == 'receive' else ''" :aria-invalid="true if values.form == 'receive' and errors.reason else false" :aria-describedby="'err-reason' if values.form == 'receive' and errors.reason else none"></label></p>
      <p><button type="submit" class="btn-brand" id="receive-submit"><r-t key="stock.receive.submit" /></button></p>
    </x-form>

    <h2><r-t key="stock.adjust.title" /></h2>
    <p><small class="muted"><r-t key="stock.adjust.note" /></small></p>
    <x-form action="adjust" class="stack narrow" id="adjust-form">
      <input type="hidden" name="branch" :value="sel_id">
      <p><label><r-t key="stock.f.part" /> <select name="part" id="f-adjust-part" required aria-required="true" :aria-invalid="true if values.form == 'adjust' and errors.part else false" :aria-describedby="'err-part' if values.form == 'adjust' and errors.part else none"><option value=""></option><option r-for="p in parts" :value="p.id" :selected="values.form == 'adjust' and values.part == p.id">{{ p.label }}</option></select></label></p>
      <p><label><r-t key="stock.f.counted" /> <input name="counted" dir="ltr" inputmode="decimal" size="10" required aria-required="true" id="f-adjust-counted" :value="values.counted if values.form == 'adjust' else ''" :aria-invalid="true if values.form == 'adjust' and errors.counted else false" :aria-describedby="'err-counted' if values.form == 'adjust' and errors.counted else none"></label></p>
      <p><label><r-t key="stock.f.reason" /> <input name="reason" maxlength="200" required aria-required="true" id="f-adjust-reason" :value="values.reason if values.form == 'adjust' else ''" :aria-invalid="true if values.form == 'adjust' and errors.reason else false" :aria-describedby="'err-reason' if values.form == 'adjust' and errors.reason else none"></label></p>
      <p><button type="submit" class="btn-brand" id="adjust-submit"><r-t key="stock.adjust.submit" /></button></p>
    </x-form>

    <h2><r-t key="stock.transfer.title" /></h2>
    <p r-if="no_dests"><small class="muted" id="no-destination"><r-t key="stock.transfer.none" /></small></p>
    <x-form action="transfer" class="stack narrow" id="transfer-form" r-if="has_dests">
      <input type="hidden" name="branch" :value="sel_id">
      <p><label><r-t key="stock.f.part" /> <select name="part" id="f-transfer-part" required aria-required="true" :aria-invalid="true if values.form == 'transfer' and errors.part else false" :aria-describedby="'err-part' if values.form == 'transfer' and errors.part else none"><option value=""></option><option r-for="p in parts" :value="p.id" :selected="values.form == 'transfer' and values.part == p.id">{{ p.label }}</option></select></label></p>
      <p><label><r-t key="stock.f.qty" /> <input name="qty" dir="ltr" inputmode="decimal" size="10" required aria-required="true" id="f-transfer-qty" :value="values.qty if values.form == 'transfer' else ''" :aria-invalid="true if values.form == 'transfer' and errors.qty else false" :aria-describedby="'err-qty' if values.form == 'transfer' and errors.qty else none"></label></p>
      <p><label><r-t key="stock.f.to_branch" /> <select name="to_branch" id="f-transfer-to_branch" required aria-required="true" :aria-invalid="true if values.form == 'transfer' and errors.to_branch else false" :aria-describedby="'err-to_branch' if values.form == 'transfer' and errors.to_branch else none"><option r-for="d in dests" :value="d.id" :selected="values.form == 'transfer' and values.to_branch == d.id">{{ d.name }}</option></select></label></p>
      <p><label><r-t key="stock.f.reason" /> <input name="reason" maxlength="200" required aria-required="true" id="f-transfer-reason" :value="values.reason if values.form == 'transfer' else ''" :aria-invalid="true if values.form == 'transfer' and errors.reason else false" :aria-describedby="'err-reason' if values.form == 'transfer' and errors.reason else none"></label></p>
      <p><button type="submit" class="btn-brand" id="transfer-submit"><r-t key="stock.transfer.submit" /></button></p>
    </x-form>
  </section>
</r-layout>
