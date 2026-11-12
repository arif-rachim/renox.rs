<r-layout use="main">
  <r-group slot="title"><r-t key="catalogue.title" /> · {{ brand.name }}</r-group>
  <h1><r-t key="catalogue.title" /></h1>
  <p class="notice" id="saved" r-if="saved"><r-t key="catalogue.saved" :code="saved" /></p>
  <div class="table-scroll" tabindex="0"><table id="services">
    <caption class="visually-hidden"><r-t key="catalogue.title" /></caption>
    <thead>
      <tr><th scope="col"><r-t key="catalogue.f.code" /></th><th scope="col"><r-t key="catalogue.f.name" /></th><th scope="col"><r-t key="catalogue.f.unit" /></th><th scope="col"><r-t key="catalogue.f.price" /></th><th scope="col"><r-t key="catalogue.f.vat" /></th><th scope="col"><r-t key="catalogue.f.active" /></th></tr>
    </thead>
    <tbody>
      <tr r-for="s in services" :id="'service-' ~ s.id">
        <td dir="ltr">{{ s.code }}</td>
        <td>{{ s.name }}</td>
        <td><r-group r-if="s.unit == 'visit'"><r-t key="catalogue.unit.visit" /></r-group><r-group r-else-if="s.unit == 'hour'"><r-t key="catalogue.unit.hour" /></r-group><r-group r-else><r-t key="catalogue.unit.unit" /></r-group></td>
        <td dir="ltr">{{ s.price | money }}</td>
        <td dir="ltr">{{ s.vat_rate }}%</td>
        <td><r-group r-if="s.active"><r-t key="catalogue.on" /></r-group><r-group r-else><r-t key="catalogue.off" /></r-group></td>
      </tr>
      <tr r-empty="services"><td colspan="6"><r-t key="catalogue.none" /></td></tr>
    </tbody>
  </table></div>
  <section r-can="settings.write">
    <h2><r-t key="catalogue.edit" /></h2>
    <x-form action="save" class="row" r-for="s in services">
      <input type="hidden" name="service" :value="s.id">
      <span dir="ltr">{{ s.code }}</span>
      <label><r-t key="catalogue.f.price" /> <input name="price" dir="ltr" inputmode="decimal" :value="values.price if (values.service == s.id and values.price is defined) else s.price_input" size="8" :id="'f-price' if values.service == s.id else 'f-price-' ~ s.id" :aria-invalid="true if values.service == s.id and errors.price else false" :aria-describedby="'err-price' if values.service == s.id and errors.price else none"></label>
      <label><input type="checkbox" name="active" value="1" :checked="(values.service == s.id and values.price is defined and values.active == '1') or ((values.service != s.id or values.price is not defined) and s.active)" :id="'f-active' if values.service == s.id else 'f-active-' ~ s.id" :aria-invalid="true if values.service == s.id and errors.active else false" :aria-describedby="'err-active' if values.service == s.id and errors.active else none"> <r-t key="catalogue.f.active" /></label>
      <button type="submit"><r-t key="catalogue.save" /></button>
    </x-form>
  </section>
</r-layout>
