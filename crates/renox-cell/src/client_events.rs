//! The tenant log sink of `/__renox/events` (#126,
//! `docs/contracts/client-events.md` section 9). The gateway validates and
//! limits browser events; this writes the lines it produces into the same
//! tenant log as the isolate's own lines, through the runtime's
//! [`RedactingSink`], so a secret value a browser echoes back (in a message
//! or a URL) is replaced like in any other tenant line.
//!
//! The redactor is built from every value of the tenant's `secrets.json`
//! (no cell is needed: events arrive while the tenant is scaled to zero)
//! and cached per tenant for [`SECRETS_TTL`].

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use renox_gateway::{ClientEventSink, ClientLogLine};
use renox_runtime::ops::log::{RedactingSink, clean_fields};
use renox_runtime::ops::secrets::Redactor;
use renox_runtime::{LogLine, LogSink};

use crate::cell::{load_secrets, valid_tenant_id};

/// How long a tenant's redactor is reused before `secrets.json` is read
/// again.
pub const SECRETS_TTL: Duration = Duration::from_secs(60);

/// [`ClientEventSink`] over the worker's tenant log sink.
pub struct ClientLogSink {
    sink: Arc<dyn LogSink>,
    data_dir: PathBuf,
    redactors: Mutex<HashMap<String, (Instant, Arc<Redactor>)>>,
}

impl ClientLogSink {
    pub fn new(sink: Arc<dyn LogSink>, data_dir: impl Into<PathBuf>) -> ClientLogSink {
        ClientLogSink {
            sink,
            data_dir: data_dir.into(),
            redactors: Mutex::new(HashMap::new()),
        }
    }

    fn redactor(&self, tenant_id: &str) -> Arc<Redactor> {
        let now = Instant::now();
        let mut cache = self.redactors.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((at, r)) = cache.get(tenant_id)
            && now.duration_since(*at) < SECRETS_TTL
        {
            return r.clone();
        }
        // A secrets file that cannot be read (bad mode, bad JSON) gives no
        // redactor; the cell refuses to start for the same file, so the
        // tenant sees that error first.
        let secrets = if valid_tenant_id(tenant_id) {
            load_secrets(&self.data_dir.join(tenant_id).join("secrets.json")).unwrap_or_default()
        } else {
            Default::default()
        };
        let r = Arc::new(Redactor::new(secrets.values()));
        cache.insert(tenant_id.to_owned(), (now, r.clone()));
        r
    }
}

impl ClientEventSink for ClientLogSink {
    fn write(&self, line: ClientLogLine) {
        let sink = RedactingSink {
            inner: self.sink.clone(),
            redactor: self.redactor(&line.tenant_id),
        };
        sink.log(LogLine {
            level: line.level,
            tenant_id: line.tenant_id,
            deployment_hash: line.deployment_hash,
            request_id: line.request_id,
            message: line.message,
            fields: clean_fields(line.fields),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct Capture(Mutex<Vec<LogLine>>);

    impl LogSink for Capture {
        fn log(&self, line: LogLine) {
            self.0.lock().unwrap().push(line);
        }
    }

    /// `docs/24-threat-model.md`, "Secrets in logs": a secret value inside
    /// a browser event is redacted before the line is written.
    #[test]
    fn client_lines_are_redacted_with_the_tenant_secrets() {
        let dir = std::env::temp_dir().join(format!("renox-cell-client-{}", std::process::id()));
        let tenant = dir.join("t_a");
        std::fs::create_dir_all(&tenant).unwrap();
        let path = tenant.join("secrets.json");
        std::fs::write(&path, r#"{"STRIPE_KEY":"sk_live_0123456789abcdef"}"#).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        let capture = Arc::new(Capture::default());
        let sink = ClientLogSink::new(capture.clone(), &dir);
        let mut fields = serde_json::Map::new();
        fields.insert("source".into(), "client".into());
        fields.insert("kind".into(), "js.error".into());
        fields.insert(
            "detail".into(),
            serde_json::json!({ "message": "bad key sk_live_0123456789abcdef" }),
        );
        sink.write(ClientLogLine {
            tenant_id: "t_a".into(),
            deployment_hash: "h".into(),
            request_id: Some("01JBQ3Z7MA0000000000000101".into()),
            level: "error",
            message: "js.error: bad key sk_live_0123456789abcdef".into(),
            fields,
        });
        let lines = capture.0.lock().unwrap();
        assert_eq!(lines.len(), 1);
        let text = format!(
            "{} {}",
            lines[0].message,
            serde_json::Value::Object(lines[0].fields.clone())
        );
        assert!(!text.contains("sk_live_0123456789abcdef"), "{text}");
        assert_eq!(lines[0].fields["source"], "client");
        assert_eq!(lines[0].tenant_id, "t_a");
        drop(lines);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
