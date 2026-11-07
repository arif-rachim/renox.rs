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

## Before you install: Bun, and which tool

- **Bun is not installed for you.** This package has no dependencies, and npm does not act on its `engines` field, so `npm install -g @renoxium/cli` succeeds without Bun. Afterwards `renox` fails. On Windows the message is `'"bun"' is not recognized as an internal or external command`. Install Bun 1.4 or newer first, and check it with `bun --version`.
- **Install Bun and the CLI with the same tool:**

  | Bun was installed with | Install the CLI with |
  | --- | --- |
  | The official installer: `curl -fsSL https://bun.sh/install \| bash`; on Windows `powershell -c "irm bun.sh/install.ps1 \| iex"` | `bun add -g @renoxium/cli` |
  | `npm install -g bun` | `npm install -g @renoxium/cli` |

- **Do not use `bun add -g @renoxium/cli` with a Bun that npm installed.** It installs without an error, but `renox` does not run:
  - `~/.bun/bin`, where `bun add -g` puts `renox`, is not on `PATH`, because only the official installer adds it;
  - on Windows, the `renox.exe` launcher looks for `bun.exe` on `PATH` and stops with `error: bun is not installed in %PATH%`, because npm's Bun puts only a `bun.cmd` shim there.
- **To see which Bun you have:** run `where.exe bun` (Windows) or `which -a bun`.
  - A path in the Node.js folder is npm's Bun; remove it with `npm uninstall -g bun`.
  - `~/.bun/bin/bun` is the official one; remove it by deleting `~/.bun` and its `PATH` entry.
- **In an app:** run `bun install` once after `renox new`, and run the tests with `renox test`, not `bun test`.

`renox dev`, `renox test` and `renox migrate` need the `renox-worker` binary. The first of them downloads the pinned release into `~/.renox/bin` and checks its sha256 against the pin baked into the CLI. Set `RENOX_WORKER_PATH` to use a worker you built.

Installing the CLI, verifying a release, and the standalone binaries: [docs/12-developer-experience.md](https://github.com/arif-rachim/renox.rs/blob/main/docs/12-developer-experience.md), "Installing the CLI".
