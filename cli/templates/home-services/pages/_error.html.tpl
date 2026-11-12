<r-layout use="main">
  <h1><r-t key="app.err.500.title" :status="status" /></h1>
  <p><r-t key="app.err.500.body" /> <a href="/"><r-t key="app.err.home" /></a></p>
  <p><small><span dir="ltr">{{ code }}</span> · <r-t key="app.err.request" /> <span dir="ltr">{{ request_id }}</span></small></p>
</r-layout>
