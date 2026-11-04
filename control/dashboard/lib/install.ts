// The CLI install line every page shows (#447). npm has no package `renox`
// (D28), so `bunx renox` never works: the CLI is the signed binary of the
// `cli-v*` release, installed by its install.sh. On Windows it runs inside
// WSL 2 (docs/getting-started.md). The version moves with each CLI release;
// tests/copy.test.ts checks it equals cli/package.json.

export const CLI_VERSION = "0.1.1";
export const INSTALL_URL = `https://github.com/arif-rachim/renox.rs/releases/download/cli-v${CLI_VERSION}/install.sh`;
export const DOCS_URL = "https://renoxium.com/docs";
