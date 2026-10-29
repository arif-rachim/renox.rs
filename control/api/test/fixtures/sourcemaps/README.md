# Sourcemap fixture (#128)

A browser script built once with the real bundler and committed, so the
symbolication test does not depend on the bundler's output of the day:

```
bun build scripts/cart.ts --target browser --format esm --sourcemap=external --root . --outdir public
mkdir -p maps/public/scripts && mv public/scripts/cart.js.map maps/public/scripts/
```

(Bun 1.4.4.) The layout is what a deployment has:

| Path | What |
| --- | --- |
| `scripts/cart.ts` | The source. `boom` throws at line 13 |
| `public/scripts/cart.js` | The built file the browser runs, served at `/scripts/cart.js` |
| `maps/` | The tree of `.renox/sourcemaps/<hash>/`, which `renox deploy` tars, gzips and uploads with `PUT …/deployments/{hash}/sourcemaps`. The map is never under `public/` (`renox check` refuses that) |

`tests/client-errors.test.ts` uploads `maps/` that way, ingests an error
whose top frame is the `toFixed` call in `public/scripts/cart.js`, and
expects `getClientError` to return `scripts/cart.ts` line 13.
