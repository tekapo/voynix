//! Small helpers with no state and no app-specific types, shared across
//! modules that would otherwise each write their own copy.

use sha2::{Digest, Sha256};

/// SHA-256 of `bytes`, as lowercase hex. Used for content hashes, cache keys
/// and track keys throughout — pulled out because `format!("{:x}", ...)` on
/// a `Sha256` digest was written out separately in four places.
pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// Whether an `Authorization` header value is `Bearer <token>` for exactly
/// `token`. `ConstantTimeEq` still short-circuits on a length mismatch (that
/// only leaks the token's length, not its content), then compares in time
/// independent of *where* the bytes differ. An empty `token` never matches.
/// Shared by the LAN sync server and the remote API.
pub(crate) fn bearer_matches(header_value: Option<&str>, token: &str) -> bool {
    use subtle::ConstantTimeEq;
    match header_value.and_then(|s| s.strip_prefix("Bearer ")) {
        Some(p) => {
            !token.is_empty() && p.len() == token.len() && bool::from(p.as_bytes().ct_eq(token.as_bytes()))
        }
        None => false,
    }
}

/// Folds a free-text field (artist/album/title, …) so cosmetic differences —
/// case, leading/trailing space, doubled internal space — collapse to the
/// same value before it's hashed into an identity or cache key. Shared by
/// `compute_track_key` (cross-device track identity, lib.rs) and
/// `metadata::cache_key` (local album-art/lyrics cache key) — these used to
/// be two near-identical copies that quietly disagreed on internal
/// whitespace.
pub(crate) fn normalize_field(s: &str) -> String {
    s.trim().to_lowercase().split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_a_known_sha256_vector() {
        // echo -n "" | shasum -a 256
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn differs_for_different_input() {
        assert_ne!(sha256_hex(b"a"), sha256_hex(b"b"));
    }

    #[test]
    fn bearer_matches_only_the_exact_token() {
        assert!(bearer_matches(Some("Bearer secret"), "secret"));
        assert!(!bearer_matches(Some("Bearer secreT"), "secret"));
        assert!(!bearer_matches(Some("Bearer secret2"), "secret"));
        assert!(!bearer_matches(Some("secret"), "secret"));
        assert!(!bearer_matches(None, "secret"));
        assert!(!bearer_matches(Some("Bearer "), ""));
    }

    #[test]
    fn normalize_field_collapses_case_and_whitespace() {
        assert_eq!(normalize_field("  The   Beatles "), "the beatles");
        assert_eq!(normalize_field("ABBEY ROAD"), "abbey road");
        assert_eq!(normalize_field(""), "");
    }
}
