<r-layout use="main">
  <r-group slot="title">{{ job.number }} · {{ brand.name }}</r-group>
  <div class="touch">
  <p><a href="/me"><r-t key="visits.back" /></a></p>
  <h1 dir="ltr">{{ job.number }}</h1>
  <p><span :class="'status status-' ~ job.status" id="job-status">{{ ('jobs.status.' ~ job.status) | t }}</span></p>
  <dl class="detail">
    <dt><r-t key="visits.f.customer" /></dt>
    <dd r-if="customer">{{ customer.name }} <a :href="'tel:' ~ customer.phone" dir="ltr">{{ customer.phone }}</a></dd>
    <dt><r-t key="visits.f.site" /></dt>
    <dd r-if="site">{{ site.label }} · {{ site.area }}, {{ site.address }}<br><small r-if="site.access_notes">{{ site.access_notes }}</small></dd>
    <dt><r-t key="visits.f.service" /></dt>
    <dd>{{ job.service }}</dd>
    <dt r-if="job.start"><r-t key="visits.f.when" /></dt>
    <dd r-if="job.start" dir="ltr">{{ job.start }}</dd>
  </dl>
  <p r-if="job.description">{{ job.description }}</p>

  <section id="checkin" r-if="can_checkin">
    <h2><r-t key="visits.checkin.title" /></h2>
    <p class="muted"><r-t key="visits.checkin.hint" /></p>
    <x-form action="checkin" class="stack narrow" id="checkin-form">
      <input type="hidden" name="lat" id="checkin-lat">
      <input type="hidden" name="lng" id="checkin-lng">
      <p><button type="submit" class="btn-brand btn-big"><r-t key="visits.checkin.submit" /></button></p>
    </x-form>
  </section>

  <section id="visit" r-if="visit">
    <p id="visit-times" dir="ltr">{{ visit.checkin }}<r-group r-if="visit.checkout"> → {{ visit.checkout }}</r-group></p>
    <p r-if="closed" id="visit-closed" class="muted"><r-t key="visits.closed" /></p>

    <section id="photos">
      <h2><r-t key="visits.photos.title" /></h2>
      <r-group r-for="ph in phases">
        <h3>{{ ('visits.photos.' ~ ph.phase) | t }}</h3>
        <r-group r-if="ph.phase == 'before'">
          <ul class="photos" r-if="before" :id="'photos-' ~ ph.phase">
            <li r-for="p in before"><x-image r-if="p.image" :src="p.image" width="160" :alt="p.caption or ('visits.photos.alt' | t)" class="thumb"></x-image><small r-else><r-t key="visits.photos.not_stored" /></small><small r-if="p.caption">{{ p.caption }}</small></li>
          </ul>
          <p r-else class="muted"><r-t key="visits.photos.none" /></p>
        </r-group>
        <r-group r-else>
          <ul class="photos" r-if="after" :id="'photos-' ~ ph.phase">
            <li r-for="p in after"><x-image r-if="p.image" :src="p.image" width="160" :alt="p.caption or ('visits.photos.alt' | t)" class="thumb"></x-image><small r-else><r-t key="visits.photos.not_stored" /></small><small r-if="p.caption">{{ p.caption }}</small></li>
          </ul>
          <p r-else class="muted"><r-t key="visits.photos.none" /></p>
        </r-group>
        <r-group r-if="open"><x-form action="photo" class="stack narrow" :id="'photo-form-' ~ ph.phase">
          <input type="hidden" name="phase" :value="ph.phase">
          <input type="hidden" name="key" :id="'photo-key-' ~ ph.phase">
          <p><label><r-t key="visits.photos.file" /> <input type="file" accept="image/jpeg,image/png,image/webp" capture="environment" :data-upload-action="'/me/visits/' ~ job.id ~ '?/photo_url'" data-key-field="key"> <span data-upload-status class="muted"></span></label></p>
          <p><label><r-t key="visits.photos.caption" /> <input name="caption" maxlength="200" :value="values.caption if values.phase == ph.phase else ''" :id="'f-caption' if values.phase == ph.phase else 'f-caption-' ~ ph.phase" :aria-invalid="'true' if values.phase == ph.phase and errors.caption else 'false'" :aria-describedby="'err-caption' if values.phase == ph.phase and errors.caption else ''"></label></p>
          <p><small class="muted"><r-t key="visits.photos.limit" /></small></p>
          <p><button type="submit"><r-t key="visits.photos.add" /></button></p>
        </x-form></r-group>
      </r-group>
    </section>

    <section id="parts">
      <h2><r-t key="visits.parts.title" /></h2>
      <table r-if="has_parts" class="parts-table">
    <caption class="visually-hidden"><r-t key="visits.parts.title" /></caption>
        <thead><tr><th scope="col"><r-t key="visits.parts.description" /></th><th scope="col"><r-t key="visits.parts.qty" /></th><th scope="col"><r-t key="visits.parts.total" /></th><th scope="col"><span class="visually-hidden"><r-t key="app.actions" /></span></th></tr></thead>
        <tbody>
          <tr r-for="p in parts" :id="'part-' ~ p.id">
            <td>{{ p.description }}</td><td dir="ltr">{{ p.qty }}</td><td dir="ltr">{{ p.total }}</td>
            <td><r-group r-if="open"><x-form action="removePart" class="inline"><input type="hidden" name="part" :value="p.id"><button type="submit"><r-t key="visits.parts.remove" /></button></x-form></r-group></td>
          </tr>
        </tbody>
        <tfoot><tr><th scope="row" colspan="2"><r-t key="visits.parts.total" /></th><td dir="ltr" id="parts-total">{{ parts_total }}</td><th scope="row"><span class="visually-hidden"><r-t key="app.actions" /></span></th></tr></tfoot>
      </table>
      <p r-else class="muted"><r-t key="visits.parts.none" /></p>
      <r-group r-if="open"><x-form action="part" class="stack narrow" id="part-form">
        <p><label><r-t key="visits.parts.description" /> <input name="description" maxlength="200" :value="values.description" required id="f-description" :aria-invalid="'true' if errors.description else 'false'" :aria-describedby="'err-description' if errors.description else ''" aria-required="true"></label></p>
        <p><label><r-t key="visits.parts.qty" /> <input name="qty" :value="values.qty if values.qty is defined else '1'" inputmode="decimal" dir="ltr" required id="f-qty" :aria-invalid="'true' if errors.qty else 'false'" :aria-describedby="'err-qty' if errors.qty else ''" aria-required="true"></label></p>
        <p><label><r-t key="visits.parts.price" /> <input name="price" :value="values.price if values.price is defined else '0'" inputmode="decimal" dir="ltr" required id="f-price" :aria-invalid="'true' if errors.price else 'false'" :aria-describedby="'err-price' if errors.price else ''" aria-required="true"></label></p>
        <p><button type="submit"><r-t key="visits.parts.add" /></button></p>
      </x-form></r-group>
    </section>

    <section id="notes">
      <h2><r-t key="visits.notes.title" /></h2>
      <r-group r-if="open"><x-form action="notes" class="stack narrow">
        <p><label class="visually-hidden" for="f-notes"><r-t key="visits.notes.title" /></label><textarea name="notes" rows="4" maxlength="2000" dir="auto" id="f-notes" :aria-invalid="'true' if errors.notes else 'false'" :aria-describedby="'err-notes' if errors.notes else ''">{{ values.notes if values.notes is defined else visit.notes }}</textarea></p>
        <p><button type="submit"><r-t key="visits.notes.save" /></button></p>
      </x-form></r-group>
      <p r-else dir="auto" id="notes-text">{{ visit.notes }}</p>
    </section>

    <section id="signature">
      <h2><r-t key="visits.signature.title" /></h2>
      <p r-if="visit.signature"><x-image :src="visit.signature" width="240" :alt="'visits.signature.title' | t" class="signature-image"></x-image></p>
      <p r-if="visit.signed_by" id="signed-by"><r-t key="visits.signature.saved" :name="visit.signed_by" /></p>
      <p r-else class="muted"><r-t key="visits.signature.none" /></p>
      <r-group r-if="open"><x-form action="signature" class="stack narrow" id="signature-form">
        <p><label><r-t key="visits.signature.name" /> <input name="signed_by" maxlength="120" dir="auto" :value="values.signed_by" required id="f-signed_by" :aria-invalid="'true' if errors.signed_by else 'false'" :aria-describedby="'err-signed_by' if errors.signed_by else ''" aria-required="true"></label></p>
        <p class="muted"><r-t key="visits.signature.draw" /></p>
        <canvas id="sig-canvas" class="sig-canvas" role="img" :aria-label="'visits.signature.draw' | t" width="320" height="160"></canvas>
        <p><label><input type="checkbox" id="sig-typed"> <r-t key="visits.signature.typed" /></label> <small class="muted"><r-t key="visits.signature.typed_hint" /></small></p>
        <input type="hidden" name="signature" id="sig-data">
        <p><button type="button" id="sig-clear"><r-t key="visits.signature.clear" /></button> <button type="submit"><r-t key="visits.signature.save" /></button></p>
      </x-form></r-group>
    </section>

    <section id="summary">
      <h2><r-t key="visits.summary.title" /></h2>
      <p class="muted"><r-t key="visits.summary.hint" /></p>
      <x-form action="summary" class="stack narrow">
        <p><label><r-t key="visits.summary.en" /> <textarea name="summary_en" rows="3" maxlength="400" dir="ltr" id="f-summary_en" :aria-invalid="'true' if errors.summary_en else 'false'" :aria-describedby="'err-summary_en' if errors.summary_en else ''">{{ values.summary_en if values.summary_en is defined else visit.summary_en }}</textarea></label></p>
        <p><label><r-t key="visits.summary.ar" /> <textarea name="summary_ar" rows="3" maxlength="400" dir="rtl" id="f-summary_ar" :aria-invalid="'true' if errors.summary_ar else 'false'" :aria-describedby="'err-summary_ar' if errors.summary_ar else ''">{{ values.summary_ar if values.summary_ar is defined else visit.summary_ar }}</textarea></label></p>
        <p><button type="submit"><r-t key="visits.summary.save" /></button></p>
      </x-form>
    </section>

    <section id="checkout" r-if="open">
      <h2><r-t key="visits.checkout.title" /></h2>
      <p class="muted"><r-t key="visits.checkout.hint" /></p>
      <x-form action="checkout" class="stack narrow" id="checkout-form">
        <p><button type="submit" class="btn-brand btn-big"><r-t key="visits.checkout.submit" /></button></p>
      </x-form>
    </section>

    <section id="report" r-if="report">
      <h2><r-t key="visits.report.title" /></h2>
      <p class="work-links"><a :href="'/visits/' ~ visit.id ~ '/report?lang=en'"><r-t key="visits.report.en" /></a> <a :href="'/visits/' ~ visit.id ~ '/report?lang=ar'"><r-t key="visits.report.ar" /></a></p>
    </section>
  </section>

  <script src="/upload.js" defer></script>
  <script>
    (() => {
      // The browser's position at check-in, when it is shared: two hidden fields, optional.
      const lat = document.getElementById("checkin-lat");
      const lng = document.getElementById("checkin-lng");
      if (lat && lng && navigator.geolocation) {
        navigator.geolocation.getCurrentPosition((p) => {
          lat.value = String(p.coords.latitude);
          lng.value = String(p.coords.longitude);
        }, () => {}, { timeout: 8000, maximumAge: 60000 });
      }
      // The signature: drawn on a canvas, posted as a PNG data URL kept in a hidden field after every stroke.
      const canvas = document.getElementById("sig-canvas");
      const data = document.getElementById("sig-data");
      if (!canvas || !data) return;
      const g = canvas.getContext("2d");
      g.lineWidth = 2.5;
      g.lineCap = "round";
      g.strokeStyle = "#111";
      let drawing = false;
      const at = (e) => {
        const r = canvas.getBoundingClientRect();
        return [(e.clientX - r.left) * (canvas.width / r.width), (e.clientY - r.top) * (canvas.height / r.height)];
      };
      canvas.addEventListener("pointerdown", (e) => {
        drawing = true;
        canvas.setPointerCapture(e.pointerId);
        const [x, y] = at(e);
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x + 0.1, y + 0.1);
        g.stroke();
        e.preventDefault();
      });
      canvas.addEventListener("pointermove", (e) => {
        if (!drawing) return;
        const [x, y] = at(e);
        g.lineTo(x, y);
        g.stroke();
        e.preventDefault();
      });
      const end = () => {
        if (!drawing) return;
        drawing = false;
        data.value = canvas.toDataURL("image/png");
      };
      canvas.addEventListener("pointerup", end);
      canvas.addEventListener("pointercancel", end);
      // Without a pointer (keyboard, screen reader): "Type the customer's name
      // instead" writes the typed name onto the canvas as the signature image
      // when the form is sent, so the same signature step is satisfied.
      const typed = document.getElementById("sig-typed");
      const form = document.getElementById("signature-form");
      const nameField = form ? form.querySelector('[name="signed_by"]') : null;
      document.addEventListener("submit", (e) => {
        if (e.target !== form || !typed || !typed.checked || !nameField || nameField.value.trim() === "") return;
        g.clearRect(0, 0, canvas.width, canvas.height);
        g.fillStyle = "#111";
        g.font = 'italic 44px "Segoe Script", "Brush Script MT", cursive, serif';
        g.textBaseline = "middle";
        g.fillText(nameField.value.trim(), 16, canvas.height / 2, canvas.width - 32);
        data.value = canvas.toDataURL("image/png");
      }, true);
      document.getElementById("sig-clear")?.addEventListener("click", () => {
        g.clearRect(0, 0, canvas.width, canvas.height);
        data.value = "";
      });
    })();
  </script>
  </div>
</r-layout>
