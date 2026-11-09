<r-layout use="main">
  <r-group slot="title"><r-t key="visits.title" /> · {{ brand.name }}</r-group>
  <h1><r-t key="visits.title" /></h1>
  <p class="muted"><r-t key="visits.today" /></p>
  <ul class="visit-list" r-if="visits">
    <li r-for="v in visits" :id="'visit-' ~ v.id" class="visit-item">
      <a :href="'/me/visits/' ~ v.id" dir="ltr">{{ v.number }}</a>
      <strong>{{ v.customer }}</strong>
      <span>{{ v.service }}</span>
      <small>{{ v.site }}</small>
      <small dir="ltr" r-if="v.time">{{ v.time }}</small>
      <span :class="'status status-' ~ v.status">{{ ('jobs.status.' ~ v.status) | t }}</span>
    </li>
  </ul>
  <p r-else id="no-visits"><r-t key="visits.none" /></p>
</r-layout>
