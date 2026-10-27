//! `renox-cell` (P5): wires `renox-gateway`, `renox-runtime`, `renox-data`,
//! and `renox-meter` into one worker process, the `renox-worker` binary.
//! One cell = one tenant deployment's isolate on this node plus the tenant's
//! SQLite file (`docs/17-glossary.md`). See `README.md`.

pub mod artifact;
pub mod cell;
pub mod config;
pub mod manager;
pub mod tiers;
pub mod worker;

pub use artifact::{ArtifactDir, ArtifactError, ArtifactStore, LocalArtifactStore, Manifest};
pub use cell::{Cell, CellKey};
pub use config::WorkerConfig;
pub use manager::{CellError, CellManager, ManagerConfig};
pub use tiers::{Tier, TierName, Tiers};
pub use worker::{Worker, WorkerError};
