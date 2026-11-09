<r-layout use="back-office">
  <r-group slot="title"><r-t key="backoffice.branches.title" /> · {{ brand.name }}</r-group>
  <h1><r-t key="backoffice.branches.title" /></h1>
  <p class="notice" id="created" r-if="created"><r-t key="backoffice.branches.created" /></p>
  <p class="notice" id="updated" r-if="updated"><r-t key="backoffice.branches.updated" /></p>
  <table id="branches">
    <thead><tr><th><r-t key="backoffice.branches.f.name_en" /></th><th><r-t key="backoffice.branches.f.name_ar" /></th><th><r-t key="backoffice.branches.slug" /></th><th><r-t key="backoffice.branches.f.area" /></th><th><r-t key="backoffice.branches.f.phone" /></th></tr></thead>
    <tbody>
      <tr r-for="b in branches" :id="'branch-' ~ b.id"><td>{{ b.name_en }}</td><td dir="rtl">{{ b.name_ar }}</td><td dir="ltr">{{ b.slug }}</td><td>{{ b.area }}</td><td dir="ltr">{{ b.phone }}</td></tr>
      <tr r-empty="branches"><td colspan="5"><r-t key="backoffice.branches.none" /></td></tr>
    </tbody>
  </table>
  <p><small class="muted"><r-t key="backoffice.branches.note" /></small></p>
  <section r-can="settings.write">
    <h2><r-t key="backoffice.branches.edit" /></h2>
    <x-form action="update" class="row" r-for="b in branches" :id="'branch-form-' ~ b.id">
      <input type="hidden" name="branch_id" :value="b.id">
      <label><r-t key="backoffice.branches.f.name_en" /> <input name="name_en" maxlength="80" :value="values.name_en if values.branch_id == b.id else b.name_en" required></label>
      <label><r-t key="backoffice.branches.f.name_ar" /> <input name="name_ar" maxlength="80" dir="rtl" :value="values.name_ar if values.branch_id == b.id else b.name_ar" required></label>
      <label><r-t key="backoffice.branches.f.phone" /> <input name="phone" dir="ltr" maxlength="20" :value="values.phone if values.branch_id == b.id else b.phone"></label>
      <label><r-t key="backoffice.branches.f.emirate" /> <select name="emirate"><option r-for="e in emirates" :value="e.code" :selected="e.code == (values.emirate if values.branch_id == b.id else b.emirate)">{{ e.name }}</option></select></label>
      <label><r-t key="backoffice.branches.f.area" /> <input name="area" maxlength="80" :value="values.area if values.branch_id == b.id else b.area"></label>
      <label><r-t key="backoffice.branches.f.address" /> <input name="address" maxlength="200" :value="values.address if values.branch_id == b.id else b.address"></label>
      <button type="submit"><r-t key="backoffice.branches.save" /></button>
    </x-form>
    <h2><r-t key="backoffice.branches.create" /></h2>
    <x-form action="create" class="stack narrow">
      <p><label><r-t key="backoffice.branches.f.name_en" /> <input name="name_en" maxlength="80" :value="values.name_en if values.form == 'create' else ''" required></label></p>
      <p><label><r-t key="backoffice.branches.f.name_ar" /> <input name="name_ar" maxlength="80" dir="rtl" :value="values.name_ar if values.form == 'create' else ''" required></label></p>
      <p><label><r-t key="backoffice.branches.f.phone" /> <input name="phone" dir="ltr" maxlength="20" :value="values.phone if values.form == 'create' else ''"></label></p>
      <p><label><r-t key="backoffice.branches.f.emirate" /> <select name="emirate"><option r-for="e in emirates" :value="e.code" :selected="values.form == 'create' and e.code == values.emirate">{{ e.name }}</option></select></label></p>
      <p><label><r-t key="backoffice.branches.f.area" /> <input name="area" maxlength="80" :value="values.area if values.form == 'create' else ''"></label></p>
      <p><label><r-t key="backoffice.branches.f.address" /> <input name="address" maxlength="200" :value="values.address if values.form == 'create' else ''"></label></p>
      <p><button type="submit" class="btn-brand"><r-t key="backoffice.branches.create_submit" /></button></p>
    </x-form>
  </section>
</r-layout>
