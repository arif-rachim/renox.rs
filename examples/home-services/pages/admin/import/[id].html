<r-layout use="back-office">
  <r-group slot="title"><r-t key="backoffice.import.report" /> · {{ brand.name }}</r-group>
  <h1><r-t key="backoffice.import.report" /></h1>
  <p><strong>{{ ('backoffice.import.kinds.' ~ imp.kind ~ '.name') | t }}</strong> · <span dir="ltr" id="import-file">{{ imp.file_name }}</span> · <span id="import-status">{{ ('backoffice.import.status.' ~ imp.status) | t }}</span></p>
  <p class="notice" id="committed" r-if="imp.status == 'committed'">
    <r-t key="backoffice.import.committed" :inserted="imp.insert" :updated="imp.update" :exists="imp.exists" />
    <a :href="where" id="import-where"><r-t key="backoffice.import.open" /></a>
  </p>
  <dl id="import-totals">
    <dt><r-t key="backoffice.import.total.rows" /></dt><dd dir="ltr" id="total-rows">{{ imp.rows }}</dd>
    <dt><r-t key="backoffice.import.total.insert" /></dt><dd dir="ltr" id="total-insert">{{ imp.insert }}</dd>
    <dt><r-t key="backoffice.import.total.update" /></dt><dd dir="ltr" id="total-update">{{ imp.update }}</dd>
    <dt><r-t key="backoffice.import.total.exists" /></dt><dd dir="ltr" id="total-exists">{{ imp.exists }}</dd>
    <dt><r-t key="backoffice.import.total.errors" /></dt><dd dir="ltr" id="total-errors">{{ imp.errors }}</dd>
  </dl>
  <table id="import-errors" r-if="error_rows">
    <caption class="visually-hidden"><r-t key="backoffice.import.report" /></caption>
    <thead><tr><th scope="col"><r-t key="backoffice.import.err_row" /></th><th scope="col"><r-t key="backoffice.import.err_column" /></th><th scope="col"><r-t key="backoffice.import.err_message" /></th></tr></thead>
    <tbody>
      <tr r-for="e in error_rows">
        <td dir="ltr"><r-group r-if="e.row">{{ e.row }}</r-group><r-group r-else>—</r-group></td>
        <td dir="ltr">{{ e.column }}</td>
        <td>{{ ('import.err.' ~ e.code) | t }}</td>
      </tr>
    </tbody>
  </table>
  <p r-if="truncated"><small class="muted"><r-t key="backoffice.import.truncated" /></small></p>
  <section r-if="can_commit">
    <x-form action="commit" class="inline" id="commit-form"><button type="submit" class="btn-brand"><r-t key="backoffice.import.commit" :n="imp.to_write" /></button></x-form>
    <x-form action="discard" class="inline"><button type="submit"><r-t key="backoffice.import.discard" /></button></x-form>
  </section>
  <section r-else-if="imp.status == 'checked'">
    <p id="fix-file"><r-t key="backoffice.import.fix" /></p>
    <x-form action="discard" class="inline"><button type="submit"><r-t key="backoffice.import.discard" /></button></x-form>
  </section>
  <p><a href="/admin/import"><r-t key="backoffice.import.back" /></a></p>
</r-layout>
