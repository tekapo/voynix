//! Small helpers with no state and no app-specific types, shared across
//! modules that would otherwise each write their own copy.

use sha2::{Digest, Sha256};

/// SHA-256 of `bytes`, as lowercase hex. Used for content hashes, cache keys
/// and track keys throughout — pulled out because `format!("{:x}", ...)` on
/// a `Sha256` digest was written out separately in four places.
pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
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
    fn normalize_field_collapses_case_and_whitespace() {
        assert_eq!(normalize_field("  The   Beatles "), "the beatles");
        assert_eq!(normalize_field("ABBEY ROAD"), "abbey road");
        assert_eq!(normalize_field(""), "");
    }
}
