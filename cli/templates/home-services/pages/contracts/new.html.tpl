<r-layout use="main">
  <r-group slot="title"><r-t key="contracts.new" /> · {{ brand.name }}</r-group>
  <p><a href="/contracts"><r-t key="contracts.back" /></a></p>
  <h1><r-t key="contracts.new" /></h1>
  <x-form action="create" class="stack narrow">
    <p><label><r-t key="contracts.f.customer" />
      <select name="customer_id" required id="f-customer_id" :aria-invalid="true if errors.customer_id else false" :aria-describedby="'err-customer_id' if errors.customer_id else none" aria-required="true">
        <option r-for="c in customers" :value="c.id" :selected="c.id == values.customer_id">{{ c.name }}</option>
      </select></label></p>
    <p><label><r-t key="contracts.f.starts" /> <input type="date" name="starts_on" :value="values.starts_on if values.starts_on is defined else starts_on" dir="ltr" required id="f-starts_on" :aria-invalid="true if errors.starts_on else false" :aria-describedby="'err-starts_on' if errors.starts_on else none" aria-required="true"></label></p>
    <p><label><r-t key="contracts.f.ends" /> <input type="date" name="ends_on" :value="values.ends_on if values.ends_on is defined else ends_on" dir="ltr" id="f-ends_on" :aria-invalid="true if errors.ends_on else false" :aria-describedby="'err-ends_on' if errors.ends_on else none"></label></p>
    <p><label><r-t key="contracts.f.price_year" /> <input name="price" inputmode="decimal" dir="ltr" :value="values.price if values.price is defined else '0'" id="f-price" :aria-invalid="true if errors.price else false" :aria-describedby="'err-price' if errors.price else none"></label></p>
    <p><small class="muted"><r-t key="contracts.price_hint" /></small></p>
    <p><label><r-t key="contracts.f.notes" /> <textarea name="notes" rows="3" maxlength="1000" id="f-notes" :aria-invalid="true if errors.notes else false" :aria-describedby="'err-notes' if errors.notes else none">{{ values.notes }}</textarea></label></p>
    <fieldset r-for="s in slots">
      <legend><r-t key="contracts.f.item" /> {{ s.label }}</legend>
      <p><label><r-t key="contracts.f.site" />
        <select :name="'site_id_' ~ s.n" :id="'f-site_id_' ~ s.n" :aria-invalid="true if errors['site_id_' ~ s.n] else false" :aria-describedby="'err-site_id_' ~ s.n if errors['site_id_' ~ s.n] else none">
          <option value="">—</option>
          <option r-for="x in sites" :value="x.id" :selected="x.id == values['site_id_' ~ s.n]">{{ x.name }}</option>
        </select></label></p>
      <p><label><r-t key="contracts.f.service" />
        <select :name="'service_' ~ s.n" :id="'f-service_' ~ s.n" :aria-invalid="true if errors['service_' ~ s.n] else false" :aria-describedby="'err-service_' ~ s.n if errors['service_' ~ s.n] else none">
          <option value="">—</option>
          <option r-for="x in catalogue" :value="x.sid" :selected="x.sid == values['service_' ~ s.n]">{{ x.name }}</option>
        </select></label></p>
      <p><label><r-t key="contracts.f.visits" /> <input :name="'visits_' ~ s.n" inputmode="numeric" dir="ltr" maxlength="2" :value="values['visits_' ~ s.n]" :id="'f-visits_' ~ s.n" :aria-invalid="true if errors['visits_' ~ s.n] else false" :aria-describedby="'err-visits_' ~ s.n if errors['visits_' ~ s.n] else none"></label></p>
    </fieldset>
    <p><button type="submit" class="btn-brand"><r-t key="contracts.create" /></button> <a href="/contracts"><r-t key="customers.cancel" /></a></p>
  </x-form>
</r-layout>
