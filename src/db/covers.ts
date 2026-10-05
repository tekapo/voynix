import { getDb } from "./core";
import { batchExecute } from "./batch";

// ---- Album covers ----------------------------------------------------------
// Non-destructive per-album cover overrides: takes priority over embedded
// artwork / the iTunes lookup (see albumArt.ts's resolve() and App.tsx's
// now-playing artwork effect) without ever writing to a music file's own tags.

export interface AlbumCover {
    artist: string;
    album: string;
    image_data_uri: string | null;
    updated_at: number;
}

/**
 * Normalize the way `fetch_album_art`/`get_album_thumb` already do (see
 * `cache_key` in metadata.rs): trim + lowercase, and fall back to
 * "Unknown Album" so an untagged track's cover matches what the Albums view
 * shows it under. Two different artists never collide (unlike keying on
 * album name alone) unless *both* their artist and album are blank.
 */
function albumCoverKey(artist: string, album: string): { artist: string; album: string } {
    return {
        artist: (artist || "").trim().toLowerCase(),
        album: (album || "Unknown Album").trim().toLowerCase(),
    };
}

export async function getAlbumCover(artist: string, album: string): Promise<string | null> {
    const db = await getDb();
    const key = albumCoverKey(artist, album);
    const rows: any[] = await db.select(
        "SELECT image_data_uri FROM album_covers WHERE artist = $1 AND album = $2",
        [key.artist, key.album]
    );
    return rows[0]?.image_data_uri ?? null;
}

/** Set (or, with `null`, clear) the cover override for an (artist, album) pair. */
export async function setAlbumCover(artist: string, album: string, imageDataUri: string | null) {
    const db = await getDb();
    const key = albumCoverKey(artist, album);
    await db.execute(
        `INSERT INTO album_covers (artist, album, image_data_uri, updated_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT(artist, album) DO UPDATE SET image_data_uri = excluded.image_data_uri, updated_at = excluded.updated_at`,
        [key.artist, key.album, imageDataUri, Date.now()]
    );
}

/** Keys of every album-cover row (including cleared `null` ones), as "artist\u0000album". */
export async function getAlbumCoverKeys(): Promise<Set<string>> {
    const db = await getDb();
    const rows: { artist: string; album: string }[] = await db.select("SELECT artist, album FROM album_covers");
    return new Set(rows.map(r => `${r.artist}\u0000${r.album}`));
}

export async function getAllAlbumCovers(): Promise<AlbumCover[]> {
    const db = await getDb();
    return db.select("SELECT artist, album, image_data_uri, updated_at FROM album_covers");
}

/** Merge a peer's album-cover overrides by LWW (same convention as favorites/play_state). */
export async function applyAlbumCovers(covers: AlbumCover[], onChunk?: (done: number, total: number) => void) {
    const db = await getDb();
    await batchExecute(db, {
        rows: covers,
        cols: 4,
        // Small chunk size: unlike the other batches here, the binding
        // constraint is bound-parameter payload size (image_data_uri is a
        // base64 data URI, tens to hundreds of KB each), not the 999-param count.
        perChunk: 20,
        // Peer rows already carry normalized (lowercased/trimmed) keys — they
        // came from this same function on the other device.
        toParams: c => [c.artist, c.album, c.image_data_uri, c.updated_at],
        sql: tuples => `
            INSERT INTO album_covers (artist, album, image_data_uri, updated_at) VALUES ${tuples}
            ON CONFLICT(artist, album) DO UPDATE SET
              image_data_uri = excluded.image_data_uri, updated_at = excluded.updated_at
            WHERE excluded.updated_at > album_covers.updated_at`,
        onChunk,
    });
}

// ---- Artist images ----------------------------------------------------------
// Non-destructive per-artist image overrides for the Artists grid, same
// override-always-wins convention as album_covers (see albumArt.ts /
// artistArt.ts). Synced to Android read-only (Android never writes this
// table, so the LWW guard in applyArtistCovers is defensive symmetry with
// applyAlbumCovers rather than something that can currently lose a race).

function artistCoverKey(artist: string): string {
    return (artist || "Unknown Artist").trim().toLowerCase();
}

export async function getArtistCover(artist: string): Promise<string | null> {
    const db = await getDb();
    const rows: any[] = await db.select(
        "SELECT image_data_uri FROM artist_covers WHERE artist = $1",
        [artistCoverKey(artist)]
    );
    return rows[0]?.image_data_uri ?? null;
}

/** Set (or, with `null`, clear) the image override for an artist. */
export async function setArtistCover(artist: string, imageDataUri: string | null) {
    const db = await getDb();
    const key = artistCoverKey(artist);
    await db.execute(
        `INSERT INTO artist_covers (artist, image_data_uri, updated_at) VALUES ($1, $2, $3)
         ON CONFLICT(artist) DO UPDATE SET image_data_uri = excluded.image_data_uri, updated_at = excluded.updated_at`,
        [key, imageDataUri, Date.now()]
    );
}

export interface ArtistCover {
    artist: string;
    image_data_uri: string | null;
    updated_at: number;
}

export async function getAllArtistCovers(): Promise<ArtistCover[]> {
    const db = await getDb();
    return db.select("SELECT artist, image_data_uri, updated_at FROM artist_covers");
}

/** Artists that already have a cover override set (any value, including a cleared `null`). */
export async function getArtistCoverKeys(): Promise<Set<string>> {
    const db = await getDb();
    const rows: { artist: string }[] = await db.select("SELECT artist FROM artist_covers");
    return new Set(rows.map(r => r.artist));
}

/** Merge a peer's artist-image overrides by LWW (same convention as applyAlbumCovers). */
export async function applyArtistCovers(covers: ArtistCover[], onChunk?: (done: number, total: number) => void) {
    const db = await getDb();
    await batchExecute(db, {
        rows: covers,
        cols: 3,
        perChunk: 20,
        toParams: c => [c.artist, c.image_data_uri, c.updated_at],
        sql: tuples => `
            INSERT INTO artist_covers (artist, image_data_uri, updated_at) VALUES ${tuples}
            ON CONFLICT(artist) DO UPDATE SET
              image_data_uri = excluded.image_data_uri, updated_at = excluded.updated_at
            WHERE excluded.updated_at > artist_covers.updated_at`,
        onChunk,
    });
}
