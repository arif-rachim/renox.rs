<r-layout use="main">
  <r-group slot="title"><r-t key="jobs.title" /> · {{ brand.name }}</r-group>
  <h1><r-group r-if="all"><r-t key="jobs.title" /></r-group><r-group r-else><r-t key="jobs.mine" /></r-group></h1>
  <form class="search" action="/jobs" method="get">
    <label><r-t key="jobs.f.status" />
      <select name="status">
        <option value="">—</option>
        <option r-for="s in statuses" :value="s.value" :selected="s.current">{{ ('jobs.status.' ~ s.value) | t }}</option>
      </select></label>
    <label r-if="all"><r-t key="jobs.f.technician" />
      <select name="technician">
        <option value="">—</option>
        <option r-for="t in technicians" :value="t.id" :selected="t.current">{{ t.name }}</option>
      </select></label>
    <label><r-t key="jobs.f.day" /> <input type="date" name="day" :value="day" dir="ltr"></label>
    <button type="submit"><r-t key="jobs.filter" /></button>
    <a class="btn-brand" href="/jobs/new" r-can="job.write"><r-t key="jobs.new" /></a>
    <a href="/dispatch" r-can="job.dispatch"><r-t key="jobs.board" /></a>
  </form>
  <table id="job-list">
    <caption class="visually-hidden"><r-t key="jobs.title" /></caption>
    <thead>
      <tr><th scope="col"><r-t key="jobs.f.number" /></th><th scope="col"><r-t key="jobs.f.customer" /></th><th scope="col"><r-t key="jobs.f.service" /></th><th scope="col"><r-t key="jobs.f.status" /></th><th scope="col"><r-t key="jobs.f.technician" /></th><th scope="col"><r-t key="jobs.f.when" /></th></tr>
    </thead>
    <tbody>
      <tr r-for="j in jobs" :id="'job-' ~ j.id">
        <td dir="ltr"><a :href="'/jobs/' ~ j.id">{{ j.number }}</a></td>
        <td>{{ j.customer }}</td>
        <td>{{ j.service }}</td>
        <td><span :class="'status status-' ~ j.status">{{ ('jobs.status.' ~ j.status) | t }}</span></td>
        <td>{{ j.technician }}</td>
        <td dir="ltr">{{ j.start }}<r-group r-if="!j.start"><r-t key="jobs.unscheduled" /></r-group></td>
      </tr>
      <tr r-empty="jobs"><td colspan="6"><r-t key="jobs.none" /></td></tr>
    </tbody>
  </table>
</r-layout>
