//! Secrets in controlled mode (`docs/contracts/deploy-api.md` section 9):
//! `GET /v1/nodes/{node_id}/secrets/{app}/{hash}?version=N` once per cell
//! creation. The bundle is kept in memory only and passed to the isolate; it
//! is never written to disk or logged, and is dropped with the request that
//! fetched it.

use std::collections::BTreeMap;

use serde::Deserialize;

use crate::cell::{SecretsError, SecretsFuture, SecretsRequest, SecretsSource};
use crate::control::http::ControlClient;

#[derive(Deserialize)]
struct Bundle {
    tenant_id: String,
    deployment_hash: String,
    version: u64,
    secrets: BTreeMap<String, String>,
}

/// [`SecretsSource`] over the control API.
pub struct ControlSecrets {
    pub client: ControlClient,
}

impl SecretsSource for ControlSecrets {
    fn secrets(&self, request: SecretsRequest) -> SecretsFuture<'_> {
        Box::pin(async move {
            let Some(app) = &request.app else {
                return Err(SecretsError::Unavailable(
                    "no route entry names the deployment's app".into(),
                ));
            };
            let path = self.client.node_path(&format!(
                "/secrets/{app}/{}?version={}",
                request.deployment_hash, request.secrets_version
            ));
            let bundle: Bundle = self
                .client
                .get_json(&path)
                .await
                .map_err(|e| SecretsError::Unavailable(e.to_string()))?;
            if bundle.tenant_id != request.tenant_id
                || bundle.deployment_hash != request.deployment_hash
                || bundle.version != request.secrets_version
            {
                return Err(SecretsError::Unavailable(
                    "the bundle is for another deployment or version".into(),
                ));
            }
            Ok(bundle.secrets)
        })
    }
}
