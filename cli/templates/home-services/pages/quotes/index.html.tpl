<r-layout use="main">
  <r-group slot="title"><r-t key="quotes.title" /> · {{ brand.name }}</r-group>
  <h1><r-t key="quotes.title" /></h1>
  <form class="search" action="/quotes" method="get">
    <label><r-t key="quotes.f.status" />
      <select name="status">
        <option value="">—</option>
        <option r-for="s in statuses" :value="s.value" :selected="s.current">{{ ('quotes.status.' ~ s.value) | t }}</option>
      </select></label>
    <button type="submit"><r-t key="quotes.filter" /></button>
    <a class="btn-brand" href="/quotes/new" r-can="quote.write"><r-t key="quotes.new" /></a>
  </form>
  <table id="quote-list">
    <caption class="visually-hidden"><r-t key="quotes.title" /></caption>
    <thead>
      <tr><th scope="col"><r-t key="quotes.f.number" /></th><th scope="col"><r-t key="quotes.f.customer" /></th><th scope="col"><r-t key="quotes.f.status" /></th><th scope="col"><r-t key="quotes.f.total" /></th><th scope="col"><r-t key="quotes.f.valid_until" /></th></tr>
    </thead>
    <tbody>
      <tr r-for="q in quotes" :id="'quote-' ~ q.id">
        <td dir="ltr"><a :href="'/quotes/' ~ q.id">{{ q.number }}</a></td>
        <td>{{ q.customer_name }}</td>
        <td><span :class="'status status-' ~ q.status">{{ ('quotes.status.' ~ q.status) | t }}</span></td>
        <td dir="ltr">{{ q.total | money }}</td>
        <td dir="ltr">{{ q.valid_until }}</td>
      </tr>
      <tr r-empty="quotes"><td colspan="5"><r-t key="quotes.none" /></td></tr>
    </tbody>
  </table>
</r-layout>
