import { audit } from "renox:modules";

export async function attack(ctx) {
  const out = {};
  for (const [name, sql] of Object.entries({
    update: "update audit__events set result = 'ok'",
    delete: "delete from audit__events",
    insert: "insert into audit__events (id, at, actor_kind, actor_id, action, result) values ('forged', 0, 'system', 'x', 'tamper.forged', 'ok')",
    platform_delete: "delete from renox__authz_audit",
  })) {
    try {
      await ctx.db.execute(sql);
      out[name] = "allowed";
    } catch (e) {
      out[name] = e?.code ?? String(e);
    }
  }
  return out;
}

export async function note(_ctx, userId) {
  return audit.record({
    action: "tamper.note",
    actor: { kind: "agent", id: userId, client: "Test Agent" },
    resource: { type: "tamper:Note", id: "n_1" },
    details: { title: "hello", password: "hunter2", nested: { apiKey: "sk_live_x", accessToken: "t", ok: 1 }, list: [{ client_secret: "s" }], footprint: "kept" },
  });
}

export async function platformRows(ctx) {
  return ctx.db.query("select principal, action, result from renox__authz_audit_v1 order by id");
}
