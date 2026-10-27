//! Errors, mapped to the codes of `docs/contracts/ops.md` section 1 ("Errors")
//! and `docs/contracts/errors.md`.

use rusqlite::ffi;

pub type Result<T, E = DbError> = std::result::Result<T, E>;

/// Which constraint failed (`details.kind` of `RENOX_DB_CONSTRAINT`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConstraintKind {
    Unique,
    PrimaryKey,
    ForeignKey,
    NotNull,
    Check,
    Other,
}

impl ConstraintKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ConstraintKind::Unique => "unique",
            ConstraintKind::PrimaryKey => "primary_key",
            ConstraintKind::ForeignKey => "foreign_key",
            ConstraintKind::NotNull => "not_null",
            ConstraintKind::Check => "check",
            ConstraintKind::Other => "other",
        }
    }
}

/// Every error `renox-data` returns. Messages never contain the file path.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum DbError {
    /// The write lock stayed taken for the whole busy wait.
    #[error("database is busy")]
    Busy,
    /// Any other SQLite error: syntax, unknown table or column, I/O.
    #[error("sqlite error {code}: {message}")]
    Sqlite { code: i32, message: String },
    /// The authorizer refused the statement at prepare time. `table` is the
    /// table, view, index, or other object named in the refused action;
    /// `action` is the SQLite action (`READ`, `INSERT`, `ATTACH`, `PRAGMA`, ...).
    #[error("not authorized: {action} {table}")]
    Auth { table: String, action: String },
    /// The statement time limit or the request deadline was reached.
    #[error("statement time limit reached")]
    Timeout,
    /// The file reached its `max_page_count` quota. Reads still work.
    #[error("database file size quota exceeded")]
    QuotaExceeded,
    #[error("{} constraint failed: {message}", kind.as_str())]
    Constraint {
        kind: ConstraintKind,
        message: String,
    },
    /// Wrong parameter count or named parameters.
    #[error("invalid parameter: {0}")]
    Param(String),
    /// Two result columns with the same name.
    #[error("duplicate result column name: {0}")]
    ColumnName(String),
    #[error("only one statement per call is allowed")]
    MultiStatement,
    /// A transaction was begun inside another, or a write ran outside the
    /// open transaction.
    #[error("transaction state: {0}")]
    TxState(String),
    /// The file could not be opened with the required settings.
    #[error("open failed: {0}")]
    Open(String),
}

impl DbError {
    /// The shared error code of `docs/contracts/ops.md` section 13.
    pub fn code(&self) -> &'static str {
        match self {
            DbError::Busy => "RENOX_DB_BUSY",
            DbError::Sqlite { .. } => "RENOX_DB_SQL",
            DbError::Auth { .. } => "RENOX_DB_AUTH",
            DbError::Timeout => "RENOX_DB_TIMEOUT",
            DbError::QuotaExceeded => "RENOX_DB_QUOTA",
            DbError::Constraint { .. } => "RENOX_DB_CONSTRAINT",
            DbError::Param(_) => "RENOX_DB_PARAM",
            DbError::ColumnName(_) => "RENOX_DB_COLUMN_NAME",
            DbError::MultiStatement => "RENOX_DB_MULTI_STATEMENT",
            DbError::TxState(_) => "RENOX_DB_TX_STATE",
            DbError::Open(_) => "RENOX_INTERNAL",
        }
    }
}

impl From<rusqlite::Error> for DbError {
    fn from(e: rusqlite::Error) -> Self {
        match e {
            rusqlite::Error::SqliteFailure(err, msg) => {
                let message = msg.unwrap_or_else(|| err.to_string());
                match err.code {
                    rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked => {
                        DbError::Busy
                    }
                    rusqlite::ErrorCode::DiskFull => DbError::QuotaExceeded,
                    // Without the denial recorded by the authorizer hook the
                    // object is unknown; `db.rs` fills it in when it has it.
                    rusqlite::ErrorCode::AuthorizationForStatementDenied => DbError::Auth {
                        table: String::new(),
                        action: String::new(),
                    },
                    // Only the progress handler interrupts; `db.rs` turns it
                    // into `Timeout` (no other code calls sqlite3_interrupt).
                    rusqlite::ErrorCode::OperationInterrupted => DbError::Timeout,
                    rusqlite::ErrorCode::ConstraintViolation => DbError::Constraint {
                        kind: match err.extended_code {
                            ffi::SQLITE_CONSTRAINT_UNIQUE => ConstraintKind::Unique,
                            ffi::SQLITE_CONSTRAINT_PRIMARYKEY => ConstraintKind::PrimaryKey,
                            ffi::SQLITE_CONSTRAINT_FOREIGNKEY => ConstraintKind::ForeignKey,
                            ffi::SQLITE_CONSTRAINT_NOTNULL => ConstraintKind::NotNull,
                            ffi::SQLITE_CONSTRAINT_CHECK => ConstraintKind::Check,
                            _ => ConstraintKind::Other,
                        },
                        message,
                    },
                    _ => DbError::Sqlite {
                        code: err.extended_code,
                        message,
                    },
                }
            }
            rusqlite::Error::MultipleStatement => DbError::MultiStatement,
            rusqlite::Error::InvalidParameterCount(given, expected) => DbError::Param(format!(
                "{given} parameters given, statement has {expected}"
            )),
            other => DbError::Sqlite {
                code: ffi::SQLITE_ERROR,
                message: other.to_string(),
            },
        }
    }
}
