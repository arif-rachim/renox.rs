import { org } from "renox:modules";

// A module in isolate mode (the host carries and checks its identity) calling
// org.bootstrap inside the same anonymous request the platform's setup call
// uses: org must see ctx.caller === "orgprobe", not "app".
export async function callBootstrap(_ctx, input) {
  return org.bootstrap(input);
}
