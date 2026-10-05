import Database from "@tauri-apps/plugin-sql";

async function columnExists(db: Database, table: string, column: string): Promise<boolean> {
    const rows: any[] = await db.select(`PRAGMA table_info(${table})`);
    return rows.some(r => r.name === column);
}

async function addColumn(db: Database, table: string, column: string, def: string) {
    if (!(await columnExists(db, table, column))) {
        await db.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
    }
}

// Ordered list of migrations. Index i brings the schema from version i to i+1.
// Never edit an existing entry once shipped — append a new one.
export const MIGRATIONS: Array<(db: Database) => Promise<void>> = [
    // 1: base schema (matches the pre-migration CREATE IF NOT EXISTS setup)
    async (db) => {
        await db.execute(`
      CREATE TABLE IF NOT EXISTS tracks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        artist TEXT,
        album TEXT,
        file_path TEXT UNIQUE NOT NULL,
        file_name TEXT NOT NULL,
        duration REAL,
        lyrics TEXT
      );
    `);
        await db.execute(`
      CREATE TABLE IF NOT EXISTS playlists (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL
      );
    `);
        await db.execute(`
      CREATE TABLE IF NOT EXISTS playlist_tracks (
        playlist_id TEXT NOT NULL,
        track_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        PRIMARY KEY (playlist_id, track_id),
        FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
        FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
      );
    `);
        await db.execute(`
      CREATE TABLE IF NOT EXISTS scan_folders (
        path TEXT PRIMARY KEY,
        playlist_id TEXT,
        added_at INTEGER NOT NULL,
        FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE SET NULL
      );
    `);
    },

    // 2: sync foundations (cross-device identity, stats, pairing)
    async (db) => {
        await addColumn(db, "tracks", "track_key", "TEXT");
        await addColumn(db, "tracks", "content_hash", "TEXT");
        await addColumn(db, "tracks", "favorite", "INTEGER NOT NULL DEFAULT 0");
        await addColumn(db, "tracks", "favorite_updated_at", "INTEGER");
        // origin: 'local' (scanned/imported here) | 'mirror' (received from a sync peer)
        await addColumn(db, "tracks", "origin", "TEXT NOT NULL DEFAULT 'local'");
        await addColumn(db, "playlists", "sync_to_device", "INTEGER NOT NULL DEFAULT 0");

        await db.execute("CREATE INDEX IF NOT EXISTS idx_tracks_track_key ON tracks(track_key)");

        await db.execute(`
      CREATE TABLE IF NOT EXISTS play_events (
        id TEXT PRIMARY KEY,
        track_key TEXT NOT NULL,
        played_at INTEGER NOT NULL,
        device_id TEXT NOT NULL
      );
    `);
        await db.execute("CREATE INDEX IF NOT EXISTS idx_play_events_key ON play_events(track_key)");
        await db.execute("CREATE INDEX IF NOT EXISTS idx_play_events_device ON play_events(device_id, played_at)");

        await db.execute(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

        await db.execute(`
      CREATE TABLE IF NOT EXISTS content_hash_cache (
        file_path TEXT PRIMARY KEY,
        size INTEGER NOT NULL,
        mtime INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        track_key TEXT NOT NULL
      );
    `);

        await db.execute(`
      CREATE TABLE IF NOT EXISTS sync_peers (
        peer_device_id TEXT PRIMARY KEY,
        peer_url TEXT NOT NULL,
        token TEXT NOT NULL,
        last_sync_at INTEGER,
        events_watermark INTEGER NOT NULL DEFAULT 0,
        last_manifest_hash TEXT
      );
    `);
    },

    // 3: dedup key for play_events so merging a peer's events is idempotent
    async (db) => {
        await db.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_play_events_dedup ON play_events(device_id, played_at, track_key)"
        );
    },

    // 4: per-file kind ('music'|'podcast'|'other') + podcast playback state.
    // The *_updated_at columns are LWW timestamps (mirrors favorite_updated_at)
    // and both kind and play_state ride sync on that basis.
    async (db) => {
        await addColumn(db, "tracks", "kind", "TEXT NOT NULL DEFAULT 'music'");
        await addColumn(db, "tracks", "kind_updated_at", "INTEGER");
        await addColumn(db, "tracks", "play_state", "TEXT NOT NULL DEFAULT 'unplayed'");
        await addColumn(db, "tracks", "resume_position", "REAL NOT NULL DEFAULT 0");
        await addColumn(db, "tracks", "play_state_updated_at", "INTEGER");
        await addColumn(db, "scan_folders", "default_kind", "TEXT NOT NULL DEFAULT 'music'");
    },

    // 5: disc / track numbers from the file's tags, for the natural album order.
    // Backfilled at startup (see backfillTrackNumbers / backfillTrackIdentities) —
    // the ORDER BY in getPlaylists COALESCEs missing values to the end of the album.
    async (db) => {
        await addColumn(db, "tracks", "disc_no", "INTEGER");
        await addColumn(db, "tracks", "track_no", "INTEGER");
    },

    // 6: per-playlist kind. Marking a whole playlist Podcast bulk-reclassifies
    // its current tracks and is re-applied to newly added tracks (mirrors the
    // scan_folders.default_kind behaviour). Rides sync so a paired device shows
    // the same label.
    async (db) => {
        await addColumn(db, "playlists", "kind", "TEXT NOT NULL DEFAULT 'music'");
    },

    // 7: per-album cover overrides. Non-destructive (never touches a file's own
    // tags, unlike set_track_artwork). Keyed by (artist, album) — same pairing
    // `fetch_album_art`/`get_album_thumb` already hash together in metadata.rs —
    // NOT album name alone: two different artists' self-titled albums, or two
    // artists' untagged tracks both falling back to "Unknown Album", would
    // otherwise collide onto one row and visibly "share" a cover. Values are
    // normalized (trim + lowercase) by albumCoverKey() before every read/write.
    // LWW via updated_at, same convention as favorite_updated_at, so it rides
    // the existing sync manifest.
    async (db) => {
        await db.execute(`
      CREATE TABLE IF NOT EXISTS album_covers (
        artist TEXT NOT NULL,
        album TEXT NOT NULL,
        image_data_uri TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (artist, album)
      );
    `);
    },

    // 8: migration 7 shipped album_covers keyed by album name only, which let
    // two different artists' same-named (or both-untagged) albums collide
    // onto one cover. Editing migration 7's body in place (an earlier
    // revision of this file did exactly that) doesn't reach installs that
    // already ran it — PRAGMA user_version skips migrations below the stored
    // version — so this appends the real fix: rebuild the table keyed by
    // (artist, album). album_covers only holds user-chosen overrides (cheap
    // to re-set), so a clean rebuild is simpler and safer than trying to
    // ALTER a composite PRIMARY KEY into place. A no-op rebuild for installs
    // that already got the new schema straight from migration 7.
    async (db) => {
        await db.execute("DROP TABLE IF EXISTS album_covers");
        await db.execute(`
      CREATE TABLE IF NOT EXISTS album_covers (
        artist TEXT NOT NULL,
        album TEXT NOT NULL,
        image_data_uri TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (artist, album)
      );
    `);
    },

    // 9: manual track ordering (drag & drop in the track list, e.g. a Podcast
    // playlist). A folder playlist otherwise always renders in NATURAL_ORDER
    // (see playlistOrderBy below); this flag opts a specific playlist out of
    // that once the user has hand-arranged it. setPlaylistTrackOrder() sets it,
    // resetPlaylistManualOrder() clears it. Non-folder playlists already order
    // by position and ignore this flag.
    async (db) => {
        await addColumn(db, "playlists", "manual_order", "INTEGER NOT NULL DEFAULT 0");
    },

    // 10: per-artist image overrides for the Artists grid (analogous to
    // album_covers, see migration 8's comment for why (artist, album) needs a
    // composite key — an artist name alone has no such collision risk, so a
    // single normalized TEXT primary key is enough here). Mac-only for now:
    // deliberately not part of SyncSnapshot, so it doesn't ride sync to Android.
    async (db) => {
        await db.execute(`
      CREATE TABLE IF NOT EXISTS artist_covers (
        artist TEXT PRIMARY KEY,
        image_data_uri TEXT,
        updated_at INTEGER NOT NULL
      );
    `);
    },

    // 11: "Recently Added" smart playlist needs a per-track add date, which
    // nothing tracked before this. addTracksToPlaylist() now stamps new rows
    // with Date.now(); existing rows are backfilled here from
    // content_hash_cache.mtime (seconds -> ms) as a best-effort approximation
    // of when the file was scanned. Rows with no cache entry (never hashed,
    // or the cache was cleared) are left NULL and simply don't appear in
    // Recently Added — better than a fabricated date that would sort them to
    // the top or bottom of the list. Rides sync (see SnapshotTrack.added_at)
    // so Android shows the same ordering.
    async (db) => {
        await addColumn(db, "tracks", "added_at", "INTEGER");
        await db.execute(`
      UPDATE tracks SET added_at = (
        SELECT c.mtime * 1000 FROM content_hash_cache c WHERE c.file_path = tracks.file_path
      ) WHERE added_at IS NULL
    `);
    },

    // 12: smart playlists. `tracks` gets the four tag fields rule conditions
    // can match on (read at scan time, see Rust's TagSummary) plus
    // extra_tags_read so backfillExtraTags() can tell "no such tag" apart
    // from "never read" for rows scanned before this migration. `playlists`
    // gets a `rules` JSON column (see smartPlaylist.ts's SmartRules) —
    // NULL for every playlist type except 'smart'.
    async (db) => {
        await addColumn(db, "tracks", "genre", "TEXT");
        await addColumn(db, "tracks", "year", "INTEGER");
        await addColumn(db, "tracks", "album_artist", "TEXT");
        await addColumn(db, "tracks", "composer", "TEXT");
        await addColumn(db, "tracks", "extra_tags_read", "INTEGER NOT NULL DEFAULT 0");
        await addColumn(db, "playlists", "rules", "TEXT");
    },
];
