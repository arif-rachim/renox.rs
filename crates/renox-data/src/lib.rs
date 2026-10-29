//! `renox-data`: one SQLite file per tenant (ADR D5, `docs/06-data.md`).
//!
//! Leaf crate: depends on no other `renox-*` crate and never links V8
//! (`docs/12-developer-experience.md`, "Build and compile strategy").

#![forbid(unsafe_code)]

mod authorizer;
mod db;
mod error;
mod limits;
mod migrate;
pub mod outbox;
mod stats;
mod value;

pub use authorizer::{APP_MODULE, AuthorizerPolicy, PLATFORM_MODULE};
pub use db::{
    DbOptions, FREE_QUOTA_BYTES, MAX_SAVEPOINTS, PAGE_SIZE, PAID_QUOTA_BYTES, TenantDb, Tx,
};
pub use error::{ConstraintKind, DbError, Result};
pub use limits::{CheckpointMode, CheckpointResult, QueryCtx};
pub use migrate::{
    MIGRATION_FILE_TIMEOUT, MigrationError, MigrationFile, MigrationReport, ModuleMigrations,
    PlanError, PlanReport, checksum, migrate, migrate_all, migrate_with_checksums,
};
pub use stats::{DbStats, OutboxStats};
pub use value::{ExecResult, Row, Value};
