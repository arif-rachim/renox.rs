<r-layout use="back-office">
  <r-group slot="title"><r-t key="backoffice.branches.title" /> · {{ brand.name }}</r-group>
  <h1><r-t key="backoffice.branches.title" /></h1>
  <p class="notice" id="created" r-if="created"><r-t key="backoffice.branches.created" /></p>
  <p class="notice" id="updated" r-if="updated"><r-t key="backoffice.branches.updated" /></p>
  <p class="notice" id="hours-saved" r-if="hours_saved"><r-t key="backoffice.hours.saved" :branch="hours_branch" /></p>
  <p class="notice" id="outside-hours" r-if="outside_count"><a :href="'/jobs?branch=' ~ outside_branch ~ '&outside_hours=1'"><r-group r-if="outside_count == 1"><r-t key="backoffice.hours.outside_one" /></r-group><r-group r-else><r-t key="backoffice.hours.outside_many" :n="outside_count" /></r-group></a></p>
  <div class="table-scroll" tabindex="0"><table id="branches">
    <caption class="visually-hidden"><r-t key="backoffice.branches.title" /></caption>
    <thead><tr><th scope="col"><r-t key="backoffice.branches.f.name_en" /></th><th scope="col"><r-t key="backoffice.branches.f.name_ar" /></th><th scope="col"><r-t key="backoffice.branches.slug" /></th><th scope="col"><r-t key="backoffice.branches.f.area" /></th><th scope="col"><r-t key="backoffice.branches.f.phone" /></th></tr></thead>
    <tbody>
      <tr r-for="b in branches" :id="'branch-' ~ b.id"><td>{{ b.name_en }}</td><td dir="rtl">{{ b.name_ar }}</td><td dir="ltr">{{ b.slug }}</td><td>{{ b.area }}</td><td dir="ltr">{{ b.phone }}</td></tr>
      <tr r-empty="branches"><td colspan="5"><r-t key="backoffice.branches.none" /></td></tr>
    </tbody>
  </table></div>
  <p><small class="muted"><r-t key="backoffice.branches.note" /></small></p>
  <section r-can="settings.write">
    <h2><r-t key="backoffice.branches.edit" /></h2>
    <x-form action="update" class="row" r-for="b in branches" :id="'branch-form-' ~ b.id">
      <input type="hidden" name="branch_id" :value="b.id">
      <label><r-t key="backoffice.branches.f.name_en" /> <input name="name_en" maxlength="80" :value="values.name_en if values.branch_id == b.id else b.name_en" required :id="'f-name_en' if values.branch_id == b.id else 'f-name_en-' ~ b.id" :aria-invalid="true if values.branch_id == b.id and errors.name_en else false" :aria-describedby="'err-name_en' if values.branch_id == b.id and errors.name_en else none" aria-required="true"></label>
      <label><r-t key="backoffice.branches.f.name_ar" /> <input name="name_ar" maxlength="80" dir="rtl" :value="values.name_ar if values.branch_id == b.id else b.name_ar" required :id="'f-name_ar' if values.branch_id == b.id else 'f-name_ar-' ~ b.id" :aria-invalid="true if values.branch_id == b.id and errors.name_ar else false" :aria-describedby="'err-name_ar' if values.branch_id == b.id and errors.name_ar else none" aria-required="true"></label>
      <label><r-t key="backoffice.branches.f.phone" /> <input name="phone" dir="ltr" maxlength="20" :value="values.phone if values.branch_id == b.id else b.phone" :id="'f-phone' if values.branch_id == b.id else 'f-phone-' ~ b.id" :aria-invalid="true if values.branch_id == b.id and errors.phone else false" :aria-describedby="'err-phone' if values.branch_id == b.id and errors.phone else none"></label>
      <label><r-t key="backoffice.branches.f.emirate" /> <select name="emirate" :id="'f-emirate' if values.branch_id == b.id else 'f-emirate-' ~ b.id" :aria-invalid="true if values.branch_id == b.id and errors.emirate else false" :aria-describedby="'err-emirate' if values.branch_id == b.id and errors.emirate else none"><option r-for="e in emirates" :value="e.code" :selected="e.code == (values.emirate if values.branch_id == b.id else b.emirate)">{{ e.name }}</option></select></label>
      <label><r-t key="backoffice.branches.f.area" /> <input name="area" maxlength="80" :value="values.area if values.branch_id == b.id else b.area" :id="'f-area' if values.branch_id == b.id else 'f-area-' ~ b.id" :aria-invalid="true if values.branch_id == b.id and errors.area else false" :aria-describedby="'err-area' if values.branch_id == b.id and errors.area else none"></label>
      <label><r-t key="backoffice.branches.f.address" /> <input name="address" maxlength="200" :value="values.address if values.branch_id == b.id else b.address" :id="'f-address' if values.branch_id == b.id else 'f-address-' ~ b.id" :aria-invalid="true if values.branch_id == b.id and errors.address else false" :aria-describedby="'err-address' if values.branch_id == b.id and errors.address else none"></label>
      <button type="submit"><r-t key="backoffice.branches.save" /></button>
    </x-form>
    <h2><r-t key="backoffice.hours.title" /></h2>
    <p><small class="muted"><r-t key="backoffice.hours.note" /></small></p>
    <x-form action="hours" class="stack narrow" r-for="b in branches" :id="'hours-form-' ~ b.id">
      <input type="hidden" name="branch_id" :value="b.id">
      <fieldset>
        <legend><r-t key="backoffice.hours.for" :branch="b.name" /></legend>
        <p r-if="week_for == b.id and week_error" :id="'err-hours-' ~ b.id"><strong>{{ week_error }}</strong></p>
        <p class="row" r-for="d in (week_echo if week_for == b.id else b.week)" :id="'hours-' ~ b.id ~ '-' ~ d.weekday">
          <strong>{{ d.name_key | t }}</strong>
          <label><input type="checkbox" :name="'closed_' ~ d.weekday" value="on" :checked="d.closed"> <r-t key="backoffice.hours.closed" /></label>
          <label><r-t key="backoffice.hours.open" /> <input type="time" step="1800" dir="ltr" :name="'open_' ~ d.weekday" :value="d.open" :id="'f-hours-' ~ b.id ~ '-hours_' ~ d.weekday" :aria-invalid="true if d.error else false" :aria-describedby="'err-hours_' ~ d.weekday if d.error else none"></label>
          <label><r-t key="backoffice.hours.close" /> <input type="time" step="1800" dir="ltr" :name="'close_' ~ d.weekday" :value="d.close" :aria-invalid="true if d.error else false"></label>
        </p>
      </fieldset>
      <p><button type="submit"><r-t key="backoffice.hours.save" /></button></p>
    </x-form>
    <h2><r-t key="backoffice.branches.create" /></h2>
    <x-form action="create" class="stack narrow">
      <p><label><r-t key="backoffice.branches.f.name_en" /> <input name="name_en" maxlength="80" :value="values.name_en if values.form == 'create' else ''" required id="f-create-name_en" :aria-invalid="true if values.form == 'create' and errors.name_en else false" :aria-describedby="'err-name_en' if values.form == 'create' and errors.name_en else none" aria-required="true"></label></p>
      <p><label><r-t key="backoffice.branches.f.name_ar" /> <input name="name_ar" maxlength="80" dir="rtl" :value="values.name_ar if values.form == 'create' else ''" required id="f-create-name_ar" :aria-invalid="true if values.form == 'create' and errors.name_ar else false" :aria-describedby="'err-name_ar' if values.form == 'create' and errors.name_ar else none" aria-required="true"></label></p>
      <p><label><r-t key="backoffice.branches.f.phone" /> <input name="phone" dir="ltr" maxlength="20" :value="values.phone if values.form == 'create' else ''" id="f-create-phone" :aria-invalid="true if values.form == 'create' and errors.phone else false" :aria-describedby="'err-phone' if values.form == 'create' and errors.phone else none"></label></p>
      <p><label><r-t key="backoffice.branches.f.emirate" /> <select name="emirate" id="f-create-emirate" :aria-invalid="true if values.form == 'create' and errors.emirate else false" :aria-describedby="'err-emirate' if values.form == 'create' and errors.emirate else none"><option r-for="e in emirates" :value="e.code" :selected="values.form == 'create' and e.code == values.emirate">{{ e.name }}</option></select></label></p>
      <p><label><r-t key="backoffice.branches.f.area" /> <input name="area" maxlength="80" :value="values.area if values.form == 'create' else ''" id="f-create-area" :aria-invalid="true if values.form == 'create' and errors.area else false" :aria-describedby="'err-area' if values.form == 'create' and errors.area else none"></label></p>
      <p><label><r-t key="backoffice.branches.f.address" /> <input name="address" maxlength="200" :value="values.address if values.form == 'create' else ''" id="f-create-address" :aria-invalid="true if values.form == 'create' and errors.address else false" :aria-describedby="'err-address' if values.form == 'create' and errors.address else none"></label></p>
      <p><button type="submit" class="btn-brand"><r-t key="backoffice.branches.create_submit" /></button></p>
    </x-form>
  </section>
</r-layout>
