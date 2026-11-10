<r-layout use="main">
  <r-group slot="title"><r-t key="quotes.new" /> · {{ brand.name }}</r-group>
  <p><a href="/quotes"><r-t key="quotes.back" /></a></p>
  <h1><r-t key="quotes.new" /></h1>
  <x-form action="create" class="stack">
    <section class="stack narrow">
      <p><label><r-t key="quotes.f.site" />
        <select name="site_id" required id="f-site_id" :aria-invalid="'true' if errors.site_id else 'false'" :aria-describedby="'err-site_id' if errors.site_id else ''" aria-required="true">
          <option value="">—</option>
          <option r-for="s in sites" :value="s.id" :selected="s.selected">{{ s.name }}</option>
        </select></label></p>
      <p><label><r-t key="quotes.f.valid_days" /> <input name="valid_days" type="number" min="1" max="365" :value="v.valid_days" dir="ltr" id="f-valid_days" :aria-invalid="'true' if errors.valid_days else 'false'" :aria-describedby="'err-valid_days' if errors.valid_days else ''"></label></p>
    </section>
    <section class="stack narrow" id="ai-draft">
      <h2><r-t key="quotes.ai.title" /></h2>
      <p><label><r-t key="quotes.ai.request" /> <textarea name="request" rows="3" maxlength="2000" id="f-request" :aria-invalid="'true' if errors.request else 'false'" :aria-describedby="'err-request' if errors.request else ''">{{ v.request }}</textarea></label></p>
      <p><button type="submit" formaction="?/draft" id="draft-button"><r-t key="quotes.ai.draft" /></button></p>
      <p class="notice" id="ai-off" r-if="ai_state == 'off'"><r-t key="quotes.ai.off" /></p>
      <p class="notice" id="ai-quota" r-if="ai_state == 'quota'"><r-t key="quotes.ai.quota" /></p>
      <p class="notice" id="ai-none" r-if="ai_state == 'on' && drafted == 0"><r-t key="quotes.ai.none" /></p>
      <p class="notice" id="ai-done" r-if="ai_state == 'on' && drafted > 0"><r-t key="quotes.ai.done" /></p>
    </section>
    <h2><r-t key="quotes.lines" /></h2>
    <table id="lines">
    <caption class="visually-hidden"><r-t key="quotes.lines" /></caption>
      <thead><tr><th scope="col"><r-t key="quotes.f.service" /></th><th scope="col"><r-t key="quotes.f.desc" /></th><th scope="col"><r-t key="quotes.f.qty" /></th><th scope="col"><r-t key="quotes.f.price" /></th></tr></thead>
      <tbody>
        <tr r-for="r in rows" :id="'row-' ~ r.i">
          <td><select :name="'service_' ~ r.i" :aria-label="('quotes.f.service' | t) ~ ', ' ~ ('problem.line' | t) ~ ' ' ~ (r.i + 1)" :id="'f-service_' ~ r.i" :aria-invalid="'true' if errors['service_' ~ r.i] else 'false'" :aria-describedby="'err-service_' ~ r.i if errors['service_' ~ r.i] else ''">
            <option value="">—</option>
            <option r-for="s in catalogue" :value="s.sid" :selected="s.sid == r.service">{{ s.name }}</option>
          </select></td>
          <td><input :name="'desc_' ~ r.i" :aria-label="('quotes.f.desc' | t) ~ ', ' ~ ('problem.line' | t) ~ ' ' ~ (r.i + 1)" :value="r.desc" maxlength="200" :id="'f-desc_' ~ r.i" :aria-invalid="'true' if errors['desc_' ~ r.i] else 'false'" :aria-describedby="'err-desc_' ~ r.i if errors['desc_' ~ r.i] else ''"><input :name="'desc_ar_' ~ r.i" :aria-label="('quotes.f.desc_ar' | t) ~ ', ' ~ ('problem.line' | t) ~ ' ' ~ (r.i + 1)" :value="r.desc_ar" maxlength="200" dir="rtl" :placeholder="'quotes.f.desc_ar' | t" :id="'f-desc_ar_' ~ r.i" :aria-invalid="'true' if errors['desc_' ~ r.i] else 'false'" :aria-describedby="'err-desc_' ~ r.i if errors['desc_' ~ r.i] else ''"></td>
          <td><input :name="'qty_' ~ r.i" :aria-label="('quotes.f.qty' | t) ~ ', ' ~ ('problem.line' | t) ~ ' ' ~ (r.i + 1)" :value="r.qty" size="5" dir="ltr" inputmode="decimal" :id="'f-qty_' ~ r.i" :aria-invalid="'true' if errors['qty_' ~ r.i] else 'false'" :aria-describedby="'err-qty_' ~ r.i if errors['qty_' ~ r.i] else ''"></td>
          <td><input :name="'price_' ~ r.i" :aria-label="('quotes.f.price' | t) ~ ', ' ~ ('problem.line' | t) ~ ' ' ~ (r.i + 1)" :value="r.price" size="9" dir="ltr" inputmode="decimal" :placeholder="'quotes.f.price_default' | t" :id="'f-price_' ~ r.i" :aria-invalid="'true' if errors['price_' ~ r.i] else 'false'" :aria-describedby="'err-price_' ~ r.i if errors['price_' ~ r.i] else ''"></td>
        </tr>
      </tbody>
    </table>
    <p><label><r-t key="quotes.f.notes" /> <textarea name="notes" rows="3" maxlength="1000" id="f-notes" :aria-invalid="'true' if errors.notes else 'false'" :aria-describedby="'err-notes' if errors.notes else ''">{{ v.notes }}</textarea></label></p>
    <p><button type="submit" class="btn-brand"><r-t key="quotes.create" /></button> <a href="/quotes"><r-t key="customers.cancel" /></a></p>
  </x-form>
</r-layout>
