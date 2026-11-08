<r-layout use="main">
  <r-group slot="title"><r-t key="catalogue.title" /> · {{ brand.name }}</r-group>
  <h1><r-t key="catalogue.title" /></h1>
  <p class="notice" id="saved" r-if="saved"><r-t key="catalogue.saved" :code="saved" /></p>
  <table id="services">
    <thead>
      <tr><th><r-t key="catalogue.f.code" /></th><th><r-t key="catalogue.f.name" /></th><th><r-t key="catalogue.f.unit" /></th><th><r-t key="catalogue.f.price" /></th><th><r-t key="catalogue.f.vat" /></th><th><r-t key="catalogue.f.active" /></th></tr>
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
  </table>
  <section r-can="settings.write">
    <h2><r-t key="catalogue.edit" /></h2>
    <x-form action="save" class="row" r-for="s in services">
      <input type="hidden" name="service" :value="s.id">
      <span dir="ltr">{{ s.code }}</span>
      <label><r-t key="catalogue.f.price" /> <input name="price" dir="ltr" inputmode="decimal" :value="s.price_input" size="8"></label>
      <label><input type="checkbox" name="active" value="1" :checked="s.active"> <r-t key="catalogue.f.active" /></label>
      <button type="submit"><r-t key="catalogue.save" /></button>
    </x-form>
  </section>
</r-layout>
