# Team board, step 07

The app of the Renoxium tutorial as it stands at the end of chapter 7: [authorization](https://renoxium.com/docs/tutorial-authorization).

Next: [chapter 8, realtime](https://renoxium.com/docs/tutorial-realtime).

## Run it

```sh
bun install       # the @renoxium/sdk types and helpers
renox dev         # http://localhost:8787, reloads on save
```

## Check and test

```sh
renox check       # types, config, routes, templates, SQL and secrets lint
renox test        # tests/*.test.ts on the local worker
```

## Deploy

```sh
renox login       # once: approve the sign-in in the dashboard
renox deploy      # prints the live URL
```

The whole tutorial: https://renoxium.com/docs/tutorial. Coding agents: see `AGENTS.md`.
