//! #277: `renox__role_assignments` (`ops.md` 1.5.0 section 17, "Role
//! assignments"): unique on (user, role, scope type, scope id), a module
//! limited to the roles it may assign, invisible to module code.

use std::collections::BTreeSet;

use renox_data::roles::{RoleAssignment, assign, list, revoke};
use renox_data::{AuthorizerPolicy, DbError, DbOptions, TenantDb};

#[test]
fn assign_list_revoke_unique() {
    let dir = tempfile::tempdir().unwrap();
    let db = TenantDb::open(dir.path().join("t.db"), DbOptions::default()).unwrap();
    assert!(
        assign(
            &db,
            &RoleAssignment::new("u1", "finance", "org", Some("o_1"), "u_admin", 1),
            None
        )
        .unwrap()
    );
    assert!(
        !assign(
            &db,
            &RoleAssignment::new("u1", "finance", "org", Some("o_1"), "u_other", 2),
            None
        )
        .unwrap(),
        "unique: the second is a no-op"
    );
    assert!(
        assign(
            &db,
            &RoleAssignment::new("u1", "finance", "org", Some("o_2"), "u_admin", 3),
            None
        )
        .unwrap()
    );
    assert!(
        assign(
            &db,
            &RoleAssignment::new("u1", "admin", "global", None, "u_admin", 4),
            None
        )
        .unwrap()
    );
    assert!(
        !assign(
            &db,
            &RoleAssignment::new("u1", "admin", "global", None, "u_admin", 5),
            None
        )
        .unwrap(),
        "a global assignment is unique too"
    );
    let l = list(&db, "u1").unwrap();
    assert_eq!(l.len(), 3);
    assert_eq!(
        (
            l[0].role.as_str(),
            l[0].scope_type.as_str(),
            l[0].scope_id.as_deref(),
            l[0].granted_by.as_str()
        ),
        ("admin", "global", None, "u_admin")
    );
    assert_eq!(l[1].scope_id.as_deref(), Some("o_1"));
    assert_eq!(l[1].granted_by, "u_admin", "the first grant is kept");
    assert!(revoke(&db, "u1", "finance", "org", Some("o_1"), None).unwrap());
    assert!(!revoke(&db, "u1", "finance", "org", Some("o_1"), None).unwrap());
    assert_eq!(list(&db, "u1").unwrap().len(), 2);
    assert!(list(&db, "u2").unwrap().is_empty());
}

#[test]
fn a_module_assigns_only_its_roles_inside_the_transaction() {
    let dir = tempfile::tempdir().unwrap();
    let db = TenantDb::open(dir.path().join("t.db"), DbOptions::default()).unwrap();
    let allowed: BTreeSet<String> = ["finance".to_string()].into();
    assert_eq!(
        assign(
            &db,
            &RoleAssignment::new("u1", "admin", "global", None, "system:billing", 1),
            Some(&allowed)
        )
        .unwrap_err(),
        DbError::Param("role:admin".into())
    );
    assert!(
        list(&db, "u1").unwrap().is_empty(),
        "nothing written before the refusal"
    );
    // In a rolled-back transaction, nothing stays.
    let r: Result<(), DbError> = db.transaction(|tx| {
        assign(
            tx,
            &RoleAssignment::new("u1", "finance", "global", None, "system:billing", 1),
            Some(&allowed),
        )?;
        Err(DbError::Param("roll back".into()))
    });
    assert!(r.is_err());
    assert!(list(&db, "u1").unwrap().is_empty());
}

#[test]
fn module_code_cannot_read_or_write_assignments() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("t.db");
    TenantDb::open(&path, DbOptions::default()).unwrap();
    let m = TenantDb::open(&path, DbOptions::default())
        .unwrap()
        .with_authorizer(AuthorizerPolicy::module("shop"))
        .unwrap();
    assert!(matches!(
        m.query("select * from renox__role_assignments", &[]),
        Err(DbError::Auth { .. })
    ));
    assert!(matches!(
        m.execute(
            "insert into renox__role_assignments values ('u', 'admin', 'global', '', 'x', 1)",
            &[]
        ),
        Err(DbError::Auth { .. })
    ));
}
