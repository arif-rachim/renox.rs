//! SQL values and result rows (`docs/contracts/ops.md` section 1, "Parameters and values").

use rusqlite::types::{FromSql, FromSqlResult, ToSql, ToSqlOutput, ValueRef};

/// One SQLite value, used both for parameters and for result columns.
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Null,
    Integer(i64),
    Real(f64),
    Text(String),
    Blob(Vec<u8>),
}

impl ToSql for Value {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(ToSqlOutput::Borrowed(match self {
            Value::Null => ValueRef::Null,
            Value::Integer(i) => ValueRef::Integer(*i),
            Value::Real(f) => ValueRef::Real(*f),
            Value::Text(s) => ValueRef::Text(s.as_bytes()),
            Value::Blob(b) => ValueRef::Blob(b),
        }))
    }
}

impl FromSql for Value {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
        Ok(match value {
            ValueRef::Null => Value::Null,
            ValueRef::Integer(i) => Value::Integer(i),
            ValueRef::Real(f) => Value::Real(f),
            // SQLite may hold non-UTF-8 bytes in a TEXT column; replace them
            // rather than failing the whole query.
            ValueRef::Text(t) => Value::Text(String::from_utf8_lossy(t).into_owned()),
            ValueRef::Blob(b) => Value::Blob(b.to_vec()),
        })
    }
}

impl From<i64> for Value {
    fn from(v: i64) -> Self {
        Value::Integer(v)
    }
}

impl From<f64> for Value {
    fn from(v: f64) -> Self {
        Value::Real(v)
    }
}

impl From<bool> for Value {
    fn from(v: bool) -> Self {
        Value::Integer(i64::from(v))
    }
}

impl From<&str> for Value {
    fn from(v: &str) -> Self {
        Value::Text(v.to_owned())
    }
}

impl From<String> for Value {
    fn from(v: String) -> Self {
        Value::Text(v)
    }
}

impl From<Vec<u8>> for Value {
    fn from(v: Vec<u8>) -> Self {
        Value::Blob(v)
    }
}

impl<T: Into<Value>> From<Option<T>> for Value {
    fn from(v: Option<T>) -> Self {
        v.map_or(Value::Null, Into::into)
    }
}

/// One result row: column name to value, in result column order.
///
/// Column names are unique within a row: a query whose result has two
/// columns with the same name fails with `DbError::ColumnName`.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Row {
    columns: Vec<(String, Value)>,
}

impl Row {
    pub(crate) fn from_columns(columns: Vec<(String, Value)>) -> Self {
        Row { columns }
    }

    /// The value of the column `name`, if the row has it.
    pub fn get(&self, name: &str) -> Option<&Value> {
        self.columns.iter().find(|(n, _)| n == name).map(|(_, v)| v)
    }

    /// Columns in result order.
    pub fn iter(&self) -> impl ExactSizeIterator<Item = (&str, &Value)> {
        self.columns.iter().map(|(n, v)| (n.as_str(), v))
    }

    pub fn len(&self) -> usize {
        self.columns.len()
    }

    pub fn is_empty(&self) -> bool {
        self.columns.is_empty()
    }

    pub fn into_columns(self) -> Vec<(String, Value)> {
        self.columns
    }
}

/// Result of `execute`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExecResult {
    /// Rows changed by the statement (`sqlite3_changes64`).
    pub changes: u64,
    /// Rowid of the most recent successful insert on the writer connection.
    pub last_insert_rowid: i64,
}
