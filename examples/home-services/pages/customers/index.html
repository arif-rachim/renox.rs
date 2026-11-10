<r-layout use="main">
  <r-group slot="title"><r-t key="customers.title" /> · {{ brand.name }}</r-group>
  <h1><r-t key="customers.title" /></h1>
  <p class="muted"><r-t key="customers.branch" :branch="branch_name" /></p>
  <form class="search" role="search" action="/customers" hx-get="/customers" hx-target="#customer-list" hx-swap="outerHTML" hx-trigger="input changed delay:250ms from:input[name=q], submit" hx-push-url="true">
    <input type="search" name="q" :value="q" :placeholder="'customers.search' | t" :aria-label="'customers.search' | t" autocomplete="off">
    <button type="submit"><r-t key="customers.search_submit" /></button>
    <a class="btn-brand" href="/customers/new" r-can="customer.write"><r-t key="customers.new" /></a>
  </form>
  <table id="customer-list" r-fragment="customer_list">
    <caption class="visually-hidden"><r-t key="customers.title" /></caption>
    <thead>
      <tr><th scope="col"><r-t key="customers.f.name" /></th><th scope="col"><r-t key="customers.f.kind" /></th><th scope="col"><r-t key="customers.f.phone" /></th><th scope="col"><r-t key="customers.f.trn" /></th><th scope="col"><r-t key="customers.sites" /></th></tr>
    </thead>
    <tbody>
      <tr r-for="c in customers" :id="'customer-' + c.id">
        <td><a :href="'/customers/' + c.id">{{ c.name }}</a></td>
        <td><r-group r-if="c.kind == 'company'"><r-t key="customers.kind.company" /></r-group><r-group r-else><r-t key="customers.kind.household" /></r-group></td>
        <td dir="ltr">{{ c.phone }}</td>
        <td dir="ltr">{{ c.trn }}</td>
        <td>{{ c.sites }}</td>
      </tr>
      <tr r-empty="customers"><td colspan="5"><r-t key="customers.none" /></td></tr>
    </tbody>
  </table>
</r-layout>
