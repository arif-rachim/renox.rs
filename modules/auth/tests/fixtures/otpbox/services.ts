// #590: the tests give a user organisations (otpbox stands in for org).
export async function addOrg(ctx, userId, orgId, name) {
  await ctx.db.execute("insert into otpbox__orgs (user_id, org_id, name) values (?, ?, ?)", [userId, orgId, name]);
  return true;
}

export async function removeOrg(ctx, userId, orgId) {
  await ctx.db.execute("delete from otpbox__orgs where user_id = ? and org_id = ?", [userId, orgId]);
  return true;
}
