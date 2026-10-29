export async function names(ctx) {
  return ctx.db.query("select display_name from auth__public_users_v1 order by created_at");
}
export async function hashes(ctx) {
  return ctx.db.query("select password_hash from auth__users");
}
export async function probe(ctx) {
  // reader is approved no network: an OAuth host is refused like any other.
  try {
    await ctx.fetch("https://accounts.google.com/.well-known/openid-configuration");
    return { blocked: false };
  } catch (e) {
    return { blocked: e.code === "RENOX_FETCH_BLOCKED", reason: e.details?.reason ?? null };
  }
}
