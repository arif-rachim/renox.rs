<r-props emirates="object" />
<p><label><r-t key="customers.f.site_label" /> <input name="label" maxlength="80" required></label></p>
<p><label><r-t key="customers.f.emirate" /> <select name="emirate" required>
  <option r-for="e in emirates" :value="e.code" :selected="e.code == 'AE-DU'">{{ e.name }}</option>
</select></label></p>
<p><label><r-t key="customers.f.area" /> <input name="area" maxlength="80" required></label></p>
<p><label><r-t key="customers.f.address" /> <input name="address" maxlength="300" required></label></p>
<p><label><r-t key="customers.f.makani" /> <input name="makani" dir="ltr" inputmode="numeric" maxlength="20"></label></p>
<p><label><r-t key="customers.f.lat" /> <input name="lat" dir="ltr" inputmode="decimal" maxlength="20"></label></p>
<p><label><r-t key="customers.f.lng" /> <input name="lng" dir="ltr" inputmode="decimal" maxlength="20"></label></p>
<p><label><r-t key="customers.f.notes" /> <textarea name="access_notes" maxlength="500"></textarea></label></p>
