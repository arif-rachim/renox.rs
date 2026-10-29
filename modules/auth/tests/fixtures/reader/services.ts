export async function names(ctx) {
  return ctx.db.query("select display_name from auth__public_users_v1 order by created_at");
}
export async function hashes(ctx) {
  return ctx.db.query("select password_hash from auth__users");
}
