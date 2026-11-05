# Chapter 2: The dev loop

**What you build:** a stylesheet and a header for the board. On the way you learn what `renox dev` does when you save, and where errors show up, from the server and from the browser.

## Save, and the browser follows

Keep `renox dev` running in one terminal. Each time you save, it rebuilds the app, starts a fresh isolate on the same worker (your database stays open) and reloads the open pages. One edited file usually appears in the browser within a second.

Add a stylesheet. Files under `public/` are served as they are, outside your app's isolate and its CPU quota:

`public/app.css`:
```css
:root { color-scheme: light dark; font-family: system-ui, sans-serif; line-height: 1.5; }
body { margin: 0 auto; max-width: 40rem; padding: 0 1rem 3rem; }
header { display: flex; gap: 1rem; align-items: center; flex-wrap: wrap; padding-block: 1rem; border-block-end: 1px solid #8884; }
a { color: inherit; }
```

Link it from the layout, and add a header:

`pages/_layouts/main.html`:
```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title><slot name="title">Team board</slot></title>
  <link rel="stylesheet" href="/app.css">
</head>
<body>
  <header>
    <a href="/"><strong>Team board</strong></a>
  </header>
  <main>
    <slot />
  </main>
</body>
</html>
```

Save, and the page restyles itself. In the page source the link reads `/app.<hash>.css`, not `/app.css`. `renox build` adds a copy of the file named after its content and points the template at it, so browsers and Cloudflare can cache it until the file changes ([App model, static files](../07-app-model.md#static-files-public)).

## The error overlay

Break something on purpose. In `functions/api/health.ts`, delete the `)` before the last `;` and save. The build fails, the terminal prints the error, and the browser shows it over the page with the file, line, column and a hint.

[What you should see: the overlay with `Expected ")" but found ";"`](screenshots/02-overlay.png).

Put the `)` back and save: the overlay goes and the page reloads. A runtime error in a loader or an action works the same way: the terminal prints it with the original TypeScript line (source maps are in the bundle), and the page shows the error page with the request id.

## Browser errors in the terminal

Every page loads the platform's small client script, `/__renox/client.js`. It reports what goes wrong in the browser: a JavaScript exception, an htmx request that failed or found no target, a script the content security policy blocked. Under `renox dev` each report is printed next to the server's lines:

```
[browser] js.error pages/index.html:12:7 TypeError: tasks is undefined (01JBQ3Z7MA…)
```

The id at the end is the request id of the page. The overlay's **Browser** tab lists the same events, and next to them the server log of that request. You will use this from chapter 5, when htmx starts swapping fragments.

## Check before you commit

`renox check` runs what `renox deploy` runs first: the TypeScript type check, `renox.toml`, routes, templates, the SQL lint, secrets in the bundle and the other rules:

```sh
renox check
```

```
renox check: ok
```

## If it does not work

| You see | Why, and what to do |
| --- | --- |
| The page does not reload after a save | The page was opened before `renox dev` started, or from another port. Reload it once by hand |
| The stylesheet is not applied | The link must be a literal `href="/app.css"` for the hashed copy; check the file is under `public/`, not `pages/` |
| `renox check` prints `types not checked: add typescript` | Run `bun install` in the app folder; `package.json` lists `typescript` |
| A blocked inline `<script>` (a `securitypolicyviolation` event) | Pages send a strict content security policy. Put scripts in `public/` and link them, as chapter 8 does |

## Building with an AI agent

With `renox dev` running, an agent reads the same errors through the MCP tool `dev_errors` (server errors and `browserErrors`) and the app's state through `dev_status`. Ask it to "fix the error renox dev shows" and it reads them rather than guessing.

**Checkpoint:** [`examples/tutorial/step-02`](../../examples/tutorial/step-02/). Next: [pages and templates](03-pages.md).
