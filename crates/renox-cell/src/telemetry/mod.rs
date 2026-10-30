//! Traces and metrics of the worker (#295; `docs/15-roadmap.md` F6,
//! `docs/03-architecture.md` observability row).
//!
//! **Traces.** The platform's `tracing` spans go to OpenTelemetry through
//! `tracing-opentelemetry` and are exported over OTLP/HTTP with protobuf
//! (`[telemetry] otlp_endpoint`, e.g. `http://collector:4318/v1/traces`;
//! no gRPC). One request is one trace rooted at `gateway.request`:
//!
//! | Span | Where | Attributes |
//! | --- | --- | --- |
//! | `gateway.request` | `renox-gateway` | `tenant_id`, `request_id`, `status`, `trace_id` |
//! | `cell.request` | the cell's dispatch | `tenant_id`, `route`, `kind` |
//! | `cell.loader`, `cell.action` | a page's `load` / action | `route` |
//! | `template.render` | the page or fragment render | `template`, `fuel` |
//! | `realtime.open`, `realtime.message` | a `ws` / `sse` handler run | `route` |
//! | `mcp.tool` | an App MCP tool call | `tool` |
//! | `outbox.deliver` | an event delivery attempt | `event`, `module`, `attempt` |
//! | `db.query` | `renox-data`, each statement | `kind` (the statement's verb), `tables` |
//! | `fetch` | tenant `fetch` | `host` |
//! | `module.service` | a broker service call | `caller`, `callee`, `name` |
//!
//! `db.query`, `fetch` and `module.service` run on the isolate's thread, so
//! they are separate traces that carry the request id (`request_id`), not
//! children of `cell.request`. Spans never carry SQL text or parameters,
//! a URL path or query, a header, a cookie, a body, or a secret: every
//! attribute above is an identifier the platform chose or a number
//! (`tests/telemetry.rs` proves it for a request with a secret in a header
//! and in the query).
//!
//! Sampling is the parent's decision, else `sample_ratio` of the traces.
//!
//! **Metrics.** [`metrics`]: Prometheus text at `GET /metrics` on the
//! operator listener (`[control] health_listen`), per tenant where the
//! family says so; the families are the ones `ops/observability/README.md`
//! reserved for the Grafana panels and alert rules of #296.
//!
//! **Logs.** Platform log lines are JSON with the current span list, so a
//! line inside a request names `gateway.request`'s `trace_id` and
//! `request_id`.

use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper_util::client::legacy::Client;
use hyper_util::rt::TokioExecutor;
use opentelemetry::trace::TracerProvider as _;
use opentelemetry_otlp::{Protocol, WithExportConfig, WithHttpConfig};
use opentelemetry_sdk::Resource;
use opentelemetry_sdk::trace::{Sampler, SdkTracerProvider, SpanExporter};

pub mod counters;
pub mod metrics;

/// `[telemetry]` of `worker.toml`.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct TelemetrySection {
    /// OTLP/HTTP traces endpoint (`.../v1/traces`); absent: no export.
    pub otlp_endpoint: Option<String>,
    /// Share of root traces kept, 0 to 1 (default 0.1).
    pub sample_ratio: f64,
    /// `service.name` of the exported spans.
    pub service_name: String,
}

impl Default for TelemetrySection {
    fn default() -> Self {
        TelemetrySection {
            otlp_endpoint: None,
            sample_ratio: 0.1,
            service_name: "renox-worker".into(),
        }
    }
}

/// The sampler of `[telemetry]`: the parent's decision, else the ratio.
pub fn sampler(ratio: f64) -> Sampler {
    Sampler::ParentBased(Box::new(Sampler::TraceIdRatioBased(ratio.clamp(0.0, 1.0))))
}

/// A tracer provider batching to `exporter` (production) with the sampler
/// and service name of `section`.
pub fn provider<E: SpanExporter + 'static>(
    section: &TelemetrySection,
    exporter: E,
) -> SdkTracerProvider {
    SdkTracerProvider::builder()
        .with_batch_exporter(exporter)
        .with_sampler(sampler(section.sample_ratio))
        .with_resource(
            Resource::builder()
                .with_service_name(section.service_name.clone())
                .build(),
        )
        .build()
}

