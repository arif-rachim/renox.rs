<r-layout use="back-office">
  <r-group slot="title"><r-t key="parts.title" /> · {{ brand.name }}</r-group>
  <h1><r-t key="parts.title" /></h1>
  <p class="notice" id="saved" r-if="saved"><r-group r-if="saved == 'created'"><r-t key="parts.created" /></r-group><r-group r-else-if="saved == 'updated'"><r-t key="parts.updated" /></r-group><r-group r-else-if="saved == 'activated'"><r-t key="parts.activated" /></r-group><r-group r-else><r-t key="parts.deactivated" /></r-group></p>
  <form class="search" role="search" action="/admin/parts" method="get">
    <input type="search" name="q" :value="q" :placeholder="'parts.search' | t" :aria-label="'parts.search' | t" autocomplete="off">
    <button type="submit"><r-t key="parts.search_submit" /></button>
  </form>
  <div class="table-scroll" tabindex="0"><table id="parts">
    <caption class="visually-hidden"><r-t key="parts.title" /></caption>
    <thead>
      <tr><th scope="col"><r-t key="parts.f.sku" /></th><th scope="col"><r-t key="parts.f.name" /></th><th scope="col"><r-t key="parts.f.unit" /></th><th scope="col"><r-t key="parts.f.cost" /></th><th scope="col"><r-t key="parts.f.sell" /></th><th scope="col"><r-t key="parts.f.min_stock" /></th><th scope="col"><r-t key="parts.f.active" /></th><th scope="col" r-can="part.write"><r-t key="parts.f.actions" /></th></tr>
    </thead>
    <tbody>
      <tr r-for="p in parts" :id="'part-' ~ p.id">
        <td dir="ltr">{{ p.sku }}</td>
        <td>{{ p.name }}</td>
        <td>{{ ('parts.unit.' ~ p.unit) | t }}</td>
        <td dir="ltr">{{ p.cost | money }}</td>
        <td dir="ltr">{{ p.sell | money }}</td>
        <td dir="ltr">{{ p.min_stock }}</td>
        <td><r-group r-if="p.active"><r-t key="parts.on" /></r-group><r-group r-else><r-t key="parts.off" /></r-group></td>
        <td r-can="part.write">
          <a :href="'/admin/parts?edit=' ~ p.id ~ '#part-form'" :id="'edit-' ~ p.id"><r-t key="parts.edit_link" /></a>
          <x-form action="active" class="inline">
            <input type="hidden" name="id" :value="p.id">
            <input type="hidden" name="active" :value="0 if p.active else 1">
            <button type="submit" :id="'active-' ~ p.id"><r-group r-if="p.active"><r-t key="parts.deactivate" /></r-group><r-group r-else><r-t key="parts.activate" /></r-group></button>
          </x-form>
        </td>
      </tr>
      <tr r-empty="parts"><td colspan="8"><r-t key="parts.none" /></td></tr>
    </tbody>
  </table></div>
  <nav class="pager" :aria-label="'parts.pages' | t" r-if="pages > 1">
    <a r-if="prev_href" :href="prev_href" rel="prev"><r-t key="parts.prev" /></a>
    <span><r-t key="parts.page_of" :n="page_no" :pages="pages" /></span>
    <a r-if="next_href" :href="next_href" rel="next"><r-t key="parts.next" /></a>
  </nav>
  <section r-can="part.write" id="part-form">
    <h2><r-group r-if="(values.id if values.id is defined else form.id)"><r-t key="parts.edit" /></r-group><r-group r-else><r-t key="parts.add" /></r-group></h2>
    <x-form action="save" class="stack narrow">
      <input type="hidden" name="id" :value="values.id if values.id is defined else form.id">
      <p><label><r-t key="parts.f.sku" /> <input name="sku" dir="ltr" maxlength="32" required autocapitalize="characters" :value="values.sku if values.sku is defined else form.sku" id="f-sku" :aria-invalid="true if errors.sku else false" :aria-describedby="'err-sku' if errors.sku else none" aria-required="true"></label></p>
      <p><label><r-t key="parts.f.name_en" /> <input name="name_en" maxlength="120" required :value="values.name_en if values.name_en is defined else form.name_en" id="f-name_en" :aria-invalid="true if errors.name_en else false" :aria-describedby="'err-name_en' if errors.name_en else none" aria-required="true"></label></p>
      <p><label><r-t key="parts.f.name_ar" /> <input name="name_ar" dir="rtl" maxlength="120" required :value="values.name_ar if values.name_ar is defined else form.name_ar" id="f-name_ar" :aria-invalid="true if errors.name_ar else false" :aria-describedby="'err-name_ar' if errors.name_ar else none" aria-required="true"></label></p>
      <p><label><r-t key="parts.f.unit" /> <select name="unit" id="f-unit" :aria-invalid="true if errors.unit else false" :aria-describedby="'err-unit' if errors.unit else none"><option r-for="u in units" :value="u.value" :selected="u.value == (values.unit if values.unit is defined else form.unit)">{{ ('parts.unit.' ~ u.value) | t }}</option></select></label></p>
      <p><label><r-t key="parts.f.cost" /> <input name="cost" dir="ltr" inputmode="decimal" size="10" :value="values.cost if values.cost is defined else form.cost" id="f-cost" :aria-invalid="true if errors.cost else false" :aria-describedby="'err-cost' if errors.cost else none"></label></p>
      <p><label><r-t key="parts.f.sell" /> <input name="sell" dir="ltr" inputmode="decimal" size="10" :value="values.sell if values.sell is defined else form.sell" id="f-sell" :aria-invalid="true if errors.sell else false" :aria-describedby="'err-sell' if errors.sell else none"></label></p>
      <p><label><r-t key="parts.f.vat" /> <select name="vat_rate" id="f-vat_rate" :aria-invalid="true if errors.vat_rate else false" :aria-describedby="'err-vat_rate' if errors.vat_rate else none"><option value="5" :selected="(values.vat_rate if values.vat_rate is defined else form.vat_rate) == '5'">5%</option><option value="0" :selected="(values.vat_rate if values.vat_rate is defined else form.vat_rate) == '0'">0%</option></select></label></p>
      <p><label><r-t key="parts.f.min_stock" /> <input name="min_stock" dir="ltr" inputmode="decimal" size="10" :value="values.min_stock if values.min_stock is defined else form.min_stock" id="f-min_stock" :aria-invalid="true if errors.min_stock else false" :aria-describedby="'err-min_stock' if errors.min_stock else none"></label></p>
      <p>
        <button type="submit" class="btn-brand" id="save-part"><r-group r-if="(values.id if values.id is defined else form.id)"><r-t key="parts.save" /></r-group><r-group r-else><r-t key="parts.add_submit" /></r-group></button>
        <a r-if="(values.id if values.id is defined else form.id)" href="/admin/parts"><r-t key="parts.cancel" /></a>
      </p>
    </x-form>
  </section>
</r-layout>
