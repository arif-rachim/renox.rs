<r-layout use="main">
  <r-group slot="title"><r-t key="visits.signout.title" /> · {{ brand.name }}</r-group>
  <div class="touch">
  <x-queue-status />
  <h1><r-t key="visits.signout.title" /></h1>
  <p id="signout-text" aria-live="polite" :data-waiting="'visits.signout.waiting' | t" :data-waiting-one="'visits.signout.waiting_one' | t" :data-none="'visits.signout.none' | t"></p>
  <p class="muted"><r-t key="visits.signout.hint" /></p>
  <form method="post" action="/auth/account?/logout" class="stack narrow"><x-csrf /><p><button type="submit"><r-t key="visits.signout.yes" /></button></p></form>
  <p><a href="/me" id="signout-stay"><r-t key="visits.signout.no" /></a></p>
  <script src="/offline-queue-core.js" defer></script>
  <script src="/offline-queue.js" defer></script>
  </div>
</r-layout>
