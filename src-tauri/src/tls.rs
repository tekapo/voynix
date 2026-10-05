//! Self-signed TLS identity for the LAN sync server.
//!
//! The Mac's LAN IP can change (Wi-Fi switch, DHCP lease renewal), so a
//! certificate can't durably bind identity to an IP SAN. Instead the *key
//! pair* is what's persisted; the leaf certificate is (cheaply) re-issued on
//! every server start with whatever IP is current, and Android pins the
//! SHA-256 of the key's SPKI (public key), not the certificate. That's what
//! lets a paired phone keep trusting the Mac across IP changes without a
//! re-pair.

use rcgen::{CertificateParams, KeyPair};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub struct TlsIdentity {
    pub config: Arc<rustls::ServerConfig>,
    /// SHA-256 of the certificate's SubjectPublicKeyInfo, as lowercase hex.
    /// Stable across restarts and IP changes as long as `key.pem` persists.
    pub fingerprint: String,
}

fn key_path(dir: &Path) -> PathBuf {
    dir.join("key.pem")
}

fn load_or_generate_keypair(dir: &Path) -> Result<KeyPair, String> {
    let path = key_path(dir);
    if let Ok(pem) = std::fs::read_to_string(&path) {
        if let Ok(kp) = KeyPair::from_pem(&pem) {
            return Ok(kp);
        }
        // Unreadable/corrupt key on disk: fall through and regenerate rather
        // than fail the whole server start.
    }
    let kp = KeyPair::generate().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    std::fs::write(&path, kp.serialize_pem()).map_err(|e| e.to_string())?;
    // Private key material: owner read/write only. `std::fs::write`'s default
    // mode is whatever the umask leaves (typically 0644), which would let any
    // other local user on the machine read it.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
    }
    Ok(kp)
}

fn spki_fingerprint(key_pair: &KeyPair) -> String {
    crate::util::sha256_hex(&key_pair.public_key_der())
}

/// Formats a fingerprint hex string for on-screen comparison, e.g.
/// `a1b2 c3d4 e5f6 0789` (first 16 hex chars, grouped by 4).
pub fn short_fingerprint(fingerprint: &str) -> String {
    fingerprint
        .as_bytes()
        .chunks(4)
        .take(4)
        .map(|c| std::str::from_utf8(c).unwrap_or(""))
        .collect::<Vec<_>>()
        .join(" ")
}

/// Loads the persisted key pair from `dir` (generating one on first run) and
/// issues a fresh self-signed leaf certificate for `ip`, valid for
/// `localhost` / `127.0.0.1` / `voynix.local` as well.
pub fn load_or_create(dir: &Path, ip: &str) -> Result<TlsIdentity, String> {
    // rustls 0.23 requires a crypto provider to be installed process-wide
    // before any ServerConfig is built. Installing twice returns Err, which
    // just means another caller (or an earlier server restart) already did
    // it — safe to ignore.
    let _ = rustls::crypto::ring::default_provider().install_default();

    let key_pair = load_or_generate_keypair(dir)?;
    let fingerprint = spki_fingerprint(&key_pair);

    let mut sans = vec!["localhost".to_string(), "127.0.0.1".to_string(), "voynix.local".to_string()];
    if !ip.is_empty() {
        sans.push(ip.to_string());
    }
    let params = CertificateParams::new(sans).map_err(|e| e.to_string())?;
    let cert = params.self_signed(&key_pair).map_err(|e| e.to_string())?;

    let cert_der = CertificateDer::from(cert.der().to_vec());
    let key_der =
        PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key_pair.serialize_der()));

    let config = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(vec![cert_der], key_der)
        .map_err(|e| e.to_string())?;

    Ok(TlsIdentity { config: Arc::new(config), fingerprint })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persists_the_key_so_the_fingerprint_survives_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let a = load_or_create(dir.path(), "192.168.1.10").unwrap();
        let b = load_or_create(dir.path(), "192.168.1.10").unwrap();
        assert_eq!(a.fingerprint, b.fingerprint);
    }

    #[test]
    fn fingerprint_is_stable_across_ip_changes() {
        let dir = tempfile::tempdir().unwrap();
        let a = load_or_create(dir.path(), "192.168.1.10").unwrap();
        let b = load_or_create(dir.path(), "10.0.0.5").unwrap();
        assert_eq!(a.fingerprint, b.fingerprint);
    }

    #[test]
    fn different_key_dirs_get_different_fingerprints() {
        let dir_a = tempfile::tempdir().unwrap();
        let dir_b = tempfile::tempdir().unwrap();
        let a = load_or_create(dir_a.path(), "192.168.1.10").unwrap();
        let b = load_or_create(dir_b.path(), "192.168.1.10").unwrap();
        assert_ne!(a.fingerprint, b.fingerprint);
    }

    #[test]
    fn fingerprint_is_64_lowercase_hex_chars() {
        let dir = tempfile::tempdir().unwrap();
        let id = load_or_create(dir.path(), "192.168.1.10").unwrap();
        assert_eq!(id.fingerprint.len(), 64);
        assert!(id.fingerprint.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    }

    #[test]
    #[cfg(unix)]
    fn key_file_is_written_owner_read_write_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        load_or_create(dir.path(), "192.168.1.10").unwrap();
        let mode = std::fs::metadata(key_path(dir.path())).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn short_fingerprint_groups_the_first_16_chars_by_4() {
        let fp = "a1b2c3d4e5f60789aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        assert_eq!(short_fingerprint(fp), "a1b2 c3d4 e5f6 0789");
    }
}
