// Test only: a listener for `twofa.reset` that logs what it received, so a
// test counts the deliveries and reads the payload (the outbox drops a
// delivered event nobody handles).
export const on = {
  "twofa.reset": async (ctx, e) => {
    ctx.log.info("twofa.reset seen", { payload: e.payload });
  },
};
