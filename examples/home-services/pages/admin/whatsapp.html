<r-layout use="back-office">
  <r-group slot="title"><r-t key="backoffice.whatsapp.title" /> · {{ brand.name }}</r-group>
  <h1><r-t key="backoffice.whatsapp.title" /></h1>
  <p><small class="muted"><r-t key="backoffice.whatsapp.note" /></small></p>
  <form class="search" action="/admin/whatsapp" method="get">
    <label><r-t key="backoffice.whatsapp.f.status" />
      <select name="status">
        <option value="">—</option>
        <option r-for="s in statuses" :value="s.value" :selected="s.current">{{ ('backoffice.whatsapp.status.' ~ s.value) | t }}</option>
      </select></label>
    <label><r-t key="backoffice.whatsapp.f.phone" /> <input type="tel" name="phone" dir="ltr" maxlength="40" :value="phone"></label>
    <button type="submit"><r-t key="backoffice.whatsapp.filter" /></button>
  </form>
  <div class="table-scroll" tabindex="0"><table id="whatsapp-outbox">
    <caption class="visually-hidden"><r-t key="backoffice.whatsapp.title" /></caption>
    <thead><tr><th scope="col"><r-t key="backoffice.whatsapp.col.when" /></th><th scope="col"><r-t key="backoffice.whatsapp.col.to" /></th><th scope="col"><r-t key="backoffice.whatsapp.col.message" /></th><th scope="col"><r-t key="backoffice.whatsapp.col.status" /></th></tr></thead>
    <tbody>
      <tr r-for="m in messages" :id="'wa-' ~ m.id">
        <td dir="ltr">{{ m.when }}</td>
        <td><span dir="ltr">{{ m.phone }}</span></td>
        <td><r-group r-if="m.template"><span dir="ltr">{{ m.template }}</span></r-group><r-group r-else>{{ m.text }}</r-group></td>
        <td><span :class="'status status-' ~ m.status">{{ ('backoffice.whatsapp.status.' ~ m.status) | t }}</span></td>
      </tr>
      <tr r-empty="messages"><td colspan="4"><r-t key="backoffice.whatsapp.none" /></td></tr>
    </tbody>
  </table></div>
</r-layout>
