// `renox:modules` for the shop's unit tests (handlers called with a fake
// ctx, no worker): the runtime's loader resolves it in production (ops.md
// 1.3.0 section 15). auth.currentUser answers `globalThis.__shopTestUser`,
// org.currentOrg `globalThis.__shopTestOrg`.
import { plugin } from "bun";

plugin({
  name: "renox-modules-fake",
  setup(build) {
    build.module("renox:modules", () => ({
      loader: "object",
      exports: {
        auth: {
          currentUser: async () => (globalThis as { __shopTestUser?: unknown }).__shopTestUser ?? null,
        },
        org: {
          currentOrg: async () => (globalThis as { __shopTestOrg?: unknown }).__shopTestOrg ?? null,
          switcher: async () => null,
        },
        i18n: {
          detectLocale: async () => ({ locale: "en", dir: "ltr", digits: "latin", source: "default", alternates: [] }),
        },
      },
    }));
  },
});
