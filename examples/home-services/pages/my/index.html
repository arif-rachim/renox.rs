<r-layout use="portal">
  <r-group slot="title"><r-t key="portal.title" /> · {{ brand.name }}</r-group>
  <h1 r-if="name"><r-t key="portal.greeting" :name="name" /></h1>
  <h1 r-else><r-t key="portal.greeting_anon" /></h1>
  <p class="notice" r-if="saved" role="status"><r-t key="portal.name.saved" /></p>
  <p class="notice" r-if="booked" role="status" id="booked"><r-t key="portal.booked" :number="booked" /></p>
  <p><r-t key="portal.signed_in_as" /> <span dir="ltr">{{ phone }}</span></p>
  <p r-if="linked"><r-t key="portal.linked" :count="linked" /></p>
  <p r-else><r-t key="portal.none_linked" /></p>
  <p><a href="/book" class="btn-brand" id="book-link"><r-t key="portal.book_link" /></a></p>

  <div class="tiles" id="my-tiles">
    <a class="tile" href="/my/invoices" id="tile-invoices"><r-t key="my.invoices.title" /> <strong dir="ltr">{{ invoices.count }}</strong> <r-t key="my.invoices.tile_open" /><r-group r-if="invoices.count"> · <span dir="ltr">{{ invoices.sum | money }}</span></r-group></a>
  </div>

  <section aria-labelledby="upcoming-title" id="upcoming">
    <h2 id="upcoming-title"><r-t key="my.upcoming.title" /></h2>
    <ul class="my-list" r-if="upcoming">
      <li r-for="v in upcoming" :id="'upcoming-' ~ v.id">
        <p><strong>{{ v.service }}</strong> · {{ v.site }}<r-group r-if="v.area">, {{ v.area }}</r-group><r-group r-if="v.branch"> · <span class="my-branch"><r-t key="my.branch" /> {{ v.branch }}</span></r-group></p>
        <p r-if="v.waiting and v.has_time" class="my-when"><r-t key="my.upcoming.requested" /> {{ v.weekday }} <span dir="ltr">{{ v.day }}</span> <span dir="ltr">{{ v.from }}–{{ v.to }}</span><r-t key="my.upcoming.waiting" /></p>
        <p r-if="v.waiting and !v.has_time" class="my-when"><r-t key="my.upcoming.no_time" /></p>
        <p r-if="!v.waiting" class="my-when">{{ v.weekday }} <span dir="ltr">{{ v.day }}</span> <span dir="ltr">{{ v.from }}–{{ v.to }}</span></p>
        <p><span :class="'status status-' ~ v.status">{{ v.status_key | t }}</span><r-group r-if="v.technician"> · <r-t key="my.technician" /> {{ v.technician }}</r-group></p>
        <p><a :href="v.href"><r-t key="my.details" /> <span dir="ltr">{{ v.number }}</span></a></p>
      </li>
    </ul>
    <p r-else class="muted" id="upcoming-empty"><r-t key="my.upcoming.empty" /></p>
  </section>

  <section aria-labelledby="past-title" id="past">
    <h2 id="past-title"><r-t key="my.past.title" /></h2>
    <ul class="my-list" r-if="past.items">
      <li r-for="v in past.items" :id="'past-' ~ v.id">
        <p><span dir="ltr">{{ v.day }}</span> · <strong>{{ v.service }}</strong> · {{ v.site }}<r-group r-if="v.branch"> · <span class="my-branch"><r-t key="my.branch" /> {{ v.branch }}</span></r-group></p>
        <p><span :class="'status status-' ~ v.status">{{ v.status_key | t }}</span> · <a :href="v.href"><r-t key="my.details" /> <span dir="ltr">{{ v.number }}</span></a></p>
      </li>
    </ul>
    <p r-else class="muted" id="past-empty"><r-t key="my.past.empty" /></p>
    <nav r-if="past.pages > 1" class="pager" :aria-label="'my.past.pages' | t">
      <a r-if="past.prev" :href="past.prev" rel="prev" id="past-prev"><r-t key="my.past.prev" /></a>
      <span><r-t key="my.past.page" /> <span dir="ltr">{{ past.page }} / {{ past.pages }}</span></span>
      <a r-if="past.next" :href="past.next" rel="next" id="past-next"><r-t key="my.past.next" /></a>
    </nav>
  </section>

  <section aria-labelledby="contracts-title" id="contracts">
    <h2 id="contracts-title"><r-t key="my.contracts.title" /></h2>
    <ul class="my-list" r-if="contracts">
      <li r-for="c in contracts" :id="'contract-' ~ c.id">
        <p><strong dir="ltr">{{ c.number }}</strong><r-group r-if="c.branch"> · <span class="my-branch"><r-t key="my.branch" /> {{ c.branch }}</span></r-group></p>
        <p><r-t key="my.contracts.period" /> <span dir="ltr">{{ c.starts_on }} – {{ c.ends_on }}</span></p>
        <ul>
          <li r-for="i in c.items">{{ i.service }} · {{ i.site }} · <span dir="ltr">{{ i.visits_per_year }}</span> <r-t key="my.contracts.per_year" /></li>
        </ul>
        <p r-if="c.next_visit"><r-t key="my.contracts.next" /> <span dir="ltr">{{ c.next_visit }}</span></p>
        <p r-if="c.ends_soon" class="notice"><r-t key="my.contracts.ends_on" /> <span dir="ltr">{{ c.ends_on }}</span><r-t key="my.contracts.renewal" /></p>
      </li>
    </ul>
    <p r-else class="muted" id="contracts-empty"><r-t key="my.contracts.empty" /></p>
  </section>

  <section r-if="!name" aria-labelledby="name-title">
    <h2 id="name-title"><r-t key="portal.name.title" /></h2>
    <p class="muted"><r-t key="portal.name.hint" /></p>
    <x-form action="name">
      <p><label><r-t key="portal.name.title" /> <input name="display_name" maxlength="80" autocomplete="name" :value="values.display_name" required id="f-display_name" :aria-invalid="true if errors.display_name else false" :aria-describedby="'err-display_name' if errors.display_name else none" aria-required="true"></label></p>
      <p><button type="submit" class="btn-brand"><r-t key="portal.name.save" /></button></p>
    </x-form>
  </section>
</r-layout>
