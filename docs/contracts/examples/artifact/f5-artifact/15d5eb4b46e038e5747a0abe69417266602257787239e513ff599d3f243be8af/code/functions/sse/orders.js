export const sse = {
  async open({ conn, principal, realtime }) {
    if (principal === null) return realtime.close(conn, 1008, "sign in");
    await realtime.subscribe(conn, `orders:${principal.attrs.org}`);
  },
};
