//! Signing keys for page sessions and CSRF tokens (`docs/contracts/ops.md`
//! section 14, "Session"; gate F1 note on #41).
//!
//! The node holds one platform key (`worker.toml platform_key_file`, mode
//! 0600, at least 32 bytes). Each tenant gets its own key derived from it
//! with HKDF-SHA256, so a cookie signed for one tenant never verifies for
//! another, and no key ever reaches an isolate. Until F3 delivers the node
//! key (#54, #55), a worker without the file uses a random key per process:
//! sessions then end when the process restarts.

use std::path::Path;

use hkdf::Hkdf;
use sha2::Sha256;

/// HKDF salt: versions the derivation, so a future scheme cannot collide.
const SALT: &[u8] = b"renox-pages-v1";
/// The shortest platform key accepted.
pub const MIN_KEY_BYTES: usize = 32;

/// The node's platform key.
#[derive(Clone)]
pub struct PlatformKey {
    ikm: Vec<u8>,
}

impl std::fmt::Debug for PlatformKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("PlatformKey([redacted])")
    }
}

/// Why the platform key file was refused. Never contains key bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyError {
    Read(String),
    /// Readable by group or others.
    Permissions(u32),
    TooShort(usize),
}

impl std::fmt::Display for KeyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            KeyError::Read(e) => write!(f, "platform key file cannot be read: {e}"),
            KeyError::Permissions(m) => {
                write!(f, "platform key file has mode {m:o}; it must be 0600")
            }
            KeyError::TooShort(n) => write!(
                f,
                "platform key file has {n} bytes; at least {MIN_KEY_BYTES} are needed"
            ),
        }
    }
}

impl std::error::Error for KeyError {}

impl PlatformKey {
    /// A key from bytes (tests, and F3's node key).
    pub fn from_bytes(bytes: &[u8]) -> Result<PlatformKey, KeyError> {
        if bytes.len() < MIN_KEY_BYTES {
            return Err(KeyError::TooShort(bytes.len()));
        }
        Ok(PlatformKey {
            ikm: bytes.to_vec(),
        })
    }

    /// A fresh random key, for a worker without a key file.
    pub fn random() -> PlatformKey {
        let mut ikm = vec![0u8; 32];
        getrandom::fill(&mut ikm).expect("the OS random source is available");
        PlatformKey { ikm }
    }

    /// Reads the key file; refused when group or others can read it.
    pub fn load(path: &Path) -> Result<PlatformKey, KeyError> {
        let meta = std::fs::metadata(path).map_err(|e| KeyError::Read(e.kind().to_string()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = meta.permissions().mode() & 0o777;
            if mode & 0o077 != 0 {
                return Err(KeyError::Permissions(mode));
            }
        }
        #[cfg(not(unix))]
        let _ = meta;
        let bytes = std::fs::read(path).map_err(|e| KeyError::Read(e.kind().to_string()))?;
        PlatformKey::from_bytes(&bytes)
    }

    /// The tenant's page key: HKDF-SHA256(salt, platform key, tenant id).
    pub fn tenant_key(&self, tenant_id: &str) -> [u8; 32] {
        let hk = Hkdf::<Sha256>::new(Some(SALT), &self.ikm);
        let mut out = [0u8; 32];
        hk.expand(tenant_id.as_bytes(), &mut out)
            .expect("32 bytes is a valid HKDF-SHA256 output length");
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tenants_get_different_keys() {
        let k = PlatformKey::from_bytes(&[7u8; 32]).unwrap();
        assert_ne!(k.tenant_key("t_a"), k.tenant_key("t_b"));
        assert_eq!(k.tenant_key("t_a"), k.tenant_key("t_a"));
        assert_eq!(
            PlatformKey::from_bytes(&[1u8; 8]).err(),
            Some(KeyError::TooShort(8))
        );
        assert!(!format!("{k:?}").contains('7'));
    }

    #[cfg(unix)]
    #[test]
    fn key_file_must_be_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("renox-key-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("platform.key");
        std::fs::write(&path, [9u8; 32]).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(
            PlatformKey::load(&path).err(),
            Some(KeyError::Permissions(0o644))
        );
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(PlatformKey::load(&path).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
