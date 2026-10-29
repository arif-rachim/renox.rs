//! `renox-cell` (P5): wires `renox-gateway`, `renox-runtime`, `renox-data`,
//! `renox-meter`, and `renox-template` (page rendering, #40) into one worker process, the `renox-worker` binary.
//! One cell = one tenant deployment's isolate on this node plus the tenant's
//! SQLite file (`docs/17-glossary.md`). See `README.md`.

pub mod alloc;
pub mod artifact;
pub mod artifact_s3;
pub mod cell;
pub mod client_events;
pub mod config;
pub mod control;
pub mod health_probe;
pub mod manager;
pub mod pages;
pub mod ratelimit;
pub mod render;
pub mod sandbox;
pub mod spool;
pub mod supervisor;
pub mod tar_safe;
pub mod tiers;
pub mod worker;

pub use artifact::{ArtifactDir, ArtifactError, ArtifactStore, LocalArtifactStore, Manifest};
pub use cell::{Cell, CellKey};
pub use config::WorkerConfig;
pub use manager::{CellError, CellManager, DeploymentLookup, DeploymentMeta, ManagerConfig};
pub use tiers::{Tier, TierName, Tiers};
pub use worker::{Worker, WorkerError};
