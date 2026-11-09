<r-layout use="main">
  <r-group slot="title"><r-t key="invoices.title" /> · {{ brand.name }}</r-group>
  <h1><r-t key="invoices.title" /></h1>
  <form class="search" action="/invoices" method="get">
    <label><r-t key="invoices.f.status" />
      <select name="status">
        <option value="">—</option>
        <option r-for="s in statuses" :value="s.value" :selected="s.current">{{ ('invoices.status.' ~ s.value) | t }}</option>
      </select></label>
    <button type="submit"><r-t key="invoices.filter" /></button>
  </form>
  <table id="invoice-list">
    <thead>
      <tr><th><r-t key="invoices.f.number" /></th><th><r-t key="invoices.f.customer" /></th><th><r-t key="invoices.f.status" /></th><th><r-t key="invoices.f.total" /></th><th><r-t key="invoices.f.balance" /></th><th><r-t key="invoices.f.due" /></th></tr>
    </thead>
    <tbody>
      <tr r-for="i in invoices" :id="'invoice-' ~ i.id">
        <td dir="ltr"><a :href="'/invoices/' ~ i.id">{{ i.id }}</a></td>
        <td><a :href="'/customers/' ~ i.customer_id">{{ i.customer_name }}</a></td>
        <td><span :class="'status status-' ~ i.state">{{ ('invoices.status.' ~ i.state) | t }}</span></td>
        <td dir="ltr">{{ i.total | money }}</td>
        <td dir="ltr">{{ i.balance | money }}</td>
        <td dir="ltr">{{ i.due }}</td>
      </tr>
      <tr r-empty="invoices"><td colspan="6"><r-t key="invoices.none" /></td></tr>
    </tbody>
  </table>
</r-layout>
