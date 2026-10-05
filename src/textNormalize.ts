// Shared text normalization for anything that compares free-text against a
// user-typed query: the header search box (search.ts) and smart playlist text
// conditions (smartPlaylist.ts). Pulled out so both fold full-width/half-width
// variants (NFKC) the same way — before this, only smartPlaylist.ts did, so
// e.g. a full-width "ｱ" typed in the search box wouldn't match a half-width
// "ア" in a tag even though the exact same "contains" rule in a smart
// playlist would. See android-native's Search.kt for the same normalization,
// kept in step by hand (no shared runtime between Kotlin and TS).
export function normalizeText(s: string): string {
    return s.normalize('NFKC').trim().toLowerCase();
}
