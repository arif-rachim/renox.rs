<r-layout use="back-office">
  <r-group slot="title"><r-t key="suppliers.title" /> · {{ brand.name }}</r-group>
  <h1><r-t key="suppliers.title" /></h1>
  <p class="notice" id="saved" r-if="saved"><r-group r-if="saved == 'created'"><r-t key="suppliers.created" /></r-group><r-group r-else-if="saved == 'updated'"><r-t key="suppliers.updated" /></r-group><r-group r-else-if="saved == 'activated'"><r-t key="suppliers.activated" /></r-group><r-group r-else><r-t key="suppliers.deactivated" /></r-group></p>
  <div class="table-scroll" tabindex="0"><table id="suppliers">
    <caption class="visually-hidden"><r-t key="suppliers.title" /></caption>
    <thead>
      <tr><th scope="col"><r-t key="suppliers.f.name" /></th><th scope="col"><r-t key="suppliers.f.trn" /></th><th scope="col"><r-t key="suppliers.f.phone" /></th><th scope="col"><r-t key="suppliers.f.email" /></th><th scope="col"><r-t key="suppliers.f.active" /></th><th scope="col" r-can="purchase.write"><r-t key="suppliers.f.actions" /></th></tr>
    </thead>
    <tbody>
      <tr r-for="s in suppliers" :id="'supplier-' ~ s.id">
        <td>{{ s.name }}</td>
        <td dir="ltr">{{ s.trn }}</td>
        <td dir="ltr">{{ s.phone }}</td>
        <td dir="ltr">{{ s.email }}</td>
        <td><r-group r-if="s.active"><r-t key="suppliers.on" /></r-group><r-group r-else><r-t key="suppliers.off" /></r-group></td>
        <td r-can="purchase.write">
          <a :href="'/admin/suppliers?edit=' ~ s.id ~ '#supplier-form'" :id="'edit-' ~ s.id"><r-t key="suppliers.edit_link" /></a>
          <x-form action="active" class="inline">
            <input type="hidden" name="id" :value="s.id">
            <input type="hidden" name="active" :value="0 if s.active else 1">
            <button type="submit" :id="'active-' ~ s.id"><r-group r-if="s.active"><r-t key="suppliers.deactivate" /></r-group><r-group r-else><r-t key="suppliers.activate" /></r-group></button>
          </x-form>
        </td>
      </tr>
      <tr r-empty="suppliers"><td colspan="6"><r-t key="suppliers.none" /></td></tr>
    </tbody>
  </table></div>
  <section r-can="purchase.write" id="supplier-form">
    <h2><r-group r-if="(values.id if values.id is defined else form.id)"><r-t key="suppliers.edit" /></r-group><r-group r-else><r-t key="suppliers.add" /></r-group></h2>
    <x-form action="save" class="stack narrow">
      <input type="hidden" name="id" :value="values.id if values.id is defined else form.id">
      <p><label><r-t key="suppliers.f.name" /> <input name="name" maxlength="120" required :value="values.name if values.name is defined else form.name" id="f-name" :aria-invalid="true if errors.name else false" :aria-describedby="'err-name' if errors.name else none" aria-required="true"></label></p>
      <p><label><r-t key="suppliers.f.trn" /> <input name="trn" dir="ltr" maxlength="40" :value="values.trn if values.trn is defined else form.trn" id="f-trn" :aria-invalid="true if errors.trn else false" :aria-describedby="'err-trn' if errors.trn else none"></label></p>
      <p><label><r-t key="suppliers.f.phone" /> <input name="phone" type="tel" dir="ltr" maxlength="40" :value="values.phone if values.phone is defined else form.phone" id="f-phone" :aria-invalid="true if errors.phone else false" :aria-describedby="'err-phone' if errors.phone else none"></label></p>
      <p><label><r-t key="suppliers.f.email" /> <input name="email" type="email" dir="ltr" maxlength="254" :value="values.email if values.email is defined else form.email" id="f-email" :aria-invalid="true if errors.email else false" :aria-describedby="'err-email' if errors.email else none"></label></p>
      <p><label><r-t key="suppliers.f.address" /> <input name="address" maxlength="300" :value="values.address if values.address is defined else form.address" id="f-address" :aria-invalid="true if errors.address else false" :aria-describedby="'err-address' if errors.address else none"></label></p>
      <p><label><r-t key="suppliers.f.notes" /> <textarea name="notes" rows="3" maxlength="1000" id="f-notes" :aria-invalid="true if errors.notes else false" :aria-describedby="'err-notes' if errors.notes else none">{{ values.notes if values.notes is defined else form.notes }}</textarea></label></p>
      <p>
        <button type="submit" class="btn-brand" id="save-supplier"><r-group r-if="(values.id if values.id is defined else form.id)"><r-t key="suppliers.save" /></r-group><r-group r-else><r-t key="suppliers.add_submit" /></r-group></button>
        <a r-if="(values.id if values.id is defined else form.id)" href="/admin/suppliers"><r-t key="suppliers.cancel" /></a>
      </p>
    </x-form>
  </section>
</r-layout>
