import type { PlayState, TrackKind } from './playback';

export type { PlayState, TrackKind } from './playback';

export interface Track {
  id: string;
  title: string;
  artist?: string;
  album?: string;
  file_path: string;
  file_name: string;
  duration?: number;
  lyrics?: string;
  /** Disc / track numbers from the file's tags, for the natural album order. */
  disc_no?: number | null;
  track_no?: number | null;
  /** 'music' | 'podcast' | 'other'. Defaults to 'music'. */
  kind?: TrackKind;
  kind_updated_at?: number;
  /** Podcast only: 'unplayed' | 'in_progress' | 'played'. */
  play_state?: PlayState;
  /** Podcast only: seconds to resume from. */
  resume_position?: number;
  play_state_updated_at?: number;
  /** Stable identity of "the same song" across devices (hash of normalized tags). */
  track_key?: string;
  /** Cheap fingerprint of the file bytes; changes when the file is replaced/retagged. */
  content_hash?: string;
  /** 0 | 1 */
  favorite?: number;
  favorite_updated_at?: number;
  /** Derived from play_events (not stored on the row). */
  play_count?: number;
  /** Derived from play_events (not stored on the row); ms epoch of the most recent play, or undefined if never played. */
  last_played?: number | null;
  /** ms epoch this row was first added to a playlist (migration 11+); null for pre-migration rows with no content_hash_cache entry to backfill from. */
  added_at?: number | null;
  /** Smart-playlist fields (migration 12+), read from the file's tags at scan time. Null when the tag has no such field (or hasn't been read yet — see extra_tags_read). */
  genre?: string | null;
  year?: number | null;
  album_artist?: string | null;
  composer?: string | null;
  /** 0 | 1 — whether genre/year/album_artist/composer were actually read from this row's file. See backfillExtraTags(). */
  extra_tags_read?: number;
}

export interface TrackIdentity {
  track_key: string;
  content_hash: string;
}

export interface HashCacheEntry {
  file_path: string;
  size: number;
  mtime: number;
  content_hash: string;
  track_key: string;
}

export interface ScanResult {
  tracks: Track[];
  scanned_path: string;
  /** Refreshed content_hash_cache rows to persist; feed back on the next scan. */
  hash_cache: HashCacheEntry[];
  /** User hit Cancel before the walk finished — `tracks` is partial, discard it. */
  cancelled: boolean;
  /** Cloud-only placeholder files registered with filename-only metadata. */
  skipped_cloud: number;
}

export interface ScanFolder {
  path: string;
  playlist_id: string | null;
  /** Kind assigned to tracks scanned from this folder. Defaults to 'music'. */
  default_kind?: TrackKind;
}

export interface Playlist {
  id: string;
  name: string;
  tracks: Track[];
  type: 'folder' | 'xml' | 'custom' | 'mirror' | 'smart';
  /** 0 | 1 — mirror this playlist and its files to paired devices. */
  sync_to_device?: number;
  /** 'music' | 'podcast' | 'other' — applied to every track in the playlist. Defaults to 'music'. */
  kind?: TrackKind;
  /** 0 | 1 — user has drag-reordered this playlist, so it renders/syncs by
   *  `position` instead of the default natural album order (folder playlists
   *  only; non-folder playlists already always use `position`). */
  manual_order?: number;
  /** type === 'smart' only: the parsed rule set (see smartPlaylist.ts).
   *  `tracks` is always [] for a smart playlist — its membership isn't
   *  stored, it's evaluated live from `rules`. */
  rules?: SmartRules | null;
}

// ---- Smart playlists -------------------------------------------------------
// Stored as JSON in playlists.rules (migration 12+). Evaluated live on the
// Mac (see smartPlaylist.ts); Android only ever receives the resulting
// track_keys over sync, same as any other mirror playlist.

export type SmartTextField = 'title' | 'artist' | 'album' | 'album_artist' | 'genre' | 'composer';
export type SmartNumberField = 'play_count' | 'year' | 'duration' | 'track_no' | 'disc_no';
export type SmartDateField = 'added_at' | 'last_played';

