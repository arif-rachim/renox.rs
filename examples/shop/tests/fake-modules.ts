// `renox:modules` for the shop's unit tests (handlers called with a fake
// ctx, no worker): the runtime's loader resolves it in production (ops.md
// 1.3.0 section 15). auth.currentUser answers `globalThis.__shopTestUser`,
// org.currentOrg `globalThis.__shopTestOrg`; storage.upload records into
// `globalThis.__shopTestUploads` and answers the platform's dimensions of
// the shop's 400 × 400 PNGs (#332).
//
// Only importers under examples/shop get the fake (#356): the suite run from
// the repository root is one process, and a global `renox:modules` would
// reach every test file loaded after the shop's.
import { plugin } from "bun";
import { join } from "node:path";

const SHOP = join(import.meta.dir, "..") + "/";

plugin({
  name: "renox-modules-fake",
  setup(build) {
    build.onResolve({ filter: /^modules$/u, namespace: "renox" }, (args) =>
      args.importer.startsWith(SHOP) ? { path: "modules", namespace: "renox-modules-fake" } : undefined,
    );
    build.onLoad({ filter: /.*/u, namespace: "renox-modules-fake" }, () => ({
      loader: "object",
      exports: {
        auth: {
          currentUser: async () => (globalThis as { __shopTestUser?: unknown }).__shopTestUser ?? null,
        },
        org: {
          currentOrg: async () => (globalThis as { __shopTestOrg?: unknown }).__shopTestOrg ?? null,
          switcher: async () => null,
        },
        storage: {
          upload: async (owner: string, name: string, bytes: Uint8Array, contentType: string, opts?: { public?: boolean }) => {
            const g = globalThis as { __shopTestUploads?: unknown[] };
            (g.__shopTestUploads ??= []).push({ owner, name, bytes: bytes.length, contentType, public: opts?.public === true });
            return { key: `storage/${owner}/${name}`, width: 400, height: 400 };
          },
        },
        i18n: {
          detectLocale: async () => ({ locale: "en", dir: "ltr", digits: "latin", source: "default", alternates: [] }),
        },
      },
    }));
  },
});
