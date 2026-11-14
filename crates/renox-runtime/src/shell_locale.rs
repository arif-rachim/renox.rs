//! The page's `setLocale` call, reported to the cell (#790).
//!
//! A streamed page's shell (`<html lang dir>`) is held, after the shell
//! delay, until the loader has called `ctx.setLocale` (`ops.md` section 14,
//! "The shell delay"). The loader runs on the isolate's own thread, so the
//! cell registers, for each request id that may get a shell, a [`Signal`];
//! the `op_page_locale` op looks it up by the request's id, stores the
//! values and wakes the cell. The registration is removed when the guard
//! drops (the dispatch ended).

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};

use tokio::sync::Notify;

/// What `ctx.setLocale` set last, and the wake-up of the cell.
#[derive(Debug, Default)]
pub struct Signal {
    values: Mutex<Option<(String, String)>>,
    notify: Notify,
}

impl Signal {
    fn set(&self, locale: &str, dir: &str) {
        *self.values.lock().expect("locale lock") = Some((locale.to_string(), dir.to_string()));
        // A permit is stored when nobody waits yet, so the call is never lost.
        self.notify.notify_one();
    }

    /// The `(locale, dir)` set so far, if the loader called `setLocale`.
    pub fn values(&self) -> Option<(String, String)> {
        self.values.lock().expect("locale lock").clone()
    }

    /// Resolves once the loader has called `setLocale` (at once if it has).
    pub async fn called(&self) {
        self.notify.notified().await;
    }
}

static SIGNALS: LazyLock<Mutex<HashMap<String, Arc<Signal>>>> = LazyLock::new(Mutex::default);

/// Removes the registration of a request when dropped.
pub struct Registered(String);

impl Drop for Registered {
    fn drop(&mut self) {
        SIGNALS.lock().expect("locale lock").remove(&self.0);
    }
}

/// Registers the signal of `request_id` until the guard drops.
pub fn register(request_id: &str) -> (Registered, Arc<Signal>) {
    let signal = Arc::new(Signal::default());
    SIGNALS
        .lock()
        .expect("locale lock")
        .insert(request_id.to_string(), signal.clone());
    (Registered(request_id.to_string()), signal)
}

/// Reports a `setLocale` call of `request_id`; a request that registered
/// nothing (no shell is possible) ignores it.
pub fn report(request_id: &str, locale: &str, dir: &str) {
    let signal = SIGNALS
        .lock()
        .expect("locale lock")
        .get(request_id)
        .cloned();
    if let Some(signal) = signal {
        signal.set(locale, dir);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_call_before_the_wait_is_not_lost() {
        let (guard, signal) = register("req_locale");
        assert_eq!(signal.values(), None);
        report("req_locale", "ar", "rtl");
        signal.called().await;
        assert_eq!(signal.values(), Some(("ar".into(), "rtl".into())));
        drop(guard);
        report("req_locale", "en", "ltr");
        assert_eq!(signal.values(), Some(("ar".into(), "rtl".into())));
    }
}
