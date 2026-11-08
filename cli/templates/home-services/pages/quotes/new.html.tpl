<r-layout use="main">
  <r-group slot="title"><r-t key="quotes.new" /> · {{ brand.name }}</r-group>
  <p><a href="/quotes"><r-t key="quotes.back" /></a></p>
  <h1><r-t key="quotes.new" /></h1>
  <x-form action="create" class="stack">
    <section class="stack narrow">
      <p><label><r-t key="quotes.f.site" />
        <select name="site_id" required>
          <option value="">—</option>
          <option r-for="s in sites" :value="s.id" :selected="s.selected">{{ s.name }}</option>
        </select></label></p>
      <p><label><r-t key="quotes.f.valid_days" /> <input name="valid_days" type="number" min="1" max="365" :value="v.valid_days" dir="ltr"></label></p>
    </section>
    <section class="stack narrow" id="ai-draft">
      <h2><r-t key="quotes.ai.title" /></h2>
      <p><label><r-t key="quotes.ai.request" /> <textarea name="request" rows="3" maxlength="2000">{{ v.request }}</textarea></label></p>
      <p><button type="submit" formaction="?/draft" id="draft-button"><r-t key="quotes.ai.draft" /></button></p>
      <p class="notice" id="ai-off" r-if="ai_state == 'off'"><r-t key="quotes.ai.off" /></p>
      <p class="notice" id="ai-quota" r-if="ai_state == 'quota'"><r-t key="quotes.ai.quota" /></p>
      <p class="notice" id="ai-none" r-if="ai_state == 'on' && drafted == 0"><r-t key="quotes.ai.none" /></p>
      <p class="notice" id="ai-done" r-if="ai_state == 'on' && drafted > 0"><r-t key="quotes.ai.done" /></p>
    </section>
    <h2><r-t key="quotes.lines" /></h2>
    <table id="lines">
      <thead><tr><th><r-t key="quotes.f.service" /></th><th><r-t key="quotes.f.desc" /></th><th><r-t key="quotes.f.qty" /></th><th><r-t key="quotes.f.price" /></th></tr></thead>
      <tbody>
        <tr r-for="r in rows" :id="'row-' ~ r.i">
          <td><select :name="'service_' ~ r.i">
            <option value="">—</option>
            <option r-for="s in catalogue" :value="s.sid" :selected="s.sid == r.service">{{ s.name }}</option>
          </select></td>
          <td><input :name="'desc_' ~ r.i" :value="r.desc" maxlength="200"><input :name="'desc_ar_' ~ r.i" :value="r.desc_ar" maxlength="200" dir="rtl" :placeholder="'quotes.f.desc_ar' | t"></td>
          <td><input :name="'qty_' ~ r.i" :value="r.qty" size="5" dir="ltr" inputmode="decimal"></td>
          <td><input :name="'price_' ~ r.i" :value="r.price" size="9" dir="ltr" inputmode="decimal" :placeholder="'quotes.f.price_default' | t"></td>
        </tr>
      </tbody>
    </table>
    <p><label><r-t key="quotes.f.notes" /> <textarea name="notes" rows="3" maxlength="1000">{{ v.notes }}</textarea></label></p>
    <p><button type="submit" class="btn-brand"><r-t key="quotes.create" /></button> <a href="/quotes"><r-t key="customers.cancel" /></a></p>
  </x-form>
</r-layout>
