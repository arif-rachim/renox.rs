//! Tests for #305 (F5-33): the change feed's commit-time row capture,
//! `TenantDb::on_rows_changed` (`ops.md` 1.5.0 section 18, "Change feed";
//! `docs/23-failure-modes.md` "Realtime": an event is published for a
//! committed change and never for a rolled-back one).

use std::sync::{Arc, Mutex};

use renox_data::{ChangeOp, DbError, DbOptions, FEED_MAX_ROWS, RowChange, TenantDb, Value};

type Seen = Arc<Mutex<Vec<Vec<RowChange>>>>;

fn open() -> (tempfile::TempDir, TenantDb, Seen) {
    let dir = tempfile::tempdir().unwrap();
    let db = TenantDb::open(dir.path().join("tenant.db"), DbOptions::default()).unwrap();
    db.execute(
        "create table shop__orders (id integer primary key, org_id text not null, total integer check (total >= 0))",
        &[],
    )
    .unwrap();
    db.execute(
        "create table shop__notes (id integer primary key, body text)",
        &[],
    )
    .unwrap();
    let seen: Seen = Arc::default();
    let sink = Arc::clone(&seen);
    db.on_rows_changed(
        &[("shop__orders".into(), vec!["org_id".into()])],
        Arc::new(move |changes| sink.lock().unwrap().push(changes)),
    )
    .unwrap();
    (dir, db, seen)
}

/// One delivered change as (op, rowid, columns).
type Seen1 = (ChangeOp, i64, Vec<(String, Value)>);

fn ops(seen: &Seen) -> Vec<Vec<Seen1>> {
    seen.lock()
        .unwrap()
        .iter()
        .map(|batch| {
            batch
                .iter()
                .map(|c| (c.op, c.rowid, c.columns.clone()))
                .collect()
        })
        .collect()
}

fn org(id: &str) -> Vec<(String, Value)> {
    vec![("org_id".into(), Value::Text(id.into()))]
}

/// docs/23-failure-modes.md "Realtime": a committed change is published once, after the commit.
#[test]
fn a_committed_transaction_delivers_its_changes_once_after_the_commit() {
    let (_d, db, seen) = open();
    db.transaction(|tx| {
        tx.execute(
            "insert into shop__orders (id, org_id, total) values (1, 'o1', 5)",
            &[],
        )?;
        tx.execute("update shop__orders set total = 7 where id = 1", &[])?;
        // Not delivered before the commit.
        assert!(seen.lock().unwrap().is_empty());
        Ok::<_, DbError>(())
    })
    .unwrap();
    assert_eq!(
        ops(&seen),
        vec![vec![
            (ChangeOp::Insert, 1, org("o1")),
            (ChangeOp::Update, 1, org("o1"))
        ]]
    );
    // Autocommit statements are one transaction each.
    db.execute("delete from shop__orders where id = 1", &[])
        .unwrap();
    assert_eq!(ops(&seen)[1], vec![(ChangeOp::Delete, 1, org("o1"))]);
}

/// docs/23-failure-modes.md "Realtime": the commit-not-rollback test.
#[test]
fn a_rolled_back_transaction_delivers_nothing_and_leaves_nothing_for_the_next_commit() {
    let (_d, db, seen) = open();
    let r = db.transaction(|tx| {
        tx.execute(
            "insert into shop__orders (id, org_id, total) values (1, 'o1', 5)",
            &[],
        )?;
        Err::<(), _>(DbError::TxState("abort".into()))
    });
    assert!(r.is_err());
    assert!(seen.lock().unwrap().is_empty());
    db.execute(
        "insert into shop__orders (id, org_id, total) values (2, 'o2', 5)",
        &[],
    )
    .unwrap();
    assert_eq!(ops(&seen), vec![vec![(ChangeOp::Insert, 2, org("o2"))]]);
}