/// The OTLP/HTTP exporter of `section`, or `None` without an endpoint.
/// Must be called inside the worker's tokio runtime: exports run on it.
pub fn otlp_provider(section: &TelemetrySection) -> Result<Option<SdkTracerProvider>, String> {
    let Some(endpoint) = section.otlp_endpoint.clone() else {
        return Ok(None);
    };
    if !(endpoint.starts_with("http://") || endpoint.starts_with("https://")) {
        return Err(format!(
            "[telemetry] otlp_endpoint must be an http(s) URL, got {endpoint:?}"
        ));
    }
    let exporter = opentelemetry_otlp::SpanExporter::builder()
        .with_http()
        .with_http_client(HyperClient::new()?)
        .with_protocol(Protocol::HttpBinary)
        .with_endpoint(endpoint)
        .with_timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("[telemetry] exporter: {e}"))?;
    Ok(Some(provider(section, exporter)))
}

/// The `tracing` layer that turns spans into OpenTelemetry spans.
pub fn layer<S>(
    provider: &SdkTracerProvider,
) -> tracing_opentelemetry::OpenTelemetryLayer<S, opentelemetry_sdk::trace::SdkTracer>
where
    S: tracing::Subscriber + for<'a> tracing_subscriber::registry::LookupSpan<'a>,
{
    tracing_opentelemetry::layer().with_tracer(provider.tracer("renox"))
}

/// The OpenTelemetry trace id of `span` as 32 hex digits, when it is
/// exported (`None` without a provider or for an unsampled trace).
pub fn trace_id(span: &tracing::Span) -> Option<String> {
    use opentelemetry::trace::TraceContextExt;
    use tracing_opentelemetry::OpenTelemetrySpanExt;
    let cx = span.context();
    let sc = cx.span().span_context().clone();
    sc.is_valid().then(|| sc.trace_id().to_string())
}

/// The exporter's HTTP client: this crate's hyper over rustls, run on the
/// tokio runtime that was current when it was built (the batch processor
/// calls it from its own thread).
#[derive(Clone)]
struct HyperClient {
    handle: tokio::runtime::Handle,
    http: Client<
        hyper_rustls::HttpsConnector<hyper_util::client::legacy::connect::HttpConnector>,
        Full<Bytes>,
    >,
}

impl std::fmt::Debug for HyperClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HyperClient").finish_non_exhaustive()
    }
}

impl HyperClient {
    fn new() -> Result<HyperClient, String> {
        let handle = tokio::runtime::Handle::try_current()
            .map_err(|_| "[telemetry] the exporter needs the worker's runtime".to_string())?;
        let https = hyper_rustls::HttpsConnectorBuilder::new()
            .with_provider_and_webpki_roots(rustls::crypto::ring::default_provider())
            .map_err(|e| e.to_string())?
            .https_or_http()
            .enable_http1()
            .build();
        Ok(HyperClient {
            handle,
            http: Client::builder(TokioExecutor::new())
                .pool_idle_timeout(Duration::from_secs(30))
                .build(https),
        })
    }
}

impl opentelemetry_http::HttpClient for HyperClient {
    fn send_bytes<'a, 'b>(
        &'a self,
        request: http::Request<Bytes>,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<http::Response<Bytes>, opentelemetry_http::HttpError>>
                + Send
                + 'b,
        >,
    >
    where
        'a: 'b,
    {
        let http = self.http.clone();
        let task = self.handle.spawn(async move {
            let res = http.request(request.map(Full::new)).await?;
            let (parts, body) = res.into_parts();
            let body = body.collect().await?.to_bytes();
            Ok::<_, opentelemetry_http::HttpError>(http::Response::from_parts(parts, body))
        });
        Box::pin(async move {
            task.await
                .map_err(|e| Box::new(e) as opentelemetry_http::HttpError)?
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_and_the_endpoint_rule() {
        let d = TelemetrySection::default();
        assert_eq!(d.otlp_endpoint, None);
        assert_eq!(d.sample_ratio, 0.1);
        assert!(otlp_provider(&d).unwrap().is_none());
        let bad = TelemetrySection {
            otlp_endpoint: Some("collector:4318".into()),
            ..TelemetrySection::default()
        };
        assert!(otlp_provider(&bad).is_err());
    }
}
