<r-layout use="main">
  <r-group slot="title"><r-t key="contracts.title" /> · {{ brand.name }}</r-group>
  <h1><r-t key="contracts.title" /></h1>
  <p r-if="can_write"><a class="btn-brand" href="/contracts/new" id="new-contract"><r-t key="contracts.new" /></a></p>
  <form class="search" action="/contracts" method="get">
    <label><r-t key="contracts.f.status" />
      <select name="status">
        <option value="">—</option>
        <option r-for="s in statuses" :value="s.value" :selected="s.current">{{ ('contracts.status.' ~ s.value) | t }}</option>
      </select></label>
    <button type="submit"><r-t key="contracts.filter" /></button>
  </form>
  <div class="table-scroll" tabindex="0"><table id="contract-list">
    <caption class="visually-hidden"><r-t key="contracts.title" /></caption>
    <thead>
      <tr><th scope="col"><r-t key="contracts.f.number" /></th><th scope="col"><r-t key="contracts.f.customer" /></th><th scope="col"><r-t key="contracts.f.status" /></th><th scope="col"><r-t key="contracts.f.term" /></th><th scope="col"><r-t key="contracts.f.price" /></th><th scope="col"><r-t key="contracts.f.items" /></th></tr>
    </thead>
    <tbody>
      <tr r-for="c in contracts" :id="'contract-' ~ c.number">
        <td dir="ltr"><a :href="'/contracts/' ~ c.id">{{ c.number }}</a></td>
        <td><a :href="'/customers/' ~ c.customer_id">{{ c.customer_name }}</a></td>
        <td><span :class="'status status-' ~ c.status">{{ ('contracts.status.' ~ c.status) | t }}</span></td>
        <td dir="ltr">{{ c.starts_on }} → {{ c.ends_on }}</td>
        <td dir="ltr">{{ c.price | money }}</td>
        <td dir="ltr">{{ c.items }}</td>
      </tr>
      <tr r-empty="contracts"><td colspan="6"><r-t key="contracts.none" /></td></tr>
    </tbody>
  </table></div>
</r-layout>
