<r-layout use="back-office">
  <r-group slot="title"><r-t key="backoffice.users.title" /> · {{ brand.name }}</r-group>
  <h1><r-t key="backoffice.users.title" /></h1>
  <p><r-t key="backoffice.users.branch" :branch="branch_name" /></p>
  <p class="notice" id="saved-invited" r-if="saved == 'invited'"><r-t key="backoffice.users.invited" /></p>
  <p class="notice" id="saved-role" r-if="saved == 'role'"><r-t key="backoffice.users.role_set" /></p>
  <p class="notice" id="saved-removed" r-if="saved == 'removed'"><r-t key="backoffice.users.removed" /></p>
  <table id="staff">
    <thead><tr><th><r-t key="backoffice.users.name" /></th><th><r-t key="backoffice.users.email" /></th><th><r-t key="backoffice.users.roles" /></th><th><r-t key="backoffice.users.twofa" /></th><th></th></tr></thead>
    <tbody>
      <tr r-for="s in staff" :id="'staff-' ~ s.user_id">
        <td>{{ s.name }}<small r-if="s.self"> (<r-t key="backoffice.users.you" />)</small></td>
        <td dir="ltr">{{ s.email }}</td>
        <td><r-group r-for="r in s.roles"><span class="role">{{ ('backoffice.users.role_names.' ~ r) | t }}</span> </r-group><small r-if="s.no_role"><r-t key="backoffice.users.no_role" /></small></td>
        <td><r-group r-if="s.twofa"><r-t key="backoffice.users.twofa_on" /></r-group><r-group r-else><r-t key="backoffice.users.twofa_off" /></r-group>
          <small r-if="s.needs_factor" class="problem"> <r-t key="backoffice.users.twofa_needed" /></small></td>
        <td r-can="user.manage">
          <x-form action="role" class="inline" r-if="!s.self"><input type="hidden" name="user_id" :value="s.user_id">
            <select name="role"><option r-for="r in roles" :value="r.value" :selected="r.value == s.role">{{ ('backoffice.users.role_names.' ~ r.value) | t }}</option></select>
            <button type="submit"><r-t key="backoffice.users.set_role" /></button></x-form>
          <x-form action="remove" class="inline" r-if="!s.self"><input type="hidden" name="user_id" :value="s.user_id"><button type="submit"><r-t key="backoffice.users.remove" /></button></x-form>
        </td>
      </tr>
      <tr r-empty="staff"><td colspan="5"><r-t key="backoffice.users.none" /></td></tr>
    </tbody>
  </table>
  <p><a href="/auth/account"><r-t key="backoffice.users.setup" /></a></p>
  <section r-can="user.manage">
    <h2><r-t key="backoffice.users.invite" /></h2>
    <x-form action="invite" class="stack narrow">
      <p><label><r-t key="backoffice.users.email" /> <input name="email" type="email" dir="ltr" maxlength="254" :value="values.email" required></label></p>
      <p><label><r-t key="backoffice.users.role" /> <select name="role"><option r-for="r in roles" :value="r.value" :selected="r.value == (values.role or 'technician')">{{ ('backoffice.users.role_names.' ~ r.value) | t }}</option></select></label></p>
      <p><button type="submit" class="btn-brand"><r-t key="backoffice.users.invite_submit" /></button></p>
    </x-form>
  </section>
  <section id="pending">
    <h2><r-t key="backoffice.users.pending" /></h2>
    <ul><li r-for="p in pending"><span dir="ltr">{{ p.email }}</span> · {{ ('backoffice.users.role_names.' ~ p.role) | t }} · <span dir="ltr">{{ p.sent }}</span></li>
      <li r-empty="pending"><r-t key="backoffice.users.pending_none" /></li></ul>
  </section>
</r-layout>