#[test]
fn a_failed_statement_and_a_rolled_back_savepoint_publish_nothing() {
    let (_d, db, seen) = open();
    // Autocommit: the second row breaks the CHECK, the statement is undone.
    assert!(
        db.execute(
            "insert into shop__orders (id, org_id, total) values (1, 'o1', 1), (2, 'o1', -1)",
            &[]
        )
        .is_err()
    );
    db.transaction(|tx| {
        tx.execute(
            "insert into shop__orders (id, org_id, total) values (3, 'o3', 1)",
            &[],
        )?;
        assert!(
            tx.execute(
                "insert into shop__orders (id, org_id, total) values (4, 'o4', -1)",
                &[]
            )
            .is_err()
        );
        let r = tx.savepoint(|tx| {
            tx.execute(
                "insert into shop__orders (id, org_id, total) values (5, 'o5', 1)",
                &[],
            )?;
            Err::<(), _>(DbError::TxState("inner".into()))
        });
        assert!(r.is_err());
        tx.savepoint(|tx| {
            tx.execute(
                "insert into shop__orders (id, org_id, total) values (6, 'o6', 1)",
                &[],
            )
        })?;
        Ok::<_, DbError>(())
    })
    .unwrap();
    assert_eq!(
        ops(&seen),
        vec![vec![
            (ChangeOp::Insert, 3, org("o3")),
            (ChangeOp::Insert, 6, org("o6"))
        ]]
    );
}

#[test]
fn the_owner_value_comes_from_the_row_and_a_delete_reads_the_old_row() {
    let (_d, db, seen) = open();
    db.execute(
        "insert into shop__orders (id, org_id, total) values (1, 'o1', 5)",
        &[],
    )
    .unwrap();
    // An update that moves the row to another org reports the new owner.
    db.execute("update shop__orders set org_id = 'o9' where id = 1", &[])
        .unwrap();
    db.execute("delete from shop__orders where id = 1", &[])
        .unwrap();
    assert_eq!(
        ops(&seen),
        vec![
            vec![(ChangeOp::Insert, 1, org("o1"))],
            vec![(ChangeOp::Update, 1, org("o9"))],
            vec![(ChangeOp::Delete, 1, org("o9"))],
        ]
    );
}

#[test]
fn tables_the_feed_does_not_watch_are_not_reported() {
    let (_d, db, seen) = open();
    db.execute("insert into shop__notes (body) values ('x')", &[])
        .unwrap();
    assert!(seen.lock().unwrap().is_empty());
}

#[test]
fn past_the_buffer_one_many_event_per_table_replaces_the_rows() {
    let (_d, db, seen) = open();
    db.transaction(|tx| {
        for i in 0..=FEED_MAX_ROWS as i64 {
            tx.execute(
                "insert into shop__orders (id, org_id, total) values (?1, 'o1', 1)",
                &[Value::Integer(i + 1)],
            )?;
        }
        Ok::<_, DbError>(())
    })
    .unwrap();
    let batches = seen.lock().unwrap().clone();
    assert_eq!(batches.len(), 1);
    assert_eq!(
        batches[0],
        vec![RowChange {
            table: "shop__orders".into(),
            rowid: 0,
            op: ChangeOp::Many,
            columns: vec![]
        }]
    );
    // The next transaction starts with an empty buffer.
    db.execute("delete from shop__orders where id = 1", &[])
        .unwrap();
    assert_eq!(seen.lock().unwrap()[1].len(), 1);
}

#[test]
fn an_unknown_table_or_column_is_refused_and_an_empty_list_unsubscribes() {
    let (_d, db, seen) = open();
    let sink = Arc::new(|_: Vec<RowChange>| {});
    assert!(matches!(
        db.on_rows_changed(&[("shop__missing".into(), vec![])], sink.clone()),
        Err(DbError::Param(_))
    ));
    assert!(matches!(
        db.on_rows_changed(
            &[("shop__orders".into(), vec!["tenant".into()])],
            sink.clone()
        ),
        Err(DbError::Param(_))
    ));
    db.on_rows_changed(&[], sink).unwrap();
    db.execute(
        "insert into shop__orders (id, org_id, total) values (1, 'o1', 5)",
        &[],
    )
    .unwrap();
    assert!(seen.lock().unwrap().is_empty());
}
