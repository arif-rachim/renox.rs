# Team board, step 10

The app of the Renoxium tutorial as it stands at the end of chapter 10: [deploy and a custom domain](https://renoxium.com/docs/tutorial-deploy).

This is the finished app.

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
