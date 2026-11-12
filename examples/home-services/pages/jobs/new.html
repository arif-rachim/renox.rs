<r-layout use="main">
  <r-group slot="title"><r-t key="jobs.new" /> · {{ brand.name }}</r-group>
  <p><a href="/jobs"><r-t key="jobs.back" /></a></p>
  <h1><r-t key="jobs.new" /></h1>
  <p r-if="quote" id="from-quote"><r-t key="jobs.from_quote" :number="quote.number" /></p>
  <x-form action="create" class="stack narrow">
    <input type="hidden" name="quote_id" :value="quote.id" r-if="quote">
    <p><label><r-t key="jobs.f.site" />
      <select name="site_id" required id="f-site_id" :aria-invalid="true if errors.site_id else false" :aria-describedby="'err-site_id' if errors.site_id else none" aria-required="true">
        <option r-for="s in sites" :value="s.id" :selected="(values.site_id is defined and s.id == values.site_id) or (values.site_id is not defined and s.selected)">{{ s.name }}</option>
      </select></label></p>
    <p><label><r-t key="jobs.f.service" />
      <select name="service" required id="f-service" :aria-invalid="true if errors.service else false" :aria-describedby="'err-service' if errors.service else none" aria-required="true">
        <option r-for="s in catalogue" :value="s.sid" :selected="(values.service is defined and s.sid == values.service) or (values.service is not defined and s.selected)">{{ s.name }}</option>
      </select></label></p>
    <p><label><r-t key="jobs.f.priority" />
      <select name="priority" id="f-priority" :aria-invalid="true if errors.priority else false" :aria-describedby="'err-priority' if errors.priority else none">
        <option r-for="p in priorities" :value="p.value" :selected="(values.priority is defined and p.value == values.priority) or (values.priority is not defined and p.current)">{{ ('jobs.priority.' ~ p.value) | t }}</option>
      </select></label></p>
    <p><label><r-t key="jobs.f.description" /> <textarea name="description" rows="4" maxlength="1000" id="f-description" :aria-invalid="true if errors.description else false" :aria-describedby="'err-description' if errors.description else none">{{ values.description if values.description is defined else description }}</textarea></label></p>
    <p><button type="submit" class="btn-brand"><r-t key="jobs.create" /></button> <a href="/jobs"><r-t key="customers.cancel" /></a></p>
  </x-form>
</r-layout>
