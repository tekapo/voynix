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

/// Whether the TLS key fingerprint a client says it saw in its handshake
/// equals this server's own. A client talking to a relay sees the relay's key,
/// so a mismatch (or a missing claim) means the connection isn't end-to-end.
/// Case-insensitive on the claim (hex), constant time on the comparison, and
/// an empty `expected` never matches.
pub(crate) fn fingerprint_matches(claimed: Option<&str>, expected: &str) -> bool {
    use subtle::ConstantTimeEq;
    match claimed {
        Some(c) => {
            let c = c.trim().to_ascii_lowercase();
            !expected.is_empty() && c.len() == expected.len() && bool::from(c.as_bytes().ct_eq(expected.as_bytes()))
        }
        None => false,
    }
}

/// Folds a free-text field (artist/album/title, …) so cosmetic differences —
/// case, leading/trailing space, doubled internal space — collapse to the
/// same value before it's hashed into an identity or cache key. Shared by
/// `compute_track_key` (cross-device track identity, identity.rs) and
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
    fn fingerprint_matches_only_the_servers_own_fingerprint() {
        let fp = "ab12".repeat(16);
        assert!(fingerprint_matches(Some(&fp), &fp));
        assert!(fingerprint_matches(Some(&fp.to_uppercase()), &fp), "hex case must not matter");
        assert!(!fingerprint_matches(Some(&"cd34".repeat(16)), &fp), "a relay's key differs");
        assert!(!fingerprint_matches(Some("ab12"), &fp), "a prefix is not a match");
        assert!(!fingerprint_matches(None, &fp), "a stripped claim must not pass");
        assert!(!fingerprint_matches(Some(""), ""), "an unset server fingerprint never matches");
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