export type SmartCondition =
  | { field: SmartTextField; op: 'contains' | 'not_contains' | 'is' | 'is_not' | 'starts_with' | 'ends_with'; value: string }
  | { field: SmartNumberField; op: 'eq' | 'ne' | 'gt' | 'lt'; value: number }
  | { field: SmartNumberField; op: 'between'; value: number; value2: number }
  | { field: SmartDateField; op: 'in_last' | 'not_in_last'; value: number; unit: 'days' | 'weeks' | 'months' }
  | { field: 'kind'; op: 'is' | 'is_not'; value: TrackKind }
  | { field: 'favorite'; op: 'is_true' | 'is_false' }
  | { field: 'play_state'; op: 'is' | 'is_not'; value: PlayState }
  | { field: 'playlist'; op: 'in' | 'not_in'; value: string };

export type SmartSortKey = 'natural' | 'title' | 'artist' | 'album' | 'play_count' | 'last_played' | 'added_at' | 'year';

export interface SmartRules {
  v: 1;
  match: 'all' | 'any';
  conditions: SmartCondition[];
  sortBy: SmartSortKey;
  sortDesc: boolean;
  /** null = no cap. */
  limit: number | null;
}

export interface SyncPlayEvent {
  track_key: string;
  played_at: number;
  device_id: string;
}

export interface SyncSnapshot {
  device_id: string;
  generated_at: number;
  playlists: { id: string; name: string; kind?: TrackKind; track_keys: string[] }[];
  tracks: {
    track_key: string;
    title: string;
    artist: string | null;
    album: string | null;
    duration: number | null;
    file_name: string;
    file_path: string;
    content_hash: string;
    /** Byte length of the file to download; 0 when unknown. */
    size: number;
    favorite: number;
    favorite_updated_at: number | null;
    /** 'music' | 'podcast' | 'other'. */
    kind: TrackKind;
    /** Disc / track numbers for the natural album order; null when untagged. */
    disc_no: number | null;
    track_no: number | null;
    /** Podcast only: 'unplayed' | 'in_progress' | 'played'. */
    play_state: PlayState;
    /** Podcast only: seconds to resume from. */
    resume_position: number;
    play_state_updated_at: number | null;
    /** When this track was first added on the sending device; null for older rows never backfilled. Absent from older peers. */
    added_at?: number | null;
  }[];
  play_events: SyncPlayEvent[];
  /** Per-album cover overrides (non-destructive; see db.ts's album_covers table). Absent from older peers. */
  album_covers?: { artist: string; album: string; image_data_uri: string | null; updated_at: number }[];
  /** Per-artist image overrides (non-destructive; see db.ts's artist_covers table). Absent from older peers. */
  artist_covers?: { artist: string; image_data_uri: string | null; updated_at: number }[];
}

export interface IncomingStats {
  device_id: string;
  events?: { track_key: string; played_at: number }[];
  favorites?: { track_key: string; favorite: number; updated_at: number }[];
  play_states?: { track_key: string; play_state: PlayState; resume_position: number; updated_at: number }[];
}

// SyncPeer / DiscoveredPeer aren't used by any Mac code any more; kept as the
// protocol reference for android-native's logic/Sync.kt (SyncPeer, DiscoveredPeer).
export interface SyncPeer {
  url: string;
  token: string;
  lastSyncAt: number | null;
}

export interface DiscoveredPeer {
  name: string;
  host: string;
  port: number;
  /** Ready to drop into the pairing URL field. */
  url: string;
}

export interface ServerActivity {
  last_manifest_at: number | null;
  last_stats_at: number | null;
  peers: string[];
}

export interface ServerStatus {
  running: boolean;
  ip: string;
  port: number;
  url: string;
  token: string;
  /** SHA-256 of the server's TLS public key (SPKI), lowercase hex — shown to
   *  the user so they can visually compare it against the phone's copy. */
  fingerprint: string;
  transcode_available: boolean;
}

export interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  track: Track | null;
}

export type ViewMode = 'playlist' | 'artists' | 'albums' | 'all_songs' | 'favorites' | 'most_played' | 'recently_added' | 'recently_played';

/** Artists/Albums display: a card grid (default) or a two-pane list with columns. */
export type LibraryLayout = 'grid' | 'list';
