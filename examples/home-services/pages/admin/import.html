<r-layout use="back-office">
  <r-group slot="title"><r-t key="backoffice.import.title" /> · {{ brand.name }}</r-group>
  <h1><r-t key="backoffice.import.title" /></h1>
  <p><r-t key="backoffice.import.intro" :mb="max_mb" /></p>
  <p class="problem" role="alert" id="file-error" r-if="file_error">{{ ('import.err.' ~ file_error) | t }}</p>
  <ol id="import-kinds">
    <li r-for="k in kinds" :id="'kind-' ~ k.kind">
      <strong>{{ ('backoffice.import.kinds.' ~ k.kind ~ '.name') | t }}</strong>: {{ ('backoffice.import.kinds.' ~ k.kind ~ '.desc') | t }}
      <br><small class="muted"><r-t key="backoffice.import.columns" /> <span dir="ltr">{{ k.columns }}</span></small>
      <a :href="'/admin/import/template/' ~ k.kind" :id="'template-' ~ k.kind"><r-t key="backoffice.import.template" /></a>
    </li>
  </ol>
  <x-form action="check" class="stack narrow" id="import-form">
    <p><label><r-t key="backoffice.import.f.kind" />
      <select name="kind" id="f-kind" :aria-invalid="'true' if errors.kind else 'false'" :aria-describedby="'err-kind' if errors.kind else ''"><option r-for="k in kinds" :value="k.kind" :selected="k.kind == values.kind">{{ ('backoffice.import.kinds.' ~ k.kind ~ '.name') | t }}</option></select></label></p>
    <p><label><r-t key="backoffice.import.f.file" /> <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" data-upload-action="/admin/import?/upload_url" data-key-field="file_key" required aria-required="true" id="f-file_key" :aria-invalid="'true' if errors.file_key else 'false'" :aria-describedby="'err-file_key' if errors.file_key else ''"> <span data-upload-status class="muted"></span></label>
      <input type="hidden" name="file_key"></p>
    <p><button type="submit" class="btn-brand"><r-t key="backoffice.import.check" /></button></p>
  </x-form>
  <h2><r-t key="backoffice.import.recent" /></h2>
  <table id="imports">
    <caption class="visually-hidden"><r-t key="backoffice.import.recent" /></caption>
    <thead><tr><th scope="col"><r-t key="backoffice.import.col.kind" /></th><th scope="col"><r-t key="backoffice.import.col.file" /></th><th scope="col"><r-t key="backoffice.import.col.when" /></th><th scope="col"><r-t key="backoffice.import.col.who" /></th><th scope="col"><r-t key="backoffice.import.col.status" /></th><th scope="col"><r-t key="backoffice.import.col.counts" /></th></tr></thead>
    <tbody>
      <tr r-for="i in imports" :id="'import-' ~ i.id">
        <td><a :href="'/admin/import/' ~ i.id">{{ ('backoffice.import.kinds.' ~ i.kind ~ '.name') | t }}</a></td>
        <td dir="ltr">{{ i.file_name }}</td>
        <td dir="ltr">{{ i.when }}</td>
        <td>{{ i.who }}</td>
        <td>{{ ('backoffice.import.status.' ~ i.status) | t }}</td>
        <td><r-t key="backoffice.import.counts" :rows="i.rows" :ok="i.ok" :skipped="i.skipped" :errors="i.errors" /></td>
      </tr>
      <tr r-empty="imports"><td colspan="6"><r-t key="backoffice.import.none" /></td></tr>
    </tbody>
  </table>
  <script src="/upload.js" defer></script>
</r-layout>
