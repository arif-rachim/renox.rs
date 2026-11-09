<r-layout use="main">
  <r-group slot="title"><r-t key="contracts.new" /> · {{ brand.name }}</r-group>
  <p><a href="/contracts"><r-t key="contracts.back" /></a></p>
  <h1><r-t key="contracts.new" /></h1>
  <x-form action="create" class="stack narrow">
    <p><label><r-t key="contracts.f.customer" />
      <select name="customer_id" required>
        <option r-for="c in customers" :value="c.id" :selected="c.id == values.customer_id">{{ c.name }}</option>
      </select></label></p>
    <p><label><r-t key="contracts.f.starts" /> <input type="date" name="starts_on" :value="values.starts_on if values.starts_on is defined else starts_on" dir="ltr" required></label></p>
    <p><label><r-t key="contracts.f.ends" /> <input type="date" name="ends_on" :value="values.ends_on if values.ends_on is defined else ends_on" dir="ltr"></label></p>
    <p><label><r-t key="contracts.f.price_year" /> <input name="price" inputmode="decimal" dir="ltr" :value="values.price if values.price is defined else '0'"></label></p>
    <p><small class="muted"><r-t key="contracts.price_hint" /></small></p>
    <p><label><r-t key="contracts.f.notes" /> <textarea name="notes" rows="3" maxlength="1000">{{ values.notes }}</textarea></label></p>
    <fieldset r-for="s in slots">
      <legend><r-t key="contracts.f.item" /> {{ s.label }}</legend>
      <p><label><r-t key="contracts.f.site" />
        <select :name="'site_id_' ~ s.n">
          <option value="">—</option>
          <option r-for="x in sites" :value="x.id" :selected="x.id == values['site_id_' ~ s.n]">{{ x.name }}</option>
        </select></label></p>
      <p><label><r-t key="contracts.f.service" />
        <select :name="'service_' ~ s.n">
          <option value="">—</option>
          <option r-for="x in catalogue" :value="x.sid" :selected="x.sid == values['service_' ~ s.n]">{{ x.name }}</option>
        </select></label></p>
      <p><label><r-t key="contracts.f.visits" /> <input :name="'visits_' ~ s.n" inputmode="numeric" dir="ltr" maxlength="2" :value="values['visits_' ~ s.n]"></label></p>
    </fieldset>
    <p><button type="submit" class="btn-brand"><r-t key="contracts.create" /></button> <a href="/contracts"><r-t key="customers.cancel" /></a></p>
  </x-form>
</r-layout>
