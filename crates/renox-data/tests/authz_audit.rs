//! #277: the append-only `renox__authz_audit` (`ops.md` 1.5.0 section 17,
//! "Audit"; `docs/11-authorization.md`, "Decisions for `sensitive` actions
//! are written append-only"): `INSERT` by the platform only; `UPDATE`,
//! `DELETE`, `DROP`, `ALTER` refused for everyone, the platform included;
//! `SELECT` through `renox__authz_audit_v1` for modules that depend on
//! `audit`.

use renox_data::roles::{AuditRow, record};
use renox_data::{AuthorizerPolicy, DbError, DbOptions, TenantDb, Value};

fn row(allow: bool) -> AuditRow<'static> {
    AuditRow {
        principal: "u1",
        action: "invoice.refund",
        resource: Some(("Billing::Invoice", "inv_1")),
        allow,
        policy: Some("billing.refund_limit"),
        at: 1,
    }
}

#[test]
fn rows_are_appended_and_never_changed() {
    let dir = tempfile::tempdir().unwrap();
    let db = TenantDb::open(dir.path().join("t.db"), DbOptions::default()).unwrap();
    let a = record(&db, &row(false)).unwrap();
    let b = record(
        &db,
        &AuditRow {
            principal: "anonymous",
            resource: None,
            policy: None,
            ..row(true)
        },
    )
    .unwrap();
    assert!(b > a);
    let rows = db
        .query(
            "select principal, result, resource_type, policy from renox__authz_audit order by id",
            &[],
        )
        .unwrap();
    assert_eq!(rows[0].get("result"), Some(&Value::from("deny")));
    assert_eq!(rows[1].get("resource_type"), Some(&Value::Null));
    for sql in [
        "update renox__authz_audit set result = 'allow'",
        "delete from renox__authz_audit",
        "drop table renox__authz_audit",
        "alter table renox__authz_audit add column x text",
        "drop view renox__authz_audit_v1",
    ] {
        assert!(
            matches!(db.execute(sql, &[]), Err(DbError::Auth { .. })),
            "the platform too: {sql}"
        );
    }
    assert_eq!(
        db.query("select count(*) as n from renox__authz_audit", &[])
            .unwrap()[0]
            .get("n"),
        Some(&Value::Integer(2))
    );
    // In the request's transaction: a rollback takes the row with it.
    let r: Result<(), DbError> = db.transaction(|tx| {
        record(tx, &row(false))?;
        Err(DbError::Param("refund failed".into()))
    });
    assert!(r.is_err());
    assert_eq!(
        db.query("select count(*) as n from renox__authz_audit", &[])
            .unwrap()[0]
            .get("n"),
        Some(&Value::Integer(2))
    );
}

#[test]
fn modules_read_the_view_only_when_they_depend_on_audit() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("t.db");
    let platform = TenantDb::open(&path, DbOptions::default()).unwrap();
    record(&platform, &row(true)).unwrap();
    let open = |p: AuthorizerPolicy| {
        TenantDb::open(&path, DbOptions::default())
            .unwrap()
            .with_authorizer(p)
            .unwrap()
    };
    let reader = open(AuthorizerPolicy::module("admin").with_read_deps(["audit"]));
    assert_eq!(
        reader
            .query("select principal, action from renox__authz_audit_v1", &[])
            .unwrap()
            .len(),
        1
    );
    assert!(
        matches!(
            reader.query("select * from renox__authz_audit", &[]),
            Err(DbError::Auth { .. })
        ),
        "the table itself is not readable"
    );
    assert!(matches!(reader.execute("insert into renox__authz_audit (principal, action, result, at) values ('x', 'y', 'allow', 1)", &[]), Err(DbError::Auth { .. })));
    let audit = open(AuthorizerPolicy::module("audit"));
    assert_eq!(
        audit
            .query("select count(*) as n from renox__authz_audit_v1", &[])
            .unwrap()
            .len(),
        1
    );
    let other = open(AuthorizerPolicy::module("shop"));
    assert!(matches!(
        other.query("select * from renox__authz_audit_v1", &[]),
        Err(DbError::Auth { .. })
    ));
}
