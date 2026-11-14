<r-layout use="main">
  <r-group slot="title"><r-t key="visits.title" /> · {{ brand.name }}</r-group>
  <div class="touch">
  <meta name="hs-user" content="{{ user_id }}">
  <p id="offline-banner" class="warning" hidden role="status" :data-saved-at="saved_at"><r-t key="visits.offline" /> <bdi dir="ltr" id="offline-time"></bdi>.</p>
  <x-queue-status />
  <section id="needs-attention" class="attention" hidden aria-live="polite" aria-labelledby="needs-attention-title" :data-phone="office_phone" :data-title="'visits.attention.title' | t" :data-done-at="'visits.attention.done_at' | t" :data-later="'visits.attention.later' | t" :data-behind="'visits.attention.behind' | t" :data-discard="'visits.attention.discard' | t" :data-discard-confirm="'visits.attention.discard_confirm' | t" :data-discard-confirm-one="'visits.attention.discard_confirm_one' | t" :data-discard-yes="'visits.attention.discard_yes' | t" :data-discard-no="'visits.attention.discard_no' | t" :data-retry="'visits.attention.retry' | t" :data-call="'visits.attention.call' | t" :data-unknown-job="'visits.attention.unknown_job' | t" :data-what-checkin="'visits.attention.what_checkin' | t" :data-what-part="'visits.attention.what_part' | t" :data-what-notes="'visits.attention.what_notes' | t" :data-what-summary="'visits.attention.what_summary' | t" :data-what-signature="'visits.attention.what_signature' | t" :data-what-checkout="'visits.attention.what_checkout' | t" :data-what-photo-before="'visits.attention.what_photo_before' | t" :data-what-photo-after="'visits.attention.what_photo_after' | t" :data-reason-invalid="'visits.attention.reason_invalid' | t" :data-reason-other="'visits.attention.reason_other' | t" :data-reason-generic="'visits.attention.reason_generic' | t" :data-reason-invalid-record="'visits.attention.reason_invalid_record' | t" :data-reason-job-cancelled="'visits.conflict.job_cancelled' | t" :data-reason-job-reassigned="'visits.conflict.job_reassigned' | t" :data-reason-already-checked-out="'visits.conflict.already_checked_out' | t" :data-reason-not-checked-in="'visits.conflict.not_checked_in' | t" :data-reason-action-id-taken="'visits.conflict.action_id_taken' | t">
    <h2 id="needs-attention-title"><r-t key="visits.attention.title" /></h2>
    <div id="needs-attention-list"></div>
  </section>
  <h1><r-t key="visits.title" /></h1>
  <p class="muted"><r-t key="visits.today" /></p>
  <ul class="visit-list" r-if="visits">
    <li r-for="v in visits" :id="'visit-' ~ v.id" class="visit-item">
      <a :href="'/me/visits/' ~ v.id" data-prefetch dir="ltr">{{ v.number }}</a>
      <strong>{{ v.customer }}</strong>
      <span>{{ v.service }}</span>
      <small>{{ v.site }}</small>
      <small dir="ltr" r-if="v.time">{{ v.time }}</small>
      <span :class="'status status-' ~ v.status">{{ ('jobs.status.' ~ v.status) | t }}</span>
    </li>
  </ul>
  <p r-else id="no-visits"><r-t key="visits.none" /></p>
  <script src="/offline-queue-core.js" defer></script>
  <script src="/offline-queue.js" defer></script>
  </div>
</r-layout>
