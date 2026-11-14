<r-layout use="back-office">
  <r-group slot="title">{{ po.number }} · {{ brand.name }}</r-group>
  <p><a href="/admin/purchasing"><r-t key="purchasing.back" /></a></p>
  <h1 dir="ltr">{{ po.number }}</h1>
  <p><span :class="'status status-' ~ po.status" id="po-status">{{ ('purchasing.status.' ~ po.status) | t }}</span></p>
  <p class="notice" id="saved" r-if="saved">{{ ('purchasing.saved.' ~ saved) | t }}</p>
  <p class="notice" id="send-note" r-if="po.status == 'sent' and saved == 'sent'"><r-t key="purchasing.send_note" /></p>
  <dl class="detail">
    <dt><r-t key="purchasing.f.supplier" /></dt>
    <dd><span r-if="supplier">{{ supplier.name }}<br><span r-if="supplier.trn">TRN: <bdi dir="ltr">{{ supplier.trn }}</bdi><br></span><bdi dir="ltr" r-if="supplier.email">{{ supplier.email }}</bdi></span></dd>
    <dt><r-t key="purchasing.f.branch" /></dt>
    <dd>{{ branch_name }}</dd>
    <dt><r-t key="purchasing.f.language" /></dt>
    <dd>{{ 'العربية' if po.language == 'ar' else 'English' }}</dd>
    <dt><r-t key="purchasing.f.created" /></dt>
    <dd dir="ltr">{{ po.created_at }}</dd>
    <dt r-if="po.expected_on"><r-t key="purchasing.f.expected_on" /></dt>
    <dd r-if="po.expected_on" dir="ltr">{{ po.expected_on }}</dd>
    <dt r-if="po.sent_at"><r-t key="purchasing.f.sent_at" /></dt>
    <dd r-if="po.sent_at" dir="ltr">{{ po.sent_at }}</dd>
    <dt r-if="po.closed_at"><r-t key="purchasing.f.closed_at" /></dt>
    <dd r-if="po.closed_at" dir="ltr">{{ po.closed_at }}</dd>
  </dl>
  <p r-if="po.notes"><strong><r-t key="purchasing.f.notes" />:</strong> {{ po.notes }}</p>
  <div class="table-scroll" tabindex="0"><table id="lines">
    <caption class="visually-hidden"><r-t key="purchasing.lines" /></caption>
    <thead><tr><th scope="col"><r-t key="purchasing.f.sku" /></th><th scope="col"><r-t key="purchasing.f.part" /></th><th scope="col"><r-t key="purchasing.f.qty" /></th><th scope="col"><r-t key="purchasing.f.unit_cost" /></th><th scope="col"><r-t key="purchasing.f.net" /></th><th scope="col"><r-t key="purchasing.f.vat" /></th><th scope="col"><r-t key="purchasing.f.total" /></th><th scope="col"><r-t key="purchasing.f.received" /></th><th scope="col" r-if="is_draft"><span class="visually-hidden"><r-t key="purchasing.f.actions" /></span></th></tr></thead>
    <tbody>
      <tr r-for="l in lines" :id="'line-' ~ l.id">
        <td dir="ltr">{{ l.sku }}</td>
        <td>{{ l.name }}</td>
        <td dir="ltr">{{ l.qty }} <small>{{ ('parts.unit.' ~ l.unit) | t }}</small></td>
        <td dir="ltr">{{ l.unit_cost | money }}</td>
        <td dir="ltr">{{ l.net | money }}</td>
        <td dir="ltr">{{ l.vat | money }} <bdi dir="ltr">({{ l.vat_rate }}%)</bdi></td>
        <td dir="ltr">{{ l.total | money }}</td>
        <td dir="ltr">{{ l.received }}</td>
        <td r-if="is_draft" r-can="purchase.write">
          <x-form action="remove_line" class="inline">
            <input type="hidden" name="line" :value="l.id">
            <button type="submit" :id="'remove-' ~ l.id"><r-t key="purchasing.remove" /></button>
          </x-form>
        </td>
      </tr>
      <tr r-empty="lines"><td colspan="9"><r-t key="purchasing.no_lines" /></td></tr>
    </tbody>
    <tfoot>
      <tr><th scope="row" colspan="6"><r-t key="purchasing.f.net" /></th><td dir="ltr" id="net">{{ po.net | money }}</td></tr>
      <tr><th scope="row" colspan="6"><r-t key="purchasing.f.vat" /></th><td dir="ltr" id="vat">{{ po.vat | money }}</td></tr>
      <tr><th scope="row" colspan="6"><r-t key="purchasing.f.total" /></th><td dir="ltr" id="total"><strong>{{ po.total | money }}</strong></td></tr>
    </tfoot>
  </table></div>
  <p id="pdf-links"><r-t key="purchasing.pdf" />: <a id="pdf-en" :href="'/admin/purchasing/' ~ po.id ~ '/pdf?lang=en'" lang="en">English</a> · <a id="pdf-ar" :href="'/admin/purchasing/' ~ po.id ~ '/pdf?lang=ar'" lang="ar">العربية</a></p>

  <section r-can="purchase.write" r-if="is_draft" id="line-form">
    <h2><r-t key="purchasing.add_line" /></h2>
    <x-form action="add_line" class="stack narrow" id="add-line-form">
      <p><label><r-t key="purchasing.f.part" /> <select name="part" id="f-line-part" required aria-required="true" :aria-invalid="true if values.form == 'line' and errors.part else false" :aria-describedby="'err-part' if values.form == 'line' and errors.part else none"><option value=""></option><option r-for="p in parts" :value="p.id" :selected="values.form == 'line' and values.part == p.id">{{ p.label }} ({{ p.cost }})</option></select></label></p>
      <p><label><r-t key="purchasing.f.qty" /> <input name="qty" dir="ltr" inputmode="decimal" size="10" required aria-required="true" id="f-line-qty" :value="values.qty if values.form == 'line' else ''" :aria-invalid="true if values.form == 'line' and errors.qty else false" :aria-describedby="'err-qty' if values.form == 'line' and errors.qty else none"></label></p>
      <p><label><r-t key="purchasing.f.unit_cost" /> <input name="unit_cost" dir="ltr" inputmode="decimal" size="10" id="f-line-unit_cost" :value="values.unit_cost if values.form == 'line' else ''" :aria-invalid="true if values.form == 'line' and errors.unit_cost else false" :aria-describedby="'err-unit_cost' if values.form == 'line' and errors.unit_cost else none"></label> <small class="muted"><r-t key="purchasing.cost_hint" /></small></p>
      <p><button type="submit" class="btn-brand" id="add-line"><r-t key="purchasing.add_line_submit" /></button></p>
    </x-form>
  </section>

  <section r-can="purchase.write" r-if="can_receive" id="receive-section">
    <h2><r-t key="purchasing.receive.title" /></h2>
    <p><small class="muted"><r-t key="purchasing.receive.note" /></small></p>
    <x-form action="receive" class="stack" id="receive-form">
      <div class="table-scroll" tabindex="0"><table id="receive-lines">
        <caption class="visually-hidden"><r-t key="purchasing.receive.title" /></caption>
        <thead><tr><th scope="col"><r-t key="purchasing.f.sku" /></th><th scope="col"><r-t key="purchasing.f.outstanding" /></th><th scope="col"><r-t key="purchasing.f.received_now" /></th><th scope="col"><r-t key="purchasing.f.paid_cost" /></th></tr></thead>
        <tbody>
          <tr r-for="l in receive_lines" :id="'receive-' ~ l.id">
            <td dir="ltr">{{ l.sku }}</td>
            <td dir="ltr">{{ l.outstanding }}</td>
            <td><input :name="'qty_' ~ l.i" dir="ltr" inputmode="decimal" size="8" :id="'f-receive-qty_' ~ l.i" :value="l.rq" :aria-label="'purchasing.f.received_now' | t" :aria-invalid="true if l.err_qty else false" :aria-describedby="('err-qty_' ~ l.i) if l.err_qty else none"></td>
            <td><input :name="'price_' ~ l.i" dir="ltr" inputmode="decimal" size="8" :id="'f-receive-price_' ~ l.i" :value="l.rp" :aria-label="'purchasing.f.paid_cost' | t" :aria-invalid="true if l.err_price else false" :aria-describedby="('err-price_' ~ l.i) if l.err_price else none"></td>
          </tr>
        </tbody>
      </table></div>
      <p><button type="submit" class="btn-brand" id="receive-submit"><r-t key="purchasing.receive.submit" /></button></p>
    </x-form>
  </section>

  <section r-can="purchase.write" id="po-actions">
    <x-form action="send" class="inline" r-if="is_draft">
      <button type="submit" class="btn-brand" id="send-po"><r-t key="purchasing.send" /></button>
    </x-form>
    <x-form action="cancel" class="inline" r-if="can_cancel">
      <button type="submit" id="cancel-po"><r-t key="purchasing.cancel" /></button>
    </x-form>
  </section>
</r-layout>
