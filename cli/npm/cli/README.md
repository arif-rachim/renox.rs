# @renoxium/cli

The `renox` CLI for [Renoxium](https://github.com/arif-rachim/renox.rs): create, run, test, check, build and deploy a TypeScript app. The package is one bundled JavaScript file that runs on Bun. It requires Bun 1.4 or newer.

```sh
bun add -g @renoxium/cli                 # then: renox --version
bunx @renoxium/cli new myapp             # no install
npm install -g @renoxium/cli             # Bun must be on PATH
bun create renox myapp                   # the create-renox package
bun add -g @renoxium/cli@latest          # upgrade
```

Keep the `-g`: `bun add @renoxium/cli` without it installs the CLI in the current project only (run it there as `bunx renox`).

`renox dev`, `renox test` and `renox migrate` need the `renox-worker` binary. The first of them downloads the pinned release into `~/.renox/bin` and checks its sha256 against the pin baked into the CLI. Set `RENOX_WORKER_PATH` to use a worker you built.

Installing the CLI, verifying a release, and the standalone binaries: [docs/12-developer-experience.md](https://github.com/arif-rachim/renox.rs/blob/main/docs/12-developer-experience.md), "Installing the CLI".
