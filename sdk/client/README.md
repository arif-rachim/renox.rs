# renox-client.js

The platform's browser script (#127): client error reporting, the htmx error hooks, and the dev overlay hooks. The source is `src/`. The gateway serves the build, which is committed as `crates/renox-gateway/assets/renox-client.js` so that a Rust build needs no Bun.

## Rebuilding

```sh
bun sdk/client/build.ts
```

This writes `sdk/client/dist/renox-client.js` (a minified IIFE) and its external source map, which is never served. It then copies the script to `crates/renox-gateway/assets/renox-client.js` and checks the 4 KB gzipped limit. Commit the asset together with the source change.

`sdk/client/tests/build.test.ts` fails when the committed asset differs from a fresh build of `src/`, so a source change without a rebuild is caught.

## The debug id

The last line of the script is `//# debugId=<32 hex digits>`, and the source map carries the same `debugId`. The id is the first 128 bits of the SHA-256 of the script without that line (`debugIdOf` in `build.ts`). It depends only on the script's bytes, and so on the source and the Bun version, never on the output directory or the machine. Bun's own id also depends on the output path, so a build in a temporary directory did not match the committed asset (#268).
