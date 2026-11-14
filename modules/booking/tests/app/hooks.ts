// Test only (#799): the app fills `booking.remind` for customers it keeps itself (ids that start with `wa:`),
// the way an app that sends its own WhatsApp reminder would, and says so in the log.
export const hooks = {
  "booking.remind": {
    handle(ctx, args) {
      if (!String(args.customer).startsWith("wa:")) return;
      ctx.log.info("test filler delivered a reminder", { booking_id: args.booking_id, kind: args.kind, customer: args.customer });
      args.handled = true;
    },
  },
};
