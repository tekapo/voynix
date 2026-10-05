import { Track } from "./types";

/** Display fallback for a track with no `artist` tag. */
export const UNKNOWN_ARTIST = "Unknown Artist";

/** The artist to display for a track: its own tag, or `UNKNOWN_ARTIST`.
 *  See `effectiveAlbum` in albumName.ts for the album-side equivalent
 *  (which additionally falls back to a folder name — there's no such
 *  fallback for artist). */
export function artistOf(track: Pick<Track, "artist">): string {
    return track.artist || UNKNOWN_ARTIST;
}

/** Display label for a track's artist: like `artistOf`, but translates the
 *  `UNKNOWN_ARTIST` fallback for the UI. `artistOf` itself must stay
 *  language-independent — its value is used as a filter key and persisted
 *  in `last_view_filter` (see db/settings.ts). */
export function artistLabel(track: Pick<Track, "artist">, t: (key: "common.unknownArtist") => string): string {
    const artist = artistOf(track);
    return artist === UNKNOWN_ARTIST ? t("common.unknownArtist") : artist;
}
