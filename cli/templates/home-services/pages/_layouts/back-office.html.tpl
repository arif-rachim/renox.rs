<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="htmx-config" content='{"includeIndicatorStyles": false}'>
  <title><slot name="title">{{ brand.name }}</slot></title>
  <link rel="stylesheet" href="/renox-ui.css">
  <link rel="stylesheet" href="/app.css">
  <link rel="stylesheet" href="/theme">
</head>
<body>
  <a class="skip" href="#main"><r-t key="app.skip" /></a>
  <header class="site-header">
    <a href="/" class="brand-link"><img r-if="brand.logo" :src="brand.logo" alt="" class="brand-logo"><strong>{{ brand.name }}</strong></a>
    <span class="spacer"></span>
    <r-slot name="app.header" />
    <nav class="i18n-language" :aria-label="'app.lang.label' | t" r-if="i18n_links">
      <r-group r-for="l in i18n_links"><strong r-if="l.current" :lang="l.locale"><r-group r-if="l.locale == 'ar'"><r-t key="app.lang.ar" /></r-group><r-group r-else><r-t key="app.lang.en" /></r-group></strong><a r-else :href="l.href" :lang="l.locale"><r-group r-if="l.locale == 'ar'"><r-t key="app.lang.ar" /></r-group><r-group r-else><r-t key="app.lang.en" /></r-group></a></r-group>
    </nav>
  </header>
  <div class="backoffice">
    <nav class="backoffice-nav" :aria-label="'backoffice.nav.label' | t">
      <a href="/admin"><r-t key="backoffice.nav.dashboard" /></a>
      <a href="/admin/settings"><r-t key="backoffice.nav.settings" /></a>
      <a href="/admin/branches"><r-t key="backoffice.nav.branches" /></a>
      <a href="/admin/import"><r-t key="backoffice.nav.import" /></a>
      <a href="/admin/people"><r-t key="backoffice.nav.users" /></a>
      <a href="/admin/audit"><r-t key="backoffice.nav.audit" /></a>
      <a href="/"><r-t key="backoffice.open_work" /></a>
    </nav>
    <main id="main" tabindex="-1">
      <x-form-errors :problems="problems" /><slot />
    </main>
  </div>
  <footer><small>{{ brand.footer }}</small></footer>
</body>
</html>
