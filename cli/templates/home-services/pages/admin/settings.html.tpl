<r-layout use="back-office">
  <r-group slot="title"><r-t key="backoffice.settings.title" /> · {{ brand.name }}</r-group>
  <h1><r-t key="backoffice.settings.title" /></h1>
  <p class="notice" id="saved" r-if="saved"><r-t key="backoffice.settings.saved" /></p>
  <x-form action="save" enctype="multipart/form-data" hx-encoding="multipart/form-data" class="stack narrow">
    <p><label><r-t key="backoffice.settings.f.brand_name" /> <input name="brand_name" maxlength="80" :value="f.brand_name" required id="f-brand_name" :aria-invalid="true if errors.brand_name else false" :aria-describedby="'err-brand_name' if errors.brand_name else none" aria-required="true"></label></p>
    <p><label><r-t key="backoffice.settings.f.brand_name_ar" /> <input name="brand_name_ar" maxlength="80" dir="rtl" :value="f.brand_name_ar" id="f-brand_name_ar" :aria-invalid="true if errors.brand_name_ar else false" :aria-describedby="'err-brand_name_ar' if errors.brand_name_ar else none"></label></p>
    <p><label><r-t key="backoffice.settings.f.color" /> <input name="brand_color" dir="ltr" maxlength="7" pattern="#[0-9a-fA-F]{6}" placeholder="#1f6f5c" :value="f.brand_color" required id="f-brand_color" :aria-invalid="true if errors.brand_color else false" :aria-describedby="'err-brand_color' if errors.brand_color else none" aria-required="true"></label></p>
    <p><label><r-t key="backoffice.settings.f.footer_en" /> <input name="brand_footer_en" maxlength="200" :value="f.brand_footer_en" id="f-brand_footer_en" :aria-invalid="true if errors.brand_footer_en else false" :aria-describedby="'err-brand_footer_en' if errors.brand_footer_en else none"></label></p>
    <p><label><r-t key="backoffice.settings.f.footer_ar" /> <input name="brand_footer_ar" maxlength="200" dir="rtl" :value="f.brand_footer_ar" id="f-brand_footer_ar" :aria-invalid="true if errors.brand_footer_ar else false" :aria-describedby="'err-brand_footer_ar' if errors.brand_footer_ar else none"></label></p>
    <p><label><r-t key="backoffice.settings.f.sender" /> <input name="sender_name" maxlength="80" :value="f.sender_name" id="f-sender_name" :aria-invalid="true if errors.sender_name else false" :aria-describedby="'err-sender_name' if errors.sender_name else none"></label> <small class="muted"><r-t key="backoffice.settings.sender_hint" /></small></p>
    <p><label><r-t key="backoffice.settings.f.accounts_email" /> <input name="accounts_email" type="email" dir="ltr" maxlength="254" :value="f.accounts_email" id="f-accounts_email" :aria-invalid="true if errors.accounts_email else false" :aria-describedby="'err-accounts_email' if errors.accounts_email else none"></label> <small class="muted"><r-t key="backoffice.settings.accounts_hint" /></small></p>
    <p><label><r-t key="backoffice.settings.f.logo" /> <input type="file" name="logo" accept="image/png,image/jpeg,image/webp" id="f-logo" :aria-invalid="true if errors.logo else false" :aria-describedby="'err-logo' if errors.logo else none"></label>
      <small class="muted"><r-t key="backoffice.settings.logo_limit" /></small>
      <img r-if="logo_src" id="current-logo" :src="logo_src" alt="" class="brand-logo"><small r-else><r-t key="backoffice.settings.logo_none" /></small></p>
    <section id="portal" aria-labelledby="portal-title">
      <h2 id="portal-title"><r-t key="backoffice.settings.portal.title" /></h2>
      <p class="muted"><r-t key="backoffice.settings.portal.hint" /></p>
      <input type="hidden" name="portal_section" value="1">
      <p><label><input type="checkbox" name="portal_auto_confirm" value="1" :checked="f.portal_auto_confirm" id="f-portal_auto_confirm"> <r-t key="backoffice.settings.portal.auto_confirm" /></label> <small class="muted"><r-t key="backoffice.settings.portal.auto_confirm_hint" /></small></p>
      <p><label><r-t key="backoffice.settings.portal.cutoff" /> <input type="number" name="portal_cutoff_hours" dir="ltr" inputmode="numeric" step="1" :min="cutoff.min" :max="cutoff.max" :value="f.portal_cutoff_hours" required id="f-portal_cutoff_hours" :aria-invalid="true if errors.portal_cutoff_hours else false" :aria-describedby="'err-portal_cutoff_hours' if errors.portal_cutoff_hours else none" aria-required="true"></label> <small class="muted"><r-t key="backoffice.settings.portal.cutoff_hint" /></small></p>
      <p><label><r-t key="backoffice.settings.portal.reschedules" /> <input type="number" name="portal_max_reschedules" dir="ltr" inputmode="numeric" step="1" :min="reschedules.min" :max="reschedules.max" :value="f.portal_max_reschedules" required id="f-portal_max_reschedules" :aria-invalid="true if errors.portal_max_reschedules else false" :aria-describedby="'err-portal_max_reschedules' if errors.portal_max_reschedules else none" aria-required="true"></label> <small class="muted"><r-t key="backoffice.settings.portal.reschedules_hint" /></small></p>
      <fieldset id="payment-instructions">
        <legend><r-t key="backoffice.settings.payment.title" /></legend>
        <p class="muted"><r-t key="backoffice.settings.payment.hint" /></p>
        <p><label><r-t key="backoffice.settings.payment.en" /> <textarea name="payment_instructions_en" maxlength="500" rows="4" id="f-payment_instructions_en" :aria-invalid="true if errors.payment_instructions_en else false" :aria-describedby="'err-payment_instructions_en' if errors.payment_instructions_en else none">{{ f.payment_instructions_en }}</textarea></label></p>
        <p><label><r-t key="backoffice.settings.payment.ar" /> <textarea name="payment_instructions_ar" maxlength="500" rows="4" dir="rtl" id="f-payment_instructions_ar" :aria-invalid="true if errors.payment_instructions_ar else false" :aria-describedby="'err-payment_instructions_ar' if errors.payment_instructions_ar else none">{{ f.payment_instructions_ar }}</textarea></label></p>
      </fieldset>
      <p><label><r-t key="backoffice.settings.portal.link" /> <input type="url" readonly dir="ltr" :value="book_link" id="book-link"></label> <small class="muted"><r-t key="backoffice.settings.portal.link_hint" /></small></p>
    </section>
    <p><button type="submit" class="btn-brand"><r-t key="backoffice.settings.save" /></button></p>
  </x-form>
</r-layout>
