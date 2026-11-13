<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="htmx-config" content='{"includeIndicatorStyles": false}'>
  <title><slot name="title">{{ brand.name ?? app_name }}</slot></title>
  <link rel="stylesheet" href="/renox-ui.css">
  <link r-if="locale == 'ar'" rel="preload" as="font" type="font/woff2" crossorigin :href="'/fonts/noto-sans-arabic-arabic-400-normal.woff2'">
  <link rel="stylesheet" href="/app.css">
  <link rel="stylesheet" href="/theme">
  <meta name="theme-color" content="{{ brand.color }}">
</head>
<body>
  <a class="skip" href="#main"><r-t key="app.skip" /></a>
  <header class="site-header">
    <a href="/my" class="brand-link"><img r-if="brand.logo" :src="brand.logo" alt="" class="brand-logo" width="32" height="32"><strong>{{ brand.name ?? app_name }}</strong></a>
    <span class="spacer"></span>
    <nav class="i18n-language" :aria-label="'app.lang.label' | t" r-if="i18n_links">
      <r-group r-for="l in i18n_links"><strong r-if="l.current" :lang="l.locale"><r-group r-if="l.locale == 'ar'"><r-t key="app.lang.ar" /></r-group><r-group r-else><r-t key="app.lang.en" /></r-group></strong><a r-else :href="l.href" :lang="l.locale"><r-group r-if="l.locale == 'ar'"><r-t key="app.lang.ar" /></r-group><r-group r-else><r-t key="app.lang.en" /></r-group></a></r-group>
    </nav>
    <x-form action="signout" class="inline"><button type="submit"><r-t key="portal.sign_out" /></button></x-form>
  </header>
  <main id="main" tabindex="-1">
    <x-form-errors :problems="problems" /><slot />
  </main>
  <footer><small>{{ brand.footer }}</small></footer>
</body>
</html>
