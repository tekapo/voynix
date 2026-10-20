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
use rustls::pki_types::pem::PemObject;
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

/// Builds a server config from a PEM certificate chain and private key the user
/// supplies (e.g. Let's Encrypt's `fullchain.pem` / `privkey.pem`). Unlike the
/// self-signed identity above, a public CA certificate is what lets an Echo
/// accept the server, so the chain must include the intermediate certificate.
pub fn load_pem(cert_path: &Path, key_path: &Path) -> Result<Arc<rustls::ServerConfig>, String> {
    let _ = rustls::crypto::ring::default_provider().install_default();

    let certs = CertificateDer::pem_file_iter(cert_path)
        .map_err(|e| format!("Could not read the certificate {}: {e}", cert_path.display()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Invalid certificate {}: {e}", cert_path.display()))?;
    if certs.is_empty() {
        return Err(format!("No certificate found in {}", cert_path.display()));
    }
    let key = PrivateKeyDer::from_pem_file(key_path)
        .map_err(|e| format!("Could not read the private key {}: {e}", key_path.display()))?;

    let config = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .map_err(|e| format!("Certificate and key don't match: {e}"))?;
    Ok(Arc::new(config))
}

/// How often `current()` looks at the files: renewals happen every ~60 days, so
/// a few seconds' delay is invisible, and the common case stays free of file I/O.
const RELOAD_CHECK_INTERVAL: std::time::Duration = std::time::Duration::from_secs(5);

/// A TLS acceptor over user-supplied PEM files that picks up a renewed
/// certificate (`lego renew` rewrites the files every ~60 days) without an app
/// restart. At most once per interval, `current()` compares the files' mtimes and
/// sizes with the ones last loaded and reloads on a difference. A reload that
/// fails (a half-written file) keeps serving the previous certificate and is
/// retried at the next check, because the "loaded" stamp is only advanced by a
/// successful load.
pub struct ReloadingAcceptor {
    cert_path: PathBuf,
    key_path: PathBuf,
    interval: std::time::Duration,
    state: std::sync::Mutex<ReloadState>,
}

struct ReloadState {
    /// Stamp of the files the current acceptor was built from.
    loaded: Stamp,
    checked: std::time::Instant,
    acceptor: tokio_rustls::TlsAcceptor,
}

/// (mtime, size) of the certificate and of the key. The size catches a rewrite
/// that lands within the same mtime tick.
type Stamp = [(Option<std::time::SystemTime>, Option<u64>); 2];

impl ReloadingAcceptor {
    pub fn new(cert_path: PathBuf, key_path: PathBuf) -> Result<Self, String> {
        Self::with_interval(cert_path, key_path, RELOAD_CHECK_INTERVAL)
    }

    fn with_interval(cert_path: PathBuf, key_path: PathBuf, interval: std::time::Duration) -> Result<Self, String> {
        // Stamp first: if the file changes between this and the load below, the
        // next check sees a difference and reloads once more, never the reverse.
        let loaded = stamp_of(&cert_path, &key_path);
        let acceptor = tokio_rustls::TlsAcceptor::from(load_pem(&cert_path, &key_path)?);
        let state = ReloadState { loaded, checked: std::time::Instant::now(), acceptor };
        Ok(Self { cert_path, key_path, interval, state: std::sync::Mutex::new(state) })
    }

    pub fn current(&self) -> tokio_rustls::TlsAcceptor {
        let mut state = self.state.lock().unwrap();
        if state.checked.elapsed() >= self.interval {
            state.checked = std::time::Instant::now();
            let stamp = stamp_of(&self.cert_path, &self.key_path);
            if stamp != state.loaded {
                match load_pem(&self.cert_path, &self.key_path) {
                    Ok(config) => {
                        state.acceptor = tokio_rustls::TlsAcceptor::from(config);
                        state.loaded = stamp;
                    }
                    Err(e) => eprintln!("TLS reload failed, keeping the previous certificate: {e}"),
                }
            }
        }
        state.acceptor.clone()
    }
}

fn stamp_of(cert: &Path, key: &Path) -> Stamp {
    let one = |p: &Path| match std::fs::metadata(p) {
        Ok(m) => (m.modified().ok(), Some(m.len())),
        Err(_) => (None, None),
    };
    [one(cert), one(key)]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_self_signed(dir: &Path, name: &str) -> (PathBuf, PathBuf) {
        let key_pair = KeyPair::generate().unwrap();
        let cert = CertificateParams::new(vec![name.to_string()]).unwrap().self_signed(&key_pair).unwrap();
        let (cert_path, key_path) = (dir.join("fullchain.pem"), dir.join("privkey.pem"));
        std::fs::write(&cert_path, cert.pem()).unwrap();
        std::fs::write(&key_path, key_pair.serialize_pem()).unwrap();
        (cert_path, key_path)
    }

    #[test]
    fn loads_a_pem_chain_and_rejects_missing_or_mismatched_files() {
        let dir = tempfile::tempdir().unwrap();
        let (cert, key) = write_self_signed(dir.path(), "echo.example.org");
        assert!(load_pem(&cert, &key).is_ok());
        assert!(load_pem(&dir.path().join("nope.pem"), &key).is_err());
        assert!(load_pem(&cert, &dir.path().join("nope.pem")).is_err());

        let other = tempfile::tempdir().unwrap();
        let (_, other_key) = write_self_signed(other.path(), "other.example.org");
        assert!(load_pem(&cert, &other_key).is_err(), "a key that doesn't match the certificate");

        let empty = dir.path().join("empty.pem");
        std::fs::write(&empty, "").unwrap();
        assert!(load_pem(&empty, &key).is_err());
    }

    #[test]
    fn reloads_a_renewed_certificate_and_keeps_serving_through_a_broken_one() {
        let dir = tempfile::tempdir().unwrap();
        let (cert, key) = write_self_signed(dir.path(), "echo.example.org");
        // A zero interval makes every call check the files.
        let reloading = ReloadingAcceptor::with_interval(cert.clone(), key.clone(), std::time::Duration::ZERO).unwrap();
        let original = reloading.current().config().clone();
        assert!(Arc::ptr_eq(&original, &reloading.current().config().clone()), "unchanged files: same config");

        // A half-written file: the previous certificate keeps serving …
        std::fs::write(&cert, "not a certificate").unwrap();
        assert!(Arc::ptr_eq(&original, &reloading.current().config().clone()));
        assert!(Arc::ptr_eq(&original, &reloading.current().config().clone()), "and the failed load is retried, not forgotten");

        // … even if the rewrite finishes within the same mtime tick: the content
        // is what changed, and the failure didn't pin the stamp.
        let before = std::fs::metadata(&cert).unwrap().modified().unwrap();
        let (new_cert, new_key) = write_self_signed(dir.path(), "echo.example.org");
        assert_eq!((&new_cert, &new_key), (&cert, &key));
        std::fs::File::options().write(true).open(&cert).unwrap().set_modified(before).unwrap();
        let renewed = reloading.current().config().clone();
        assert!(!Arc::ptr_eq(&original, &renewed), "the renewed certificate was loaded");
        assert!(Arc::ptr_eq(&renewed, &reloading.current().config().clone()), "and then left alone");
    }

    #[test]
    fn checks_the_files_at_most_once_per_interval() {
        let dir = tempfile::tempdir().unwrap();
        let (cert, key) = write_self_signed(dir.path(), "echo.example.org");
        let reloading = ReloadingAcceptor::with_interval(cert.clone(), key.clone(), std::time::Duration::from_secs(3600)).unwrap();
        let original = reloading.current().config().clone();
        write_self_signed(dir.path(), "echo.example.org");
        assert!(Arc::ptr_eq(&original, &reloading.current().config().clone()), "not looked at yet");
    }

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
