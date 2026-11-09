<r-layout use="main">
  <r-group slot="title">{{ customer.name }} · {{ brand.name }}</r-group>
  <p><a href="/customers"><r-t key="customers.back" /></a></p>
  <h1>{{ customer.name }}</h1>
  <dl class="detail">
    <dt><r-t key="customers.f.kind" /></dt>
    <dd><r-group r-if="customer.kind == 'company'"><r-t key="customers.kind.company" /></r-group><r-group r-else><r-t key="customers.kind.household" /></r-group></dd>
    <dt><r-t key="customers.f.phone" /></dt>
    <dd dir="ltr">{{ customer.phone }}</dd>
    <dt r-if="customer.trn"><r-t key="customers.f.trn" /></dt>
    <dd r-if="customer.trn" dir="ltr">{{ customer.trn }}</dd>
    <dt r-if="customer.email"><r-t key="customers.f.email" /></dt>
    <dd r-if="customer.email" dir="ltr">{{ customer.email }}</dd>
    <dt><r-t key="customers.f.language" /></dt>
    <dd><r-group r-if="customer.language == 'ar'"><r-t key="app.lang.ar" /></r-group><r-group r-else><r-t key="app.lang.en" /></r-group></dd>
  </dl>
  <h2><r-t key="customers.sites" /></h2>
  <ul id="sites">
    <li r-for="s in sites" :id="'site-' + s.id">
      <strong>{{ s.label }}</strong> · {{ s.area }}, {{ s.emirate_name }}<br>
      {{ s.address }}
      <r-group r-if="s.makani"><br><r-t key="customers.f.makani" />: <span dir="ltr">{{ s.makani }}</span></r-group>
      <r-group r-if="s.access_notes"><br><small>{{ s.access_notes }}</small></r-group>
    </li>
    <li r-empty="sites"><r-t key="customers.no_sites" /></li>
  </ul>
  <section r-can="customer.write"><x-form action="addSite" class="stack narrow">
    <h3><r-t key="customers.add_site" /></h3>
    <x-site-fields :emirates="emirates" :values="values" />
    <p><button type="submit" class="btn-brand"><r-t key="customers.add_site_submit" /></button></p>
  </x-form></section>
</r-layout>
