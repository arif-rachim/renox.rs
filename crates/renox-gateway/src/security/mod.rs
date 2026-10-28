//! Web-layer protections (#47; `docs/04-isolation-security.md`, "Web-layer
//! protections"; `docs/contracts/artifact.md` section 3, "Security"):
//! the deployment's `security` object from its manifest, a CSP nonce per
//! request, the response headers, and CORS. Per-route rate-limit buckets
//! need route matching and run in the cell (`renox-cell`, after `router.rs`);
//! this module only parses them.
//!
//! - `config.rs`: the `security` object and the manifest's
//!   `artifact.version`, read once per deployment hash.
//! - `headers.rs`: CSP (strict, `'self'` plus the nonce), `X-Frame-Options`,
//!   `Referrer-Policy`, `Permissions-Policy`, and the fixed headers. The
//!   gateway overwrites whatever tenant code set for these names.
//! - `cors.rs`: preflights answered in the gateway; listed origins get the
//!   `Access-Control-*` headers, everything else none (closed by default).

pub mod config;
pub mod cors;
pub mod headers;

pub use config::{Cors, Csp, DeploymentInfo, Headers, RateBucket, SecurityConfig, SecurityStore};
pub use headers::{CSP_REPORT_PATH, apply as apply_headers, csp_value, new_nonce};
