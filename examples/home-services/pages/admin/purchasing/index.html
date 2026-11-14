<r-layout use="back-office">
  <r-group slot="title"><r-t key="purchasing.title" /> · {{ brand.name }}</r-group>
  <h1><r-t key="purchasing.title" /></h1>
  <h2 id="branch-name">{{ branch_name }}</h2>
  <form class="search" role="search" action="/admin/purchasing" method="get">
    <label><r-t key="purchasing.f.status" />
      <select name="status">
        <option value="">—</option>
        <option r-for="s in statuses" :value="s.value" :selected="s.current">{{ ('purchasing.status.' ~ s.value) | t }}</option>
      </select></label>
    <label><r-t key="purchasing.f.supplier" />
      <select name="supplier">
        <option value="">—</option>
        <option r-for="s in suppliers" :value="s.id" :selected="s.current">{{ s.name }}</option>
      </select></label>
    <button type="submit"><r-t key="purchasing.filter" /></button>
  </form>
  <div class="table-scroll" tabindex="0"><table id="orders">
    <caption class="visually-hidden"><r-t key="purchasing.title" /></caption>
    <thead>
      <tr><th scope="col"><r-t key="purchasing.f.number" /></th><th scope="col"><r-t key="purchasing.f.supplier" /></th><th scope="col"><r-t key="purchasing.f.status" /></th><th scope="col"><r-t key="purchasing.f.created" /></th><th scope="col"><r-t key="purchasing.f.expected_on" /></th><th scope="col"><r-t key="purchasing.f.total" /></th></tr>
    </thead>
    <tbody>
      <tr r-for="p in orders" :id="'po-' ~ p.id">
        <td dir="ltr"><a :href="'/admin/purchasing/' ~ p.id">{{ p.number }}</a></td>
        <td>{{ p.supplier }}</td>
        <td><span :class="'status status-' ~ p.status">{{ ('purchasing.status.' ~ p.status) | t }}</span></td>
        <td dir="ltr">{{ p.created_at }}</td>
        <td dir="ltr">{{ p.expected_on }}</td>
        <td dir="ltr">{{ p.total | money }}</td>
      </tr>
      <tr r-empty="orders"><td colspan="6"><r-t key="purchasing.none" /></td></tr>
    </tbody>
  </table></div>
  <nav class="pager" :aria-label="'purchasing.pages' | t" r-if="pages > 1">
    <a r-if="prev_href" :href="prev_href" rel="prev"><r-t key="parts.prev" /></a>
    <span><r-t key="parts.page_of" :n="page_no" :pages="pages" /></span>
    <a r-if="next_href" :href="next_href" rel="next"><r-t key="parts.next" /></a>
  </nav>
  <section r-can="purchase.write" id="po-form">
    <h2><r-t key="purchasing.new" /></h2>
    <x-form action="create" class="stack narrow">
      <p><label><r-t key="purchasing.f.supplier" /> <select name="supplier" id="f-supplier" required aria-required="true" :aria-invalid="true if errors.supplier else false" :aria-describedby="'err-supplier' if errors.supplier else none"><option value=""></option><option r-for="s in pickable" :value="s.id" :selected="values.supplier == s.id">{{ s.name }}</option></select></label></p>
      <p><label><r-t key="purchasing.f.language" /> <select name="language" id="f-language" :aria-invalid="true if errors.language else false" :aria-describedby="'err-language' if errors.language else none"><option value="en" :selected="values.language != 'ar'">English</option><option value="ar" :selected="values.language == 'ar'">العربية</option></select></label></p>
      <p><label><r-t key="purchasing.f.expected_on" /> <input name="expected_on" type="date" dir="ltr" id="f-expected_on" :value="values.expected_on" :aria-invalid="true if errors.expected_on else false" :aria-describedby="'err-expected_on' if errors.expected_on else none"></label></p>
      <p><label><r-t key="purchasing.f.notes" /> <textarea name="notes" rows="3" maxlength="1000" id="f-notes" :aria-invalid="true if errors.notes else false" :aria-describedby="'err-notes' if errors.notes else none">{{ values.notes }}</textarea></label></p>
      <p><button type="submit" class="btn-brand" id="create-po"><r-t key="purchasing.create" /></button></p>
    </x-form>
  </section>
</r-layout>
