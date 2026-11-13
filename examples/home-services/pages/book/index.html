<r-layout use="portal">
  <r-group slot="title"><r-t key="book.title" /> · {{ brand.name }}</r-group>
  <h1><r-t key="book.title" /></h1>
  <p class="muted" id="book-step"><r-t key="book.step" :n="step" /></p>

  <r-group r-if="step == 1">
    <form method="get" action="/book" class="stack narrow" id="book-place">
      <fieldset id="f-service" :aria-describedby="'err-service' if errors.service else none">
        <legend><r-t key="book.f.service" /></legend>
        <p r-for="s in services"><label><input type="radio" name="service" :value="s.id" :checked="s.checked" required> {{ s.name }} · <r-t key="book.from" /> <span dir="ltr">{{ s.price | money }}</span></label></p>
        <p r-empty="services"><r-t key="book.no_services" /></p>
      </fieldset>
      <p><label><r-t key="book.f.emirate" /> <select name="emirate" required id="f-emirate" :aria-invalid="true if errors.emirate else false" :aria-describedby="'err-emirate' if errors.emirate else none" aria-required="true">
        <option value=""><r-t key="book.choose" /></option>
        <option r-for="e in emirates" :value="e.code" :selected="e.code == values.emirate">{{ e.name }}</option>
      </select></label> <button type="submit" name="step" value="1" formnovalidate><r-t key="book.show_areas" /></button></p>
      <p r-if="areas"><label><r-t key="book.f.area" /> <select name="area" required id="f-area" :aria-invalid="true if errors.area else false" :aria-describedby="'err-area' if errors.area else none" aria-required="true">
        <option value=""><r-t key="book.choose" /></option>
        <option r-for="a in areas" :value="a.value" :selected="a.selected">{{ a.name }}</option>
      </select></label></p>
      <p r-else class="muted" id="f-area" tabindex="-1"><r-t key="book.area_hint" /></p>
      <p><label><r-t key="book.f.address" /> <input name="address" minlength="5" maxlength="200" autocomplete="street-address" :value="values.address" required id="f-address" :aria-invalid="true if errors.address else false" :aria-describedby="'err-address' if errors.address else none" aria-required="true"></label></p>
      <p><label><r-t key="book.f.makani" /> <input name="makani" dir="ltr" inputmode="numeric" maxlength="20" :value="values.makani" id="f-makani" :aria-invalid="true if errors.makani else false" :aria-describedby="'err-makani' if errors.makani else none"></label></p>
      <p><label><r-t key="book.f.notes" /> <textarea name="notes" maxlength="500" id="f-notes" :aria-invalid="true if errors.notes else false" :aria-describedby="'err-notes' if errors.notes else none">{{ values.notes }}</textarea></label></p>
      <p><button type="submit" name="step" value="2" class="btn-brand"><r-t key="book.next" /></button></p>
    </form>
  </r-group>

  <r-group r-if="step == 2">
    <section r-if="no_branch" id="no-branch" aria-labelledby="no-branch-title">
      <h2 id="no-branch-title"><r-t key="book.no_branch" /></h2>
      <p r-if="company_phone"><r-t key="book.call_us" /> <a :href="'tel:' ~ company_phone" dir="ltr">{{ company_phone }}</a></p>
      <p><a :href="back"><r-t key="book.back" /></a></p>
    </section>
    <r-group r-else>
      <p><r-t key="book.branch" :branch="branch.name" /></p>
      <p class="notice" r-if="taken" role="status" id="taken"><r-t key="book.taken" /></p>
      <nav class="book-days" :aria-label="'book.days' | t">
        <ul class="row">
          <li r-for="d in days"><strong r-if="d.current" aria-current="date">{{ d.label }} <span dir="ltr">{{ d.key }}</span></strong><a r-else :href="d.href">{{ d.label }} <span dir="ltr">{{ d.key }}</span></a></li>
        </ul>
      </nav>
      <form method="get" action="/book" class="stack narrow" id="book-time">
        <input type="hidden" r-for="h in hidden" :name="h.name" :value="h.value">
        <input type="hidden" name="day" :value="day">
        <fieldset r-if="slots" id="f-slot" :aria-describedby="'err-slot' if errors.slot else none">
          <legend><r-t key="book.f.slot" /> · {{ day_label }} <span dir="ltr">{{ day }}</span></legend>
          <p r-for="s in slots"><label><input type="radio" name="slot" :value="s.value" :checked="s.checked" required> <span dir="ltr">{{ s.from }}–{{ s.to }}</span></label></p>
        </fieldset>
        <p r-else id="f-slot" tabindex="-1"><r-t key="book.no_slots" /></p>
        <p><button r-if="slots" type="submit" name="step" value="3" class="btn-brand"><r-t key="book.next" /></button> <a :href="back"><r-t key="book.back" /></a></p>
      </form>
    </r-group>
  </r-group>

  <r-group r-if="step == 3">
    <section aria-labelledby="summary-title">
      <h2 id="summary-title"><r-t key="book.summary" /></h2>
      <dl>
        <dt><r-t key="book.f.service" /></dt><dd>{{ summary.service }}</dd>
        <dt><r-t key="book.f.place" /></dt><dd>{{ summary.address }}, {{ summary.area }}, {{ summary.emirate }}</dd>
        <dt><r-t key="book.f.time" /></dt><dd><span dir="ltr">{{ summary.day }}</span> <span dir="ltr">{{ summary.from }}–{{ summary.to }}</span></dd>
      </dl>
    </section>
    <x-form action="hold" class="stack narrow" id="book-you">
      <input type="hidden" r-for="h in hidden" :name="h.name" :value="h.value">
      <p><label><r-t key="book.f.name" /> <input name="name" minlength="2" maxlength="80" autocomplete="name" :value="values.name" required id="f-name" :aria-invalid="true if errors.name else false" :aria-describedby="'err-name' if errors.name else none" aria-required="true"></label></p>
      <p r-if="portal_phone"><r-t key="book.your_phone" /> <span dir="ltr">{{ portal_phone }}</span></p>
      <r-group r-else>
        <p><label><r-t key="book.f.phone" /> <input name="phone" type="tel" dir="ltr" autocomplete="tel" placeholder="+971 50 123 4567" maxlength="40" :value="values.phone" required id="f-phone" :aria-invalid="true if errors.phone else false" :aria-describedby="'err-phone' if errors.phone else none" aria-required="true"></label></p>
        <p class="muted"><r-t key="book.code_hint" /></p>
      </r-group>
      <p><label><r-t key="book.f.language" /> <select name="language" id="f-language" :aria-invalid="true if errors.language else false" :aria-describedby="'err-language' if errors.language else none">
        <option value="en" :selected="values.language != 'ar'"><r-t key="app.lang.en" /></option>
        <option value="ar" :selected="values.language == 'ar'"><r-t key="app.lang.ar" /></option>
      </select></label></p>
      <p><button type="submit" class="btn-brand"><r-t key="book.send" /></button> <a :href="back"><r-t key="book.back" /></a></p>
    </x-form>
  </r-group>
</r-layout>
