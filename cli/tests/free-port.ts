// A free loopback port for the tests that start `renox dev` (#534 CI). A
// random port in 20000-40000 can collide with the runner's ephemeral range
// (Linux 32768-60999), which failed `renox dev` with "port … is in use".

/** A port the OS just reported free on 127.0.0.1. */
export function freePort(): number {
  const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = s.port;
  s.stop(true);
  return port;
}
