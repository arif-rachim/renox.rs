// Test only: app code tries to rewrite and erase the trail.
export async function POST(ctx) {
  const tries = {
    update: "update audit__events set action = 'auth.nothing'",
    delete: "delete from audit__events",
    drop_trigger: "drop trigger audit__events_no_update",
    platform_update: "update renox__authz_audit set result = 'allow'",
    platform_delete: "delete from renox__authz_audit",
  };
  const out = {};
  for (const [name, sql] of Object.entries(tries)) {
    try {
      await ctx.db.execute(sql);
      out[name] = "allowed";
    } catch (e) {
      out[name] = String(e?.message ?? e);
    }
  }
  return Response.json(out);
}
