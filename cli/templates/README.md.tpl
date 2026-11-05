# {{APP}}

A [Renoxium](https://renoxium.com) app.

## Run it

```sh
bun install       # the @renoxium/sdk types and helpers
renox dev         # http://localhost:8787, reloads on save
```

## Check and test

```sh
renox check       # config, routes, templates, SQL and secrets lint
renox test        # tests/*.test.ts on the local worker
```

## Deploy

```sh
renox login       # once: approve the sign-in in the dashboard
renox deploy      # prints the live URL, https://{{APP}}.renoxium.app
renox logs        # the app's log lines
```

## Layout

| Path | What it is |
| --- | --- |
| `functions/` | API routes: the file path is the URL, each exported method handles it |
| `pages/` | Server-rendered HTML pages (`index.html` is `/`) and their layouts |
| `tests/` | Tests run by `renox test` |
| `renox.toml` | The app's name, permissions (network hosts, secret names) and settings |

Documentation: https://renoxium.com/docs. Coding agents: see `AGENTS.md`.
