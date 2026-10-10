import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import "./App.css";
import { invalidateAlbumArt, useNowPlayingArtwork } from "./albumArt";
import { albumOf, effectiveAlbum } from "./albumName";
import { artistOf, UNKNOWN_ARTIST } from "./names";
import i18n, { LanguagePreference, resolveLanguage } from "./i18n";
import { invalidateArtistArt } from "./artistArt";
import { useContextMenus } from "./hooks/useContextMenus";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useAudioPlayer } from "./hooks/useAudioPlayer";
import { useBackup } from "./hooks/useBackup";
import { usePlayerBarHeight } from "./hooks/usePlayerBarHeight";
import { useMediaSession } from "./hooks/useMediaSession";
import { usePersistedSetting } from "./hooks/usePersistedSetting";
import { useQueue } from "./hooks/useQueue";
import { createKeyedSingleFlight } from "./lib/singleFlight";
import { useScanFolders } from "./hooks/useScanFolders";
import { useSyncServer } from "./hooks/useSyncServer";
import { useTauriEvent } from "./hooks/useTauriEvent";
import { AlbumContextMenu } from "./components/AlbumContextMenu";
import { WelcomeModal } from "./components/WelcomeModal";
import { AlbumInfoModal, AlbumTagFields } from "./components/AlbumInfoModal";
import { ArtistContextMenu } from "./components/ArtistContextMenu";
import { ArtistImagePicker } from "./components/ArtistImagePicker";
import { AlbumCoverPicker } from "./components/AlbumCoverPicker";
import { TrackContextMenu } from "./components/ContextMenu";
import { TrackInfoModal, TrackTagFields } from "./components/TrackInfoModal";
import { Header } from "./components/Header";
import { Icon } from "./components/Icon";
import { LibraryColumns } from "./components/LibraryColumns";
import { LibraryView } from "./components/LibraryView";
import { LyricsPanel } from "./components/LyricsPanel";
import { CreatePlaylistModal, SettingsModal, SyncModal } from "./components/Modals";
import { SmartPlaylistModal } from "./components/SmartPlaylistModal";
import { PlayerBar } from "./components/PlayerBar";
import { SelectionContextMenu } from "./components/SelectionContextMenu";
import { PlaylistContextMenu } from "./components/PlaylistContextMenu";
import { LibraryItemContextMenu } from "./components/LibraryItemContextMenu";
import { LibrarySyncSource } from "./smartLists";
import { QueuePanel } from "./components/QueuePanel";
import { Sidebar } from "./components/Sidebar";
import { TrackList } from "./components/TrackList";
import {
  addTracksToPlaylist,
  backfillExtraTags,
  backfillTrackIdentities,
  backfillTrackNumbers,
  createPlaylist as dbCreatePlaylist,
  createSmartPlaylist,
  deletePlaylist as dbDeletePlaylist,
  getAllTracks,
  getPlaylists,
  getScanFolders,
  getSetting,
  getLibrarySyncSources,
  setLibrarySyncSources,
  getTrackPlayState,
  initDb,
  loadLastPlayback,
  migrateFromJson,
  recordPlayEvent,
  reapplyPlaylistKind,
  resetPlaylistManualOrder,
  saveLastPlayback,
  getAlbumCover,
  getArtistCoverKeys,
  setAlbumCover,
  setArtistCover,
  setPlaylistKind,
  setPlaylistSyncToDevice,
  setPlaylistTrackOrder,
  setSetting,
  setTrackFavorite,
  setTrackIdentity,
  setTrackKind,
  setTrackPlayState,
  updateSmartPlaylist,
  updateTrackTags,
} from "./db";
import { accumulateListened, effectiveSpeed, emptyListenProgress, nextPlayState, nextSpeed, parseSpeed, shouldCountPlay } from "./playback";
import { buildOrder, cycleRepeat, effectiveShuffle } from "./queue";
import { PlayerEngineEvents, toEngineTrack } from "./player/engine";
import { filterStrings, filterTracks } from "./search";
import { moveItem } from "./playlistOrder";
import { mostPlayed, recentlyAdded, recentlyPlayed } from "./smartLists";
import { DEFAULT_SMART_RULES, evaluateSmartPlaylist } from "./smartPlaylist";
import { pool } from "./sync";
import { nextSort, SortKey, SortState, sortNatural, sortTracks } from "./trackSort";
import type { LastPlayback } from "./db";
import { LibraryLayout, Playlist, SmartRules, Track, TrackIdentity, TrackKind, ViewMode } from "./types";

const MAX_AUTO_SKIPS = 5;

function App() {
  const { t } = useTranslation();
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  // Full `tracks` table, independent of playlist_tracks membership — see allTracks below.
  const [dbTracks, setDbTracks] = useState<Track[]>([]);
  const [currentPlaylistId, setCurrentPlaylistId] = useState<string | null>(null);

  // Library View State
  const [viewMode, setViewMode] = useState<ViewMode>('playlist');
  const [viewFilter, setViewFilter] = useState<string | null>(null); // Selected Artist or Album
  // Artists/Albums display: card grid (default) or a two-pane list with
  // columns (see LibraryColumns). Persisted per-view via setSetting below.
  const [libraryLayout, setLibraryLayout] = useState<{ artists: LibraryLayout; albums: LibraryLayout }>({ artists: 'grid', albums: 'grid' });
  const [search, setSearch] = useState("");
  // Column sort for the track list. null = the view's natural order. Reset when
  // the view / playlist changes (like `search`).
  const [sortState, setSortState] = useState<SortState | null>(null);

  const [currentTrack, setCurrentTrack] = useState<Track | null>(null);
  // Applies `patch` to currentTrack, but only if it's still the track this
  // update is about — an async write (setTrackFavorite, write_track_tags, …)
  // can settle after the user has already moved on to a different track, and
  // this must not resurrect/overwrite whatever's showing now. Written out
  // separately at 8 call sites before this was pulled out.
  const patchCurrentTrackIfId = useCallback((id: string, patch: Partial<Track>) => {
    setCurrentTrack(prev => (prev && prev.id === id ? { ...prev, ...patch } : prev));
  }, []);
  const {
    engine,
    isPlaying,
    setIsPlaying,
    duration,
    setDuration,
    volume,
    clock,
    handleSeek,
    handleVolumeChange,
    handleSkip,
  } = useAudioPlayer({ currentTrack });
  // Set just before setCurrentTrack() inside the engine's onAdvanced handler
  // (a gapless transition the *engine* made on its own, via setNext) to the
  // id it advanced to. The load effect below checks this first: that track is
  // already loaded and playing, so it must not call engine.load() again.
  const nativeAdvancedToIdRef = useRef<string | null>(null);
  // Consecutive load failures while auto-skipping unplayable tracks (missing
  // file, undecodable); caps the skipping so an all-bad queue can't spin.
  const loadFailStreakRef = useRef(0);
  // Setting: a Podcast playlist plays in order even while shuffle is on (the
  // shuffle toggle itself is left alone, so the next music playlist still
  // shuffles). Default on; persisted as "podcast_no_shuffle".
  const [podcastNoShuffle, setPodcastNoShuffle, loadPodcastNoShuffle] = usePersistedSetting(
    "podcast_no_shuffle", true, raw => raw !== "0", v => v ? "1" : "0");
  // Podcast playback speed (0.8–2.0x), shared across every podcast — not
  // per-episode. Music always plays at 1.0x regardless of this value (see
  // effectiveSpeed in playback.ts). Persisted as "podcast_speed".
  const [podcastSpeed, setPodcastSpeed, loadPodcastSpeed] = usePersistedSetting(
    "podcast_speed", 1.0, parseSpeed, String);

  // Latest playback-cursor identity, read by the flush-on-pause/hide listener
  // (which is registered once). Position is read live off the <audio> element.
  const cursorRef = useRef<{ trackId: string; viewMode: string; playlistId: string | null; viewFilter: string | null } | null>(null);
  cursorRef.current = currentTrack
    ? { trackId: currentTrack.id, viewMode, playlistId: currentPlaylistId, viewFilter }
    : null;
  const flushPlaybackCursor = useCallback(() => {
    const c = cursorRef.current;
    if (!c) return;
    const time = engine.getCurrentTime();
    lastCursorSaveRef.current = time;
    saveLastPlayback({
      trackId: c.trackId,
      position: time,
      viewMode: c.viewMode,
      playlistId: c.playlistId,
      viewFilter: c.viewFilter,
    }).catch(e => console.error("Failed to flush playback cursor:", e));
  }, [engine]);
  // True once the current play has been counted (30s / 50% threshold), reset per track.
  const playCountedRef = useRef(false);
  // Actual seconds listened (sum of forward playback, ignoring seeks), reset per track.
  const listenedRef = useRef(emptyListenProgress());
  // Last position persisted for a podcast's resume point — throttles the writes.
  const lastSavedPosRef = useRef(0);
  const [error, setError] = useState<string | null>(null);

  // "Arming": when the view changes we drop its first track into `currentTrack`
  // so the transport lights up and ▶ works — but without reading the file or
  // starting playback. `pendingPlayRef` names the track id the load effect is
  // actually allowed to play; a `currentTrack` whose id isn't there is armed
  // only. `loadedTrackIdRef` is the id whose audio is in the <audio> element
  // (null while merely armed), and bumping `loadToken` re-runs the load effect
  // for the same track (used by ▶ to load an armed track on demand).
  const pendingPlayRef = useRef<string | null>(null);
  const loadedTrackIdRef = useRef<string | null>(null);
  // Seconds to seek to once the loaded audio is ready — set when restoring the
  // last session on a cold start (Android may have killed the process). Consumed
  // and cleared in the load effect, right after play(). Podcasts use their own
  // resume_position; this covers every kind.
  const pendingSeekRef = useRef<{ trackId: string; position: number } | null>(null);
  // The last-playback cursor was restored on this mount, so the "arm the first
  // track of the view" effect must not stomp it on its first run.
  const restoredRef = useRef(false);
  // Stashed by initialize(); consumed once by the restore effect below.
  const lastPlaybackRef = useRef<LastPlayback | null>(null);
  const didRestoreRef = useRef(false);
  // StrictMode double-invokes the mount effect in dev; keeps the startup
  // backfill pass (see runBackfills below) to a single run.
  const backfillsStartedRef = useRef(false);
  // Last position we wrote to the settings cursor — throttles the writes to once
  // per ~5s of progress (rides handleTimeUpdate, no extra timer).
  const lastCursorSaveRef = useRef(0);
  // Reactive mirror of loadedTrackIdRef for row styling: the track actually in
  // the <audio> element (playing or paused) shows the now-playing marker; a
  // merely-clicked ("cued") track gets a plain selection highlight instead.
  const [loadedTrackId, setLoadedTrackId] = useState<string | null>(null);
  const markLoaded = (id: string | null) => { loadedTrackIdRef.current = id; setLoadedTrackId(id); };
  const [loadToken, setLoadToken] = useState(0);
  const {
    queue, setQueue,
    order, setOrder,
    orderPos, setOrderPos,
    repeatMode, setRepeatMode,
    shuffle,
    navRef,
    armFromList,
    playFromList,
    playCollection,
    playAdjacent,
    jumpInQueue,
    addToQueue,
    addCollectionToQueue,
    moveInQueue,
    removeFromQueue,
    toggleShuffle,
    updateEngineNext,
    onEngineAdvanced,
  } = useQueue({
    engine,
    setCurrentTrack,
    setIsPlaying,
    setLoadToken,
    setError,
    podcastNoShuffle,
    pendingPlayRef,
    loadedTrackIdRef,
    nativeAdvancedToIdRef,
  });
  // Cover art for the transport/now-playing UI: resolves for a merely-armed
  // (selected but not yet loaded) track too, not just a playing one — only
  // the online iTunes fallback is gated on the track actually being loaded
  // (`online`), so arming a track never triggers a network request.
  const currentArtwork = useNowPlayingArtwork(currentTrack, loadedTrackId === currentTrack?.id);
  // Live mirror of the current view's pre-search track list + its first row,
  // read by the arming effect (assigned during render, like `navRef`).
  const armRef = useRef<{ tracks: Track[]; track: Track | null }>({ tracks: [], track: null });

  // Modal State
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [newPlaylistName, setNewPlaylistName] = useState("");
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  // First-launch guide: opened once by initialize() on an empty install, or on
  // demand from Settings → About.
  const [isWelcomeOpen, setIsWelcomeOpen] = useState(false);
  // Smart Playlist editor: null when closed. Same shape for create (name
  // starts blank, rules start at DEFAULT_SMART_RULES) and edit (both
  // prefilled from the playlist being edited) — see SmartPlaylistModal.
  const [smartEditor, setSmartEditor] = useState<{ playlistId: string | null; name: string; rules: SmartRules } | null>(null);
  // Track-list column prefs (persisted in the settings table). Path off by default.
  const [showPathColumn, setShowPathColumn, loadShowPathColumn] = usePersistedSetting(
    "show_path_column", false, raw => raw === "1", v => v ? "1" : "0");
  // UI language: "system" (default) follows the OS/browser language; "en"/"ja"
  // pin it. Applied to i18next (and the Dock menu, via invoke) wherever it's
  // set — see the effect below.
  const [uiLanguage, setUiLanguage, loadUiLanguage] = usePersistedSetting<LanguagePreference>(
    "ui_language", "system",
    raw => (raw === "en" || raw === "ja" || raw === "system" ? raw : undefined),
    v => v);
  // Applies whenever the preference changes (including the initial load from
  // the DB, once loadUiLanguage() resolves it away from the "system" default)
  // — i18next re-renders every `useTranslation()` consumer, and the Dock
  // menu (native, outside React) is kept in sync via invoke.
  useEffect(() => {
    const resolved = resolveLanguage(uiLanguage);
    document.documentElement.lang = resolved;
    if (i18n.language !== resolved) i18n.changeLanguage(resolved);
    invoke("set_dock_labels", {
      labels: [i18n.t('dock.playPause'), i18n.t('dock.next'), i18n.t('dock.previous')],
    }).catch(() => { /* non-macOS / dev-server: no Dock to update */ });
  }, [uiLanguage]);
  // "Find Artist Image…" picker (per-artist, from ArtistContextMenu).
  const [artistImagePickerArtist, setArtistImagePickerArtist] = useState<string | null>(null);
  // "Get Info…" dialog (per-track, from TrackContextMenu).
  const [infoTrack, setInfoTrack] = useState<Track | null>(null);
  // "Get Info…" dialog (per-album, from AlbumContextMenu) — holds one
  // representative track; albumTracksFor() resolves the full track list.
  // "Find Album Cover…" picker (per-album, from AlbumContextMenu / track menu).
  const [albumCoverPickerTrack, setAlbumCoverPickerTrack] = useState<Track | null>(null);
  const [albumInfoTrack, setAlbumInfoTrack] = useState<Track | null>(null);
  // Bulk "Fetch Missing Artist Images" (Settings > Library). Cancel is a flag
  // rather than an AbortController since the loop lives in a `pool()` worker.
  const [artistImageFetchProgress, setArtistImageFetchProgress] =
    useState<{ done: number; total: number; found: number } | null>(null);
  const artistImageFetchCancelRef = useRef(false);

  const {
    isSyncModalOpen,
    serverStatus,
    serverActivity,
    serverAutostart,
    prepareProgress,
    transcodeFormat,
    transcodeBitrate,
    openSyncModal,
    closeSyncModal,
    toggleServer,
    toggleServerAutostart,
    changeTranscodeFormat,
    changeTranscodeBitrate,
    bumpSnapshot,
    initSyncFromDb,
    reloadSyncSettings,
  } = useSyncServer({ playlists, refreshPlaylists, setError });

  // Lyrics panel — docked column on the right.
  // Open state is persisted to `settings` (loaded in the init effect below).
  const [isLyricsOpen, setIsLyricsOpen, loadIsLyricsOpen] = usePersistedSetting(
    "lyrics_panel_open", false, raw => raw === "1", v => v ? "1" : "0");

  // Queue panel (slide-in on the right)
  const [isQueueOpen, setIsQueueOpen] = useState(false);

  // Sidebar State (drawer at narrow widths)
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const toggleSidebar = () => setIsSidebarOpen(!isSidebarOpen);
  const closeSidebar = () => setIsSidebarOpen(false);

  // Context Menu State
  const {
    contextMenu,
    playlistContextMenu,
    libraryContextMenu,
    albumContextMenu,
    artistContextMenu,
    openTrackMenu: handleContextMenu,
    openPlaylistMenu: handlePlaylistContextMenu,
    openLibraryMenu: handleLibraryContextMenu,
    openAlbumMenu: handleAlbumContextMenu,
    openArtistMenu: handleArtistContextMenu,
    closeTrackMenu,
    closePlaylistMenu,
    closeLibraryMenu,
    closeAlbumMenu,
    closeArtistMenu,
  } = useContextMenus();

  const [librarySyncSources, setLibrarySyncSourcesState] = useState<LibrarySyncSource[]>([]);
  useEffect(() => {
    getLibrarySyncSources().then(setLibrarySyncSourcesState).catch(e =>
      console.error("Failed to load library sync sources:", e));
  }, []);

  // Derived State: All Tracks (for Library)
  // Sourced from the `tracks` table directly (dbTracks, refreshed alongside
  // `playlists` in refreshPlaylists()) rather than a union of playlist_tracks
  // membership: a track can lose its playlist_tracks row (e.g. a rescan whose
  // fresh scan misses a cloud-storage placeholder, or a playlist deleted
  // without reconciling shared tracks) without being deleted from `tracks`,
  // and deriving from playlists made it — and its artist/album — silently
  // vanish from the whole library UI even though the row still existed.
  const allTracks = dbTracks;

  // Keep the now-playing track's favorite flag in step with the library after any
  // refresh — a star toggled from the track-list context menu, or a favorite
  // arriving from a paired device — so PlayerBar doesn't show a stale star until
  // the next track change. Only `favorite`/`favorite_updated_at` are synced here:
  // `play_count` isn't shown for the current track, and folding it in would churn
  // the currentTrack identity on every play event (which retriggers playback).
  useEffect(() => {
    setCurrentTrack(prev => {
      if (!prev) return prev;
      const fresh = allTracks.find(t => t.id === prev.id);
      if (!fresh) return prev;
      if (
        fresh.favorite === prev.favorite &&
        fresh.favorite_updated_at === prev.favorite_updated_at &&
        fresh.kind === prev.kind &&
        fresh.play_state === prev.play_state &&
        fresh.resume_position === prev.resume_position &&
        fresh.play_state_updated_at === prev.play_state_updated_at
      ) return prev;
      return {
        ...prev,
        favorite: fresh.favorite,
        favorite_updated_at: fresh.favorite_updated_at,
        kind: fresh.kind,
        play_state: fresh.play_state,
        resume_position: fresh.resume_position,
        play_state_updated_at: fresh.play_state_updated_at,
      };
    });
  }, [playlists]);

  // Settings loaded straight from the `settings` table into React state
  // (as opposed to state derived from `playlists`/`tracks`). Shared by the
  // startup initialize() effect below and a backup import (useBackup.ts),
  // which needs the same reload after importSettings() writes new values —
  // without this an imported ui_language/transcode_format etc. wouldn't take
  // effect until the next launch.
  const reloadSettings = useCallback(async () => {
    await Promise.all([
      loadShowPathColumn(),
      loadUiLanguage(),
      getSetting("library_layout_artists").then(v => {
        if (v === "list") setLibraryLayout(l => ({ ...l, artists: 'list' }));
      }).catch(() => {}),
      getSetting("library_layout_albums").then(v => {
        if (v === "list") setLibraryLayout(l => ({ ...l, albums: 'list' }));
      }).catch(() => {}),
      loadPodcastNoShuffle(),
      loadPodcastSpeed(),
      loadIsLyricsOpen(),
    ]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadShowPathColumn, loadUiLanguage, loadPodcastNoShuffle, loadPodcastSpeed, loadIsLyricsOpen]);

  // Load data on startup
  useEffect(() => {
    async function initialize() {
      try {
        await initDb();
        await migrateFromJson();
        await refreshPlaylists();
        await refreshScanFolders(); // from useScanFolders(), declared below — safe: initialize() only runs post-commit
        reloadSettings();
        await initSyncFromDb();

        // Initial view setup
        // We can't check playlists length right here easily without waiting for state update,
        // so we check the result of refreshing.
        const updatedPlaylists = await getPlaylists();
        setPlaylists(updatedPlaylists);

        // First launch: nothing in the library and the guide never shown.
        // Marked seen right away so a quit mid-guide doesn't bring it back.
        if (updatedPlaylists.length === 0 && (await getScanFolders()).length === 0
            && (await getSetting("welcome_seen")) !== "1") {
          setIsWelcomeOpen(true);
          setSetting("welcome_seen", "1").catch(() => {});
        }

        // Restore the last-played view + track (position is re-armed by the
        // restore effect once the view's tracks resolve). React state lives only
        // in memory, so a cold start would otherwise reset to the first track.
        const last = await loadLastPlayback().catch(() => null);
        lastPlaybackRef.current = last;

        const restoredView =
          last?.viewMode === 'playlist' && last.playlistId &&
          updatedPlaylists.some(p => p.id === last!.playlistId);

        if (restoredView) {
          setCurrentPlaylistId(last!.playlistId);
          setViewMode('playlist');
        } else if (last && last.viewMode && last.viewMode !== 'playlist') {
          setViewMode(last.viewMode as ViewMode);
          if (last.viewFilter) setViewFilter(last.viewFilter);
        } else if (updatedPlaylists.length > 0) {
          setCurrentPlaylistId(updatedPlaylists[0].id);
          setViewMode('playlist');
        } else {
          setViewMode('all_songs');
        }

        // Catch-up for rows scanned before track_key/content_hash/disc_no/track_no
        // existed (or left blank by a cloud placeholder). Deliberately not
        // awaited: it can mean real file I/O across the whole library, and the
        // library is already usable at this point (ensureTrackKey() covers a
        // track lazily on play in the meantime). Runs once per mount, not once
        // per initialize() retry.
        if (!backfillsStartedRef.current) {
          backfillsStartedRef.current = true;
          runBackfills();
        }
      } catch (err) {
        console.error("Failed to initialize:", err);
        setError(t('errors.initDbFailed', { error: String(err) }));
      } finally {
        // setIsLoaded(true); // Removed unused state
      }
    }
    async function runBackfills() {
      let changed = false;
      try {
        const n = await backfillTrackNumbers();
        if (n > 0) {
          console.log(`Backfilled disc/track numbers for ${n} tracks.`);
          changed = true;
        }
      } catch (e) {
        console.warn("Track-number backfill skipped:", e);
      }
      try {
        const n = await backfillTrackIdentities();
        if (n > 0) {
          console.log(`Backfilled track_key/content_hash for ${n} tracks.`);
          changed = true;
        }
      } catch (e) {
        console.warn("Track-identity backfill skipped:", e);
      }
      try {
        const n = await backfillExtraTags();
        if (n > 0) {
          console.log(`Backfilled genre/year/album_artist/composer for ${n} tracks.`);
          changed = true;
        }
      } catch (e) {
        console.warn("Extra-tags backfill skipped:", e);
      }
      if (changed) await refreshPlaylists();
    }
    initialize();
  }, []);

  async function refreshPlaylists() {
    try {
      const [pl, tracks] = await Promise.all([getPlaylists(), getAllTracks()]);
      setPlaylists(pl);
      setDbTracks(tracks);
    } catch (e) {
      console.error("Failed to refresh playlists:", e);
    }
  }

  // Removed automatic saving useEffect - DB handles persistence immediately.

  const deletePlaylist = async (id: string) => {
    try {
      await dbDeletePlaylist(id);
      await refreshPlaylists();
      if (currentPlaylistId === id) {
        setCurrentPlaylistId(null);
        setViewMode('all_songs');
      }
      closePlaylistMenu();
    } catch (err) {
      console.error("Failed to delete playlist:", err);
      setError(t('errors.deletePlaylistFailed'));
    }
  };

  // Scan folders + iTunes import. Must sit below `deletePlaylist` — it's a
  // `const`, so passing it from higher up would be a TDZ crash.
  const {
    scanFolders, isScanning, scanProgress, artworkProgress, refreshScanFolders, cancelScan, cancelThumbPrewarm,
    handleAddScanFolder, handleRescanFolders, handleRescanFolder,
    handleRemoveScanFolder, handleSetFolderKind, handleImportXml,
    registerFolder, setIsScanning,
  } = useScanFolders({
    playlists, refreshPlaylists, currentPlaylistId,
    setCurrentPlaylistId, setViewMode, deletePlaylist, setError,
  });

  // Export/import a JSON backup of playlists/folders/settings. Must sit below
  // useScanFolders (needs registerFolder) and reloadSettings/reloadSyncSettings
  // (declared earlier, near the initialize() effect and useSyncServer above).
  const { handleExportBackup, handleImportBackup } = useBackup({
    scanFolders, registerFolder, refreshScanFolders, refreshPlaylists, setIsScanning,
    reloadSettings: async () => { await Promise.all([reloadSettings(), reloadSyncSettings()]); },
    onCoversImported: () => { invalidateAlbumArt(); invalidateArtistArt(); },
    setError,
  });

  const openCreateModal = () => {
    setNewPlaylistName("New Playlist");
    setIsCreateModalOpen(true);
  };

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPlaylistName) {
      try {
        const newPl = await dbCreatePlaylist(newPlaylistName, 'custom');
        await refreshPlaylists(); // Refresh to get the new playlist in state

        setCurrentPlaylistId(newPl.id);
        setViewMode('playlist');
        setIsCreateModalOpen(false);
      } catch (err) {
        console.error("Failed to create playlist:", err);
        setError(t('errors.createPlaylistFailed'));
      }
    }
  };

  const openCreateSmartModal = () => {
    setSmartEditor({ playlistId: null, name: t('sidebar.newSmartPlaylist'), rules: DEFAULT_SMART_RULES });
  };

  const openEditSmartModal = (id: string) => {
    const pl = playlists.find(p => p.id === id);
    if (!pl || pl.type !== 'smart') return;
    setSmartEditor({ playlistId: id, name: pl.name, rules: pl.rules ?? DEFAULT_SMART_RULES });
    closePlaylistMenu();
  };

  const handleSaveSmartPlaylist = async (name: string, rules: SmartRules) => {
    if (smartEditor?.playlistId) {
      await updateSmartPlaylist(smartEditor.playlistId, name, rules);
      await refreshPlaylists();
    } else {
      const newPl = await createSmartPlaylist(name, rules);
      await refreshPlaylists();
      setCurrentPlaylistId(newPl.id);
      setViewMode('playlist');
    }
  };

  const addToPlaylist = async (playlistId: string, track: Track) => {
    try {
      await addTracksToPlaylist(playlistId, [track]);
      await reapplyPlaylistKind(playlistId); // a Podcast playlist keeps new tracks Podcast
      await refreshPlaylists();
      closeTrackMenu();
    } catch (err) {
      console.error("Failed to add to playlist:", err);
      setError(t('errors.addToPlaylistFailed'));
    }
  };

  const addTracksToPlaylistMulti = async (playlistId: string, tracks: Track[]) => {
    try {
      await addTracksToPlaylist(playlistId, tracks);
      await reapplyPlaylistKind(playlistId);
      await refreshPlaylists();
    } catch (err) {
      console.error("Failed to add to playlist:", err);
      setError(t('errors.addToPlaylistFailed'));
    }
  };

  // Right-click on a multi-selection in the track list.
  const [selectionMenu, setSelectionMenu] = useState<{ visible: boolean; x: number; y: number; tracks: Track[] }>(
    { visible: false, x: 0, y: 0, tracks: [] });
  const closeSelectionMenu = () => setSelectionMenu(prev => ({ ...prev, visible: false }));
  useEffect(() => {
    window.addEventListener('click', closeSelectionMenu);
    return () => window.removeEventListener('click', closeSelectionMenu);
  }, []);
  const openSelectionMenu = useCallback((e: React.MouseEvent, tracks: Track[]) => {
    setSelectionMenu({
      visible: true,
      x: e.clientX,
      y: e.clientY,
      tracks,
    });
  }, []);

  // In-flight compute_track_identity calls, keyed by track id, so a load and a
  // play-count check for the same track don't both hit the native layer.
  const trackKeyInFlight = useRef(createKeyedSingleFlight<string, string | undefined>());

  // Returns the track's cross-device key, computing + backfilling it if a pre-Phase-0
  // scan left it empty.
  function ensureTrackKey(track: Track): Promise<string | undefined> {
    if (track.track_key) return Promise.resolve(track.track_key);
    return trackKeyInFlight.current(track.id, async () => {
      try {
        const id = await invoke<TrackIdentity>("compute_track_identity", { path: track.file_path });
        await setTrackIdentity(track.id, id.track_key, id.content_hash);
        track.track_key = id.track_key;
        track.content_hash = id.content_hash;
        return id.track_key;
      } catch (e) {
        console.error("Failed to compute track identity:", e);
        return undefined;
      }
    });
  }

  useEffect(() => {
    let cancelled = false;
    clock.set(0);
    setDuration(0);
    playCountedRef.current = false;
    listenedRef.current = emptyListenProgress();
    lastSavedPosRef.current = currentTrack?.resume_position ?? 0;
    async function loadAndPlay() {
      if (!currentTrack) return;

      // The engine already transitioned here on its own (setNext's gapless
      // hand-off) — it's loaded and playing; just catch up the bookkeeping a
      // real load() would otherwise do below, without touching the engine.
      if (nativeAdvancedToIdRef.current === currentTrack.id) {
        nativeAdvancedToIdRef.current = null;
        markLoaded(currentTrack.id);
        setIsPlaying(true);
        setDuration(engine.getDuration());
        setError(null);
        return;
      }

      // Armed / cued but not asked to play: don't read the file or set a src, so
      // switching views or clicking rows stays cheap even with large FLACs. If a
      // different track was playing, stop it — the user picked something else and
      // will press ▶ (or double-click) when ready. ▶ bumps `loadToken` and sets
      // `pendingPlayRef` to load the cued track on demand.
      if (pendingPlayRef.current !== currentTrack.id) {
        if (loadedTrackIdRef.current && loadedTrackIdRef.current !== currentTrack.id) {
          engine.unload();
          setIsPlaying(false);
        }
        markLoaded(null);
        // Keep the seek bar showing the restored position (clock.set(0) ran
        // at the top of this effect). Real seek happens after play(), below.
        const seek = pendingSeekRef.current;
        if (seek && seek.trackId === currentTrack.id) clock.set(seek.position);
        return;
      }

      // Load and start playback first. Fetching artwork before this adds an
      // await that, on Android WebView, can drop the tap's user-activation and
      // make play() a no-op.
      try {
        await engine.load(toEngineTrack(currentTrack), {
          autoplay: true,
          rate: effectiveSpeed(currentTrack.kind, podcastSpeed),
        });
        if (cancelled) return;
        // Resume where playback left off: a podcast's own resume_position, or a
        // restored last-session position (pendingSeekRef) for any kind. Must run
        // after load() resolves — assigning the position before the source is
        // ready is silently ignored on some engines.
        //
        // For podcasts, re-read the position from the DB rather than trusting
        // `currentTrack.resume_position`: that field can come straight from a
        // stale `displayTracks` row (the 5s-throttled saves in handleTimeUpdate
        // update the DB + currentTrack only, not the whole `playlists` list), so
        // re-tapping a partly-listened episode could otherwise restart it at 0.
        let resume = currentTrack.resume_position ?? 0;
        if (currentTrack.kind === 'podcast') {
          const trackId = currentTrack.id;
          const fresh = await getTrackPlayState(trackId);
          if (fresh) {
            resume = fresh.resume_position;
            patchCurrentTrackIfId(trackId, fresh);
          }
        }
        const seek = pendingSeekRef.current;
        const seekTo = (currentTrack.kind === 'podcast' && resume > 1)
          ? resume
          : (seek && seek.trackId === currentTrack.id ? seek.position : 0);
        if (seekTo > 1) engine.seek(seekTo);
        // Align the 5s-throttle baseline with the actual start position so the
        // very next timeupdate tick (still at ~0 before the seek lands) doesn't
        // read as a >5s jump and overwrite the resume point with 0 (see the
        // loadedTrackIdRef guard in handleTimeUpdate for the other half of this).
        lastSavedPosRef.current = seekTo;
        pendingSeekRef.current = null;
        markLoaded(currentTrack.id);
        loadFailStreakRef.current = 0;
        setIsPlaying(true);
        setError(null);
        // See updateEngineNext's own comment: must run *after* engine.load()
        // has resolved, not just rely on the reactive effect below, or the
        // gapless hand-off for this track can silently never engage.
        updateEngineNext();
      } catch (e: any) {
        if (cancelled) return;
        console.error("Playback prep error:", e);
        setIsPlaying(false);
        setError(t('errors.playbackPrepFailed', { error: e.message || String(e) }));
        // A bad file (e.g. a stale library row whose file is gone) shouldn't
        // strand the listener on a dead ⏸ — move on to the next track.
        if (++loadFailStreakRef.current < MAX_AUTO_SKIPS) playAdjacent(1);
        else loadFailStreakRef.current = 0;
      }
      // Cover art itself is handled by useNowPlayingArtwork (see currentArtwork
      // above), which resolves for armed-but-not-loaded tracks too and reacts
      // to loadedTrackId turning true here to add the online fallback.
    }
    loadAndPlay();
    return () => { cancelled = true; };
    // Reload only when the track itself changes (or its file was re-synced) —
    // NOT when a stats field like favorite/play_count updates on the same track,
    // which would restart playback and re-count the play every ~30s. `loadToken`
    // lets ▶ force a (re)load of an already-selected but merely-armed track.
    // Deliberate: a resume_position arriving mid-playback from a paired device
    // (via the freshness effect above) must NOT re-trigger this effect and yank
    // the listener to a new position — it's picked up next time this track loads.
  }, [currentTrack?.id, currentTrack?.content_hash, loadToken]);

  const togglePlay = () => {
    // Armed track that was never loaded (view was just selected): load it now.
    if (currentTrack && loadedTrackIdRef.current !== currentTrack.id) {
      pendingPlayRef.current = currentTrack.id;
      setLoadToken(t => t + 1);
      return;
    }
    if (isPlaying) engine.pause();
    else engine.play().catch(e => setError(t('errors.resumeFailed', { error: e.message })));
    setIsPlaying(!isPlaying);
  };

  // macOS Dock right-click menu (see src-tauri/src/dock.rs). The ref keeps the
  // single long-lived listener pointed at the latest closures.
  const dockActionsRef = useRef({ toggle: () => {}, next: () => {}, previous: () => {} });
  dockActionsRef.current = {
    toggle: togglePlay,
    next: () => playAdjacent(1),
    previous: () => playAdjacent(-1),
  };
  useTauriEvent<"toggle" | "next" | "previous">("dock-action", (action) => {
    dockActionsRef.current[action]?.();
  });

  usePlayerBarHeight(currentTrack);
  const skipSeconds = 10;
  useMediaSession(currentTrack, currentArtwork, isPlaying, {
    togglePlay, handleSeek, handleSkip, playAdjacent, skipSeconds,
  });

  // Flush the playback cursor when the app goes to the background or is closing.
  useEffect(() => {
    const onHide = () => { if (document.visibilityState === "hidden") flushPlaybackCursor(); };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", flushPlaybackCursor);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", flushPlaybackCursor);
    };
  }, [flushPlaybackCursor]);

  useKeyboardShortcuts({
    togglePlay,
    playNext: () => playAdjacent(1),
    playPrevious: () => playAdjacent(-1),
    skip: handleSkip,
    isPodcast: currentTrack?.kind === 'podcast',
  });

  // Count a play once the listener has *actually heard* 30s or 50% of the track.
  // We sum forward playback deltas so scrubbing the seek bar doesn't count a play.
  // `time` comes from the engine's onPosition event (~4/s while loaded).
  const handleTimeUpdate = async (time: number) => {
    if (!currentTrack) return;
    // Still loading/seeking into currentTrack: position briefly reads ~0
    // before the resume seek lands. Ignore these ticks — otherwise the podcast
    // resume-position write below would see a >5s "jump" back to 0 and save it.
    if (loadedTrackIdRef.current !== currentTrack.id) return;

    clock.set(time);
    listenedRef.current = accumulateListened(listenedRef.current, time);

    // Keep the OS/car scrubber in step.
    if ("mediaSession" in navigator && navigator.mediaSession.setPositionState) {
      const dur = engine.getDuration() || currentTrack.duration || 0;
      if (dur > 0 && time <= dur) {
        try {
          navigator.mediaSession.setPositionState({
            duration: dur,
            position: time,
            playbackRate: effectiveSpeed(currentTrack.kind, podcastSpeed),
          });
        } catch { /* invalid state mid-load — ignore */ }
      }
    }

    // Podcasts: persist a resume point, throttled to once per ~5s of progress so
    // the 4×/s timeupdate doesn't hammer the DB. Optimistic local update only —
    // no refreshPlaylists() (that would re-fetch the whole library every 5s).
    if (currentTrack.kind === 'podcast') {
      const dur = engine.getDuration() || currentTrack.duration || 0;
      if (dur > 0 && Math.abs(time - lastSavedPosRef.current) >= 5) {
        lastSavedPosRef.current = time;
        const { state, resume } = nextPlayState(currentTrack.play_state ?? 'unplayed', time, dur);
        const trackId = currentTrack.id;
        setTrackPlayState(trackId, state, resume).catch(e => console.error("Failed to save resume position:", e));
        patchCurrentTrackIfId(trackId, { play_state: state, resume_position: resume, play_state_updated_at: Date.now() });
      }
    }

    // Persist the playback cursor (track + position + view) for restore on a
    // cold start. Same ~5s throttle as the podcast branch; rides this handler so
    // there's no extra timer. Also flushed on pause / tab-hide (effect below).
    if (Math.abs(time - lastCursorSaveRef.current) >= 5) {
      lastCursorSaveRef.current = time;
      saveLastPlayback({
        trackId: currentTrack.id,
        position: time,
        viewMode,
        playlistId: currentPlaylistId,
        viewFilter,
      }).catch(e => console.error("Failed to save playback cursor:", e));
    }

    if (playCountedRef.current) return;
    const dur = engine.getDuration() || currentTrack.duration || 0;
    if (!shouldCountPlay(listenedRef.current.secs, dur)) return;

    playCountedRef.current = true;
    const key = await ensureTrackKey(currentTrack);
    if (!key) return;
    try {
      await recordPlayEvent(key);
      await refreshPlaylists();
    } catch (e) {
      console.error("Failed to record play event:", e);
    }
  };

  // Wire the engine's events to the app-level handlers above. A ref holds the
  // latest closures (same pattern as navRef/dockActionsRef) so the single
  // subscribe() call made below never sees a stale currentTrack/playAdjacent.
  const engineHandlersRef = useRef<Partial<PlayerEngineEvents>>({});
  engineHandlersRef.current = {
    onPlay: () => setIsPlaying(true),
    onPause: () => {
      setIsPlaying(false);
      flushPlaybackCursor();
      // A podcast pause is a settle point: persist the exact position (the 5s
      // throttle in handleTimeUpdate may be up to 5s stale) and rebuild the
      // pushed snapshot so a paired device resumes from here. Skipped at
      // end-of-media (onEnded owns that) and while a new track is still loading.
      if (currentTrack?.kind === 'podcast' && !engine.isEnded() && loadedTrackIdRef.current === currentTrack.id) {
        const dur = engine.getDuration() || currentTrack.duration || 0;
        if (dur > 0) {
          const trackId = currentTrack.id;
          const time = engine.getCurrentTime();
          const { state, resume } = nextPlayState(currentTrack.play_state ?? 'unplayed', time, dur);
          lastSavedPosRef.current = time;
          setTrackPlayState(trackId, state, resume)
            .then(() => refreshPlaylists())
            .then(() => bumpSnapshot())
            .catch(err => console.error("Failed to save resume position on pause:", err));
          patchCurrentTrackIfId(trackId, { play_state: state, resume_position: resume, play_state_updated_at: Date.now() });
        }
      }
    },
    onEnded: () => {
      // A podcast that played to the end is "played" — record it even under
      // repeat-one (which replays instead of advancing).
      if (currentTrack?.kind === 'podcast') {
        const trackId = currentTrack.id;
        setTrackPlayState(trackId, 'played', 0).catch(e => console.error("Failed to mark podcast played:", e));
        patchCurrentTrackIfId(trackId, { play_state: 'played', resume_position: 0, play_state_updated_at: Date.now() });
        // A settle point (unlike the 5s throttle above): make sure this
        // reaches the pushed snapshot so a paired device sees it as played.
        bumpSnapshot();
      }
      playAdjacent(1, true);
    },
    onDuration: (d) => setDuration(d),
    onPosition: (t) => { handleTimeUpdate(t); },
    onAdvanced: onEngineAdvanced,
    onError: (message) => {
      console.error("Playback engine error:", message);
      setError(t('errors.audioError', { error: message }));
      setIsPlaying(false);
    },
  };
  useEffect(() => {
    const trampoline: Partial<PlayerEngineEvents> = {
      onPlay: () => engineHandlersRef.current.onPlay?.(),
      onPause: () => engineHandlersRef.current.onPause?.(),
      onEnded: () => engineHandlersRef.current.onEnded?.(),
      onDuration: (d) => engineHandlersRef.current.onDuration?.(d),
      onPosition: (t) => engineHandlersRef.current.onPosition?.(t),
      onAdvanced: (id) => engineHandlersRef.current.onAdvanced?.(id),
      onError: (m) => engineHandlersRef.current.onError?.(m),
    };
    return engine.subscribe(trampoline);
  }, [engine]);

  const handleToggleFavorite = async (track: Track) => {
    const next = !track.favorite;
    try {
      await setTrackFavorite(track.id, next);
      patchCurrentTrackIfId(track.id, { favorite: next ? 1 : 0, favorite_updated_at: Date.now() });
      await refreshPlaylists();
    } catch (e) {
      console.error("Failed to toggle favorite:", e);
      setError(t('errors.updateFavoriteFailed', { error: String(e) }));
    }
  };

  const handleSetKind = async (track: Track, kind: TrackKind) => {
    try {
      await setTrackKind(track.id, kind);
      patchCurrentTrackIfId(track.id, { kind, kind_updated_at: Date.now() });
      await refreshPlaylists();
    } catch (e) {
      console.error("Failed to set track kind:", e);
      setError(t('errors.setKindFailed', { error: String(e) }));
    }
    closeTrackMenu();
  };

  // Manual podcast status override from the context menu.
  const handleSetPlayState = async (track: Track, state: 'unplayed' | 'played') => {
    try {
      await setTrackPlayState(track.id, state, 0);
      patchCurrentTrackIfId(track.id, { play_state: state, resume_position: 0, play_state_updated_at: Date.now() });
      await refreshPlaylists();
    } catch (e) {
      console.error("Failed to set play state:", e);
    }
    closeTrackMenu();
  };

  const handleToggleLibrarySync = async (source: LibrarySyncSource) => {
    const next = librarySyncSources.includes(source)
      ? librarySyncSources.filter(s => s !== source)
      : [...librarySyncSources, source];
    try {
      await setLibrarySyncSources(next);
      setLibrarySyncSourcesState(next);
      // buildSyncSnapshot reads these flags itself; nothing else changed that would
      // retrigger the push effect, so ask for a rebuild explicitly.
      bumpSnapshot();
    } catch (e) {
      console.error("Failed to toggle library sync flag:", e);
      setError(t('errors.updateSyncSettingFailed', { error: String(e) }));
    }
    closeLibraryMenu();
  };

  const handleToggleSyncToDevice = async (playlistId: string) => {
    const pl = playlists.find(p => p.id === playlistId);
    try {
      await setPlaylistSyncToDevice(playlistId, !pl?.sync_to_device);
      await refreshPlaylists();
    } catch (e) {
      console.error("Failed to toggle sync flag:", e);
      setError(t('errors.updateSyncSettingFailed', { error: String(e) }));
    }
    closePlaylistMenu();
  };

  const handleSetPlaylistKind = async (playlistId: string, kind: TrackKind) => {
    try {
      await setPlaylistKind(playlistId, kind);
      // Bulk-reclassified the tracks; keep currentTrack's badge in step too.
      setCurrentTrack(prev => {
        if (!prev) return prev;
        const inPl = playlists.find(p => p.id === playlistId)?.tracks.some(t => t.id === prev.id);
        return inPl ? { ...prev, kind, kind_updated_at: Date.now() } : prev;
      });
      await refreshPlaylists();
    } catch (e) {
      console.error("Failed to set playlist kind:", e);
      setError(t('errors.setKindFailed', { error: String(e) }));
    }
    closePlaylistMenu();
  };

  const handleResetManualOrder = async (playlistId: string) => {
    try {
      await resetPlaylistManualOrder(playlistId);
      await refreshPlaylists();
    } catch (e) {
      console.error("Failed to reset playlist order:", e);
      setError(t('errors.resetOrderFailed', { error: String(e) }));
    }
    closePlaylistMenu();
  };

  const handleTogglePathColumn = (next: boolean) => {
    setShowPathColumn(next);
  };

  const handleChangeLanguage = (next: LanguagePreference) => {
    setUiLanguage(next);
  };

  // Artists/Albums grid<->list toggle (Header's layoutToggle). `view` is
  // whichever of the two is currently open (viewMode is narrowed by the caller).
  const handleSetLibraryLayout = (view: 'artists' | 'albums', next: LibraryLayout) => {
    setLibraryLayout(l => ({ ...l, [view]: next }));
    setSetting(`library_layout_${view}`, next).catch(e =>
      console.error(`Failed to persist library_layout_${view}:`, e));
  };

  const handleTogglePodcastNoShuffle = (next: boolean) => {
    setPodcastNoShuffle(next);
  };

  // Cycles the shared podcast speed and persists it. Applied to the <audio>
  // element immediately if a podcast is currently loaded — otherwise it only
  // takes effect on the next podcast load (see the load effect below, which
  // re-applies playbackRate on every load since assigning `src` resets it).
  const handleCyclePodcastSpeed = () => {
    setPodcastSpeed(prev => {
      const next = nextSpeed(prev);
      if (currentTrack?.kind === 'podcast') {
        engine.setRate(next);
      }
      return next;
    });
  };

  const toggleLyricsPanel = () => {
    setIsLyricsOpen(prev => !prev);
  };

  const handlePlaylistClick = (id: string) => {
    setCurrentPlaylistId(id);
    setViewMode('playlist');
    setViewFilter(null);
    setSearch("");
    setSortState(null);
  };

  const handleLibraryClick = (mode: ViewMode) => {
    setViewMode(mode);
    setViewFilter(null);
    setCurrentPlaylistId(null);
    setSearch("");
    setSortState(null);
  };

  const selectViewFilter = (value: string) => {
    setViewFilter(value);
    setSearch("");
    setSortState(null);
  };

  // Whether the current view (if it's Artists/Albums) is in list layout —
  // read together in several places below, so computed once.
  const isLibraryListView = (viewMode === 'artists' || viewMode === 'albums') && libraryLayout[viewMode] === 'list';

  // List layout's left-pane selection. Unlike selectViewFilter (grid layout,
  // where the whole view switches to a TrackList), the search box keeps
  // filtering the left-pane names list here, so it's left alone.
  const selectListItem = (value: string) => {
    setViewFilter(value);
    setSortState(null);
  };

  // Every non-smart playlist's track ids, for the smart-playlist 'playlist'
  // rule field/op (see evaluateSmartPlaylist). Smart playlists are
  // deliberately left out — they store no membership of their own, and
  // referencing one would be circular.
  const playlistMembership = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const pl of playlists) {
      if (pl.type !== 'smart') m.set(pl.id, new Set(pl.tracks.map(t => t.id)));
    }
    return m;
  }, [playlists]);

  // View Logic — the tracks for the current view, before the search filter.
  const viewTracks = useMemo((): Track[] => {
    if (viewMode === 'playlist') {
      const pl = playlists.find(p => p.id === currentPlaylistId);
      if (pl?.type === 'smart') {
        return evaluateSmartPlaylist(pl.rules ?? DEFAULT_SMART_RULES, allTracks, playlistMembership, Date.now());
      }
      // Already ordered by the DB (NATURAL_ORDER for folder playlists, saved
      // position otherwise).
      return pl?.tracks || [];
    } else if (viewMode === 'all_songs') {
      // These views are filtered out of an in-memory array, so they inherit no
      // ORDER BY — sort them the same way the DB sorts folder playlists.
      return sortNatural(allTracks);
    } else if (viewMode === 'artists' && viewFilter) {
      return sortNatural(allTracks.filter(t => artistOf(t) === viewFilter));
    } else if (viewMode === 'albums' && viewFilter) {
      return sortNatural(allTracks.filter(t => albumOf(t) === viewFilter));
    } else if (viewMode === 'favorites') {
      return sortNatural(allTracks.filter(t => t.favorite));
    } else if (viewMode === 'most_played') {
      return mostPlayed(allTracks);
    } else if (viewMode === 'recently_added') {
      return recentlyAdded(allTracks);
    } else if (viewMode === 'recently_played') {
      return recentlyPlayed(allTracks);
    }
    return [];
  }, [viewMode, currentPlaylistId, viewFilter, playlists, allTracks, playlistMembership]);

  const displayTracks = useMemo(
    () => sortTracks(filterTracks(viewTracks, search), sortState),
    [viewTracks, search, sortState],
  );
  const handleSort = useCallback((key: SortKey) => setSortState(s => nextSort(s, key)), []);

  // Mirror the current view's first track for the arming effect below.
  armRef.current = { tracks: viewTracks, track: viewTracks[0] ?? null };

  // Stable handlers for the (memoised) TrackList so a `currentTime` tick during
  // playback doesn't re-render every row. The list + latest handler impls are
  // read through refs, so these callbacks never need to change identity.
  const displayTracksRef = useRef(displayTracks);
  displayTracksRef.current = displayTracks;
  const currentPlaylistIdRef = useRef(currentPlaylistId);
  currentPlaylistIdRef.current = currentPlaylistId;
  const trackHandlersRef = useRef({ armFromList, playFromList, handleContextMenu, handleToggleFavorite });
  trackHandlersRef.current = { armFromList, playFromList, handleContextMenu, handleToggleFavorite };
  const onRowClick = useCallback((t: Track) => trackHandlersRef.current.armFromList(displayTracksRef.current, t), []);
  const onRowActivate = useCallback((t: Track) => trackHandlersRef.current.playFromList(displayTracksRef.current, t), []);
  const onRowContextMenu = useCallback((e: React.MouseEvent, t: Track) => trackHandlersRef.current.handleContextMenu(e, t), []);
  const onRowToggleFavorite = useCallback((t: Track) => trackHandlersRef.current.handleToggleFavorite(t), []);

  // Drag & drop reorder (see TrackList's reorderable/onReorder). Only makes
  // sense on a playlist detail view, and only while row index matches DB
  // position — a column sort or search filter changes what's rendered at each
  // index without changing the underlying position, so dropping there would
  // silently reorder the wrong tracks.
  const currentPlaylist = playlists.find(p => p.id === currentPlaylistId);
  const reorderable = viewMode === 'playlist' && !!currentPlaylistId && currentPlaylist?.type !== 'smart' && !sortState && !search;
  const handleReorderTracks = useCallback((from: number, to: number) => {
    const list = displayTracksRef.current;
    const reordered = moveItem(list, from, to);
    if (reordered === list) return;
    const playlistId = currentPlaylistIdRef.current;
    if (!playlistId) return;
    setPlaylistTrackOrder(playlistId, reordered.map(t => t.id))
      .then(refreshPlaylists)
      .catch(err => {
        console.error("Failed to reorder playlist:", err);
        setError(t('errors.reorderFailed', { error: String(err) }));
      });
  }, []);

  const artists = useMemo(
    () => filterStrings(Array.from(new Set(allTracks.map(artistOf))).sort(), search),
    [allTracks, search],
  );
  const albums = useMemo(
    () => filterStrings(Array.from(new Set(allTracks.map(albumOf))).sort(), search),
    [allTracks, search],
  );
  // One representative track per album, used only to resolve a cover
  // thumbnail for the Albums grid (see LibraryView's artFor). First track
  // encountered wins; good enough since a cover is keyed by (artist, album)
  // and most albums share one artist across all their tracks anyway.
  const albumArtTracks = useMemo(() => {
    const map = new Map<string, Track>();
    for (const t of allTracks) {
      const album = albumOf(t);
      if (!map.has(album)) map.set(album, t);
    }
    return map;
  }, [allTracks]);
  // One representative track per artist, used only as the "Play"/"Add to
  // Queue" target in the Artists grid's context menu (see ArtistContextMenu).
  // Artist images themselves are keyed by artist name alone (artistArt.ts),
  // not by this track.
  const artistArtTracks = useMemo(() => {
    const map = new Map<string, Track>();
    for (const t of allTracks) {
      const artist = artistOf(t);
      if (!map.has(artist)) map.set(artist, t);
    }
    return map;
  }, [allTracks]);

  // Restore the last session's track + position once the current view's tracks
  // have resolved (the view itself was set in initialize()). Arms only — the
  // user presses ▶ to actually play from the saved position (pendingSeekRef is
  // honoured by the load effect). Runs at most once per mount.
  useEffect(() => {
    if (didRestoreRef.current) return;
    const last = lastPlaybackRef.current;
    if (!last) { didRestoreRef.current = true; return; }
    // Wait until the library has loaded; viewTracks is derived in the same
    // render that playlists arrives, so one shot is enough.
    if (playlists.length === 0 && viewTracks.length === 0) return;
    didRestoreRef.current = true;
    const list = viewTracks;
    const track = list.find(t => t.id === last.trackId);
    if (!track) return;
    const start = list.findIndex(t => t.id === track.id);
    const nextOrder = buildOrder(list.length, { shuffle: effectiveShuffle(shuffle, podcastNoShuffle, list), first: start });
    setQueue(list);
    setOrder(nextOrder);
    setOrderPos(nextOrder.indexOf(start));
    setCurrentTrack(track);                  // armed only
    setDuration(track.duration ?? 0);
    clock.set(last.position);
    if (last.position > 1) {
      pendingSeekRef.current = { trackId: track.id, position: last.position };
    }
    restoredRef.current = true;              // stop the auto-arm effect stomping it
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playlists, viewTracks]);

  // Arm the first track of whatever view is showing, so ▶ / ⏭ / the queue
  // button work straight after picking a playlist — no need to click a row
  // first. Never interrupts playback: if something is playing we leave it be.
  // Keyed on the view identity + the first track's id (which also covers the
  // initial load, when playlists arrive after mount). `isPlaying` and `shuffle`
  // are read but deliberately NOT deps — we don't want a keystroke in the search
  // box or a play/pause to re-arm.
  useEffect(() => {
    if (isPlaying) return;
    // The restore effect just armed the saved track (which may not be row 0);
    // let it stand this once.
    if (restoredRef.current) { restoredRef.current = false; return; }
    const { tracks, track } = armRef.current;
    if (!track || currentTrack?.id === track.id) return;
    const nav = navRef.current;
    const nextOrder = buildOrder(tracks.length, { shuffle: effectiveShuffle(nav.shuffle, nav.podcastNoShuffle, tracks), first: 0 });
    setQueue(tracks);
    setOrder(nextOrder);
    setOrderPos(nextOrder.indexOf(0));
    setCurrentTrack(track); // armed only — pendingPlayRef is not set
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, currentPlaylistId, viewFilter, armRef.current.track?.id]);

  const getHeaderTitle = () => {
    if (viewMode === 'playlist') return playlists.find(p => p.id === currentPlaylistId)?.name || t('common.playlist');
    if (viewMode === 'all_songs') return t('sidebar.allSongs');
    if (viewMode === 'artists') {
      if (isLibraryListView) return t('sidebar.artists');
      return viewFilter ? (viewFilter === UNKNOWN_ARTIST ? t('common.unknownArtist') : viewFilter) : t('sidebar.artists');
    }
    if (viewMode === 'albums') return isLibraryListView ? t('sidebar.albums') : (viewFilter || t('sidebar.albums'));
    if (viewMode === 'favorites') return t('sidebar.favorites');
    if (viewMode === 'most_played') return t('sidebar.mostPlayed');
    if (viewMode === 'recently_added') return t('sidebar.recentlyAdded');
    if (viewMode === 'recently_played') return t('sidebar.recentlyPlayed');
    return t('settings.appName');
  };

  // Sync lyrics update to tracks in state (if modal updates lyrics)
  // The modal updates DB, but we should also update local state to reflect changes without full reload if possible.
  // We passed 'track' to LyricsModal, and if we modify it there by reference or callback, it helps.
  // But strictly, we should probably reload or update state. 
  // For now, since LyricsModal modifies the track object for local display, it might suffice if we don't need immediate deep reactivity elsewhere.
  // Actually, 'allTracks' is derived from 'playlists'. If we mutate a track inside 'playlists', forceUpdate might be needed.
  // But let's assume valid reactivity or just accept standard behavior for now.

  const handleShowInFinder = async (track: Track) => {
    try {
      await invoke("show_in_finder", { path: track.file_path });
    } catch (err) {
      console.error("Failed to show in finder:", err);
      setError(t('errors.showInFinderFailed', { error: String(err) }));
    }
  };

  const handleSetArtwork = async (track: Track) => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }],
        title: "Select Artwork Image"
      });

      if (selected && typeof selected === "string") {
        await invoke("set_track_artwork", { path: track.file_path, imagePath: selected });
        // This rewrites the file's own embedded cover, so the disk-cached
        // thumbnail (keyed by artist/album, not by content) would otherwise
        // keep showing the old image in the album grid.
        await invoke("clear_album_thumb_cache", { artist: track.artist ?? "", album: effectiveAlbum(track) ?? "" });
        invalidateAlbumArt();
      }
    } catch (err) {
      console.error("Failed to set artwork:", err);
      setError(t('errors.setArtworkFailed', { error: String(err) }));
    }
  };

  // "Get Info…" dialog's Save: rewrite the file's own tags, then the DB row.
  // Title/artist/album/duration/track_no feed track_key (see compute_track_key,
  // src-tauri/src/lib.rs), so editing them changes it — updateTrackTags carries
  // play_events over to the new key so play count / last played survive.
  const handleSaveTrackTags = async (track: Track, fields: TrackTagFields) => {
    const identity = await invoke<{ track_key: string; content_hash: string }>("write_track_tags", {
      path: track.file_path,
      edit: fields,
    });
    await updateTrackTags(track.id, track.track_key, fields, identity.track_key, identity.content_hash);
    const artistChanged = fields.artist !== (track.artist ?? "");
    const albumChanged = fields.album !== (track.album ?? "");
    if (artistChanged || albumChanged) {
      // The disk-cached album thumbnail is keyed by (artist, album) — the
      // folder-derived name when the track had no tag of its own (see
      // albumName.ts) — not by content, so it would otherwise keep showing
      // under the old key.
      await invoke("clear_album_thumb_cache", { artist: track.artist ?? "", album: effectiveAlbum(track) ?? "" });
      invalidateAlbumArt();
    }
    patchCurrentTrackIfId(track.id, {
      title: fields.title,
      artist: fields.artist || undefined,
      album: fields.album || undefined,
      disc_no: fields.disc_no,
      track_no: fields.track_no,
      track_key: identity.track_key,
      content_hash: identity.content_hash,
    });
    await refreshPlaylists();
  };

  // Album "Get Info…" dialog's Save: rewrites artist/album on every track in
  // the album (title/disc/track stay per-track, out of scope here — see
  // AlbumInfoModal). Each file write + DB update mirrors handleSaveTrackTags
  // above (including the track_key re-key), just looped with bounded
  // concurrency via pool() (same helper the bulk artist-image fetch uses).
  // Partial failures don't roll back what already succeeded — those files are
  // already renamed on disk and in the DB — but we throw a summary so the
  // dialog surfaces it instead of silently closing.
  const handleSaveAlbumTags = async (
    tracks: Track[],
    fields: AlbumTagFields,
    onProgress: (done: number, total: number) => void
  ) => {
    if (tracks.length === 0) return;
    const oldArtist = tracks[0].artist ?? "";
    // The cover/thumb cache is keyed by the *effective* album (folder-derived
    // when untagged, see albumName.ts), not the raw blank tag, so the carry-
    // over/cache-clear below must look it up under that same key.
    const oldAlbum = effectiveAlbum(tracks[0]) ?? "";

    let done = 0;
    const failures: string[] = [];
    await pool(tracks, 3, async (t) => {
      try {
        const edit = {
          title: t.title,
          artist: fields.artist,
          album: fields.album,
          disc_no: t.disc_no ?? null,
          track_no: t.track_no ?? null,
        };
        const identity = await invoke<{ track_key: string; content_hash: string }>("write_track_tags", {
          path: t.file_path,
          edit,
        });
        await updateTrackTags(t.id, t.track_key, edit, identity.track_key, identity.content_hash);
      } catch (err) {
        console.error(`Failed to update tags for ${t.file_path}:`, err);
        failures.push(t.file_name);
      } finally {
        done += 1;
        onProgress(done, tracks.length);
      }
    });

    // Carry the album cover override over to the new (artist, album) key so
    // a rename doesn't silently drop it (see setAlbumCover's cache-key note).
    // Computed the same way the cache itself is keyed (effectiveAlbum, not
    // the raw tag) so leaving an already-untagged album's field blank isn't
    // mistaken for a rename (its folder-derived key doesn't actually change).
    const newAlbumKey = effectiveAlbum({ album: fields.album, file_path: tracks[0].file_path }) ?? "";
    const renamed = fields.artist !== oldArtist || newAlbumKey !== oldAlbum;
    if (renamed) {
      const cover = await getAlbumCover(oldArtist, oldAlbum);
      if (cover) {
        await setAlbumCover(fields.artist, newAlbumKey, cover);
        await setAlbumCover(oldArtist, oldAlbum, null);
      }
      await invoke("clear_album_thumb_cache", { artist: oldArtist, album: oldAlbum });
      await invoke("clear_album_thumb_cache", { artist: fields.artist, album: newAlbumKey });
      invalidateAlbumArt();
    }
    await refreshPlaylists();

    if (failures.length > 0) {
      throw new Error(
        `${failures.length}/${tracks.length} files failed: ${failures.slice(0, 3).join(", ")}${failures.length > 3 ? "…" : ""}`
      );
    }
  };

  // Album grid's right-click "Play"/"Add to Queue": act on every track in the
  // clicked album (matched by name, same grouping LibraryView's Albums view
  // uses), not just the single representative track the menu was opened with.
  const albumTracksFor = (track: Track): Track[] =>
    sortNatural(allTracks.filter(t => albumOf(t) === albumOf(track)));

  const playAlbum = (track: Track) => playCollection(albumTracksFor(track));
  const addAlbumToQueue = (track: Track) => addCollectionToQueue(albumTracksFor(track));

  const addAlbumToPlaylist = async (playlistId: string, track: Track) => {
    try {
      await addTracksToPlaylist(playlistId, albumTracksFor(track));
      await reapplyPlaylistKind(playlistId); // a Podcast playlist keeps new tracks Podcast
      await refreshPlaylists();
    } catch (err) {
      console.error("Failed to add album to playlist:", err);
      setError(t('errors.addAlbumToPlaylistFailed'));
    }
  };

  // Non-destructive per-album override: unlike handleSetArtwork, this never
  // touches a music file's own tags, applies to every track sharing the same
  // (artist, album) pair — NOT album name alone, so a different artist's
  // same-titled (or also-untagged) album is unaffected — and syncs to paired
  // devices via SyncSnapshot.album_covers.
  const handleSetAlbumCover = async (track: Track) => {
    const artist = track.artist ?? "";
    const album = effectiveAlbum(track) ?? "";
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }],
        title: "Select Album Cover Image"
      });
      if (selected && typeof selected === "string") {
        const dataUri = await invoke<string>("read_image_as_data_uri", { imagePath: selected });
        await setAlbumCover(artist, album, dataUri);
        invalidateAlbumArt();
      }
    } catch (err) {
      console.error("Failed to set album cover:", err);
      setError(t('errors.setAlbumCoverFailed', { error: String(err) }));
    }
  };

  const applyAlbumCoverUrl = async (track: Track, imageUrl: string) => {
    const dataUri = await invoke<string>("fetch_image_as_data_uri", { url: imageUrl });
    await setAlbumCover(track.artist ?? "", effectiveAlbum(track) ?? "", dataUri);
    invalidateAlbumArt();
  };

  const handleResetAlbumCover = async (track: Track) => {
    const artist = track.artist ?? "";
    const album = effectiveAlbum(track) ?? "";
    try {
      await setAlbumCover(artist, album, null);
      invalidateAlbumArt();
    } catch (err) {
      console.error("Failed to reset album cover:", err);
      setError(t('errors.resetAlbumCoverFailed', { error: String(err) }));
    }
  };

  // Artist grid's right-click "Play"/"Add to Queue": act on every track by
  // the clicked artist (matched by name, same grouping LibraryView's Artists
  // view uses), not just the single representative track the menu was opened with.
  const artistTracksFor = (track: Track): Track[] =>
    sortNatural(allTracks.filter(t => artistOf(t) === artistOf(track)));

  const playArtist = (track: Track) => playCollection(artistTracksFor(track));
  const addArtistToQueue = (track: Track) => addCollectionToQueue(artistTracksFor(track));

  const addArtistToPlaylist = async (playlistId: string, artist: string) => {
    try {
      const tracks = allTracks.filter(t => artistOf(t) === artist);
      await addTracksToPlaylist(playlistId, tracks);
      await reapplyPlaylistKind(playlistId); // a Podcast playlist keeps new tracks Podcast
      await refreshPlaylists();
    } catch (err) {
      console.error("Failed to add artist to playlist:", err);
      setError(t('errors.addArtistToPlaylistFailed'));
    }
  };

  // Non-destructive per-artist image override (see artistArt.ts), synced to
  // Android read-only like album covers.
  const handleSetArtistImage = async (artist: string) => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }],
        title: "Select Artist Image"
      });
      if (selected && typeof selected === "string") {
        const dataUri = await invoke<string>("read_image_as_data_uri", { imagePath: selected });
        await setArtistCover(artist, dataUri);
        invalidateArtistArt();
      }
    } catch (err) {
      console.error("Failed to set artist image:", err);
      setError(t('errors.setArtistImageFailed', { error: String(err) }));
    }
  };

  const handleResetArtistImage = async (artist: string) => {
    try {
      await setArtistCover(artist, null);
      invalidateArtistArt();
    } catch (err) {
      console.error("Failed to reset artist image:", err);
      setError(t('errors.resetArtistImageFailed', { error: String(err) }));
    }
  };

  // Opens the Deezer candidate picker; the picker itself calls back into
  // applyArtistImageUrl on selection.
  const handleFindArtistImage = (artist: string) => {
    setArtistImagePickerArtist(artist);
  };

  const applyArtistImageUrl = async (artist: string, pictureUrl: string) => {
    const dataUri = await invoke<string>("fetch_image_as_data_uri", { url: pictureUrl });
    await setArtistCover(artist, dataUri);
    invalidateArtistArt();
  };

  // Bulk-fills every artist without a cover override yet, using Deezer's
  // exact-name-match auto lookup (see auto_artist_image in metadata.rs).
  // Never touches an artist that already has one — manual or automatic.
  const handleFetchMissingArtistImages = async () => {
    const targets = artists.filter(a => a !== UNKNOWN_ARTIST);
    const existing = await getArtistCoverKeys();
    const missing = targets.filter(a => !existing.has(a.trim().toLowerCase()));
    if (missing.length === 0) {
      setArtistImageFetchProgress({ done: 0, total: 0, found: 0 });
      return;
    }

    artistImageFetchCancelRef.current = false;
    let done = 0;
    let found = 0;
    setArtistImageFetchProgress({ done, total: missing.length, found });

    await pool(missing, 2, async (artist) => {
      if (artistImageFetchCancelRef.current) return;
      try {
        const dataUri = await invoke<string | null>("auto_artist_image", { artist });
        if (dataUri) {
          await setArtistCover(artist, dataUri);
          found += 1;
        }
      } catch (err) {
        console.warn(`auto_artist_image failed for ${artist}:`, err);
      }
      done += 1;
      setArtistImageFetchProgress({ done, total: missing.length, found });
    });

    invalidateArtistArt();
    setArtistImageFetchProgress(null);
  };

  const cancelFetchMissingArtistImages = () => {
    artistImageFetchCancelRef.current = true;
  };

  const trackListRegion = (
        <div className="track-list-container">
          {(viewMode === 'artists' && !viewFilter && !isLibraryListView) && (
            <LibraryView
              viewMode="artists"
              items={artists}
              onItemClick={selectViewFilter}
              artFor={(a) => artistArtTracks.get(a) ?? null}
              onItemContextMenu={handleArtistContextMenu}
            />
          )}

          {(viewMode === 'albums' && !viewFilter && !isLibraryListView) && (
            <LibraryView
              viewMode="albums"
              items={albums}
              onItemClick={selectViewFilter}
              artFor={(a) => albumArtTracks.get(a) ?? null}
              onItemContextMenu={handleAlbumContextMenu}
            />
          )}

          {((viewMode === 'artists' || viewMode === 'albums') && isLibraryListView) && (
            <LibraryColumns
              viewMode={viewMode}
              items={viewMode === 'artists' ? artists : albums}
              selected={viewFilter}
              onSelect={selectListItem}
              onItemContextMenu={viewMode === 'artists' ? handleArtistContextMenu : handleAlbumContextMenu}
              artFor={(a) => (viewMode === 'artists' ? artistArtTracks : albumArtTracks).get(a) ?? null}
              tracks={viewTracks}
              currentTrack={currentTrack}
              loadedTrackId={loadedTrackId}
              onTrackClick={onRowClick}
              onTrackActivate={onRowActivate}
              onTrackContextMenu={onRowContextMenu}
              onToggleFavorite={onRowToggleFavorite}
              onPlay={(tracks) => playCollection(tracks)}
              onShuffle={(tracks) => playCollection(tracks, { shuffle: true })}
              onArtistMore={handleArtistContextMenu}
              onAlbumMore={handleAlbumContextMenu}
              onBack={() => setViewFilter(null)}
            />
          )}

          {/* Track List View */}
          {((viewMode === 'playlist' && currentPlaylistId) ||
            viewMode === 'all_songs' ||
            viewMode === 'favorites' ||
            viewMode === 'most_played' ||
            viewMode === 'recently_added' ||
            viewMode === 'recently_played' ||
            (viewMode === 'artists' && viewFilter && !isLibraryListView) ||
            (viewMode === 'albums' && viewFilter && !isLibraryListView)) && (
              <TrackList
                tracks={displayTracks}
                currentTrack={currentTrack}
                loadedTrackId={loadedTrackId}
                showPath={showPathColumn}
                sortState={sortState}
                onSort={handleSort}
                onTrackClick={onRowClick}
                onTrackActivate={onRowActivate}
                onContextMenu={onRowContextMenu}
                onSelectionContextMenu={openSelectionMenu}
                onToggleFavorite={onRowToggleFavorite}
                reorderable={reorderable}
                onReorder={handleReorderTracks}
              />
            )}

          {viewMode === 'playlist' && !currentPlaylistId && (
            <div className="empty-state">Select a playlist.</div>
          )}
        </div>
  );

  const lyricsPanel = (
    <LyricsPanel
      isOpen={isLyricsOpen}
      onClose={toggleLyricsPanel}
      track={currentTrack}
    />
  );

  const playerBar = (
    <PlayerBar
      currentTrack={currentTrack}
      isPlaying={isPlaying}
      togglePlay={togglePlay}
      onNext={queue.length > 0 ? () => playAdjacent(1) : undefined}
      onPrev={queue.length > 0 ? () => playAdjacent(-1) : undefined}
      onSkipBack={() => handleSkip(-skipSeconds)}
      onSkipForward={() => handleSkip(skipSeconds)}
      shuffle={shuffle}
      onToggleShuffle={toggleShuffle}
      repeatMode={repeatMode}
      onCycleRepeat={() => setRepeatMode(cycleRepeat)}
      clock={clock}
      duration={duration}
      onSeek={handleSeek}
      volume={volume}
      onVolumeChange={handleVolumeChange}
      onLyricsClick={toggleLyricsPanel}
      isLyricsOpen={isLyricsOpen}
      artworkUrl={currentArtwork}
      isFavorite={!!currentTrack?.favorite}
      onToggleFavorite={currentTrack ? () => handleToggleFavorite(currentTrack) : undefined}
      onQueueClick={queue.length > 0 ? () => setIsQueueOpen(true) : undefined}
      podcastSpeed={podcastSpeed}
      onCyclePodcastSpeed={handleCyclePodcastSpeed}
    />
  );

  return (
    <div className="app-container">
      <Sidebar
        isOpen={isSidebarOpen}
        onClose={closeSidebar}
        viewMode={viewMode}
        onLibraryClick={handleLibraryClick}
        librarySyncSources={librarySyncSources}
        onLibraryContextMenu={handleLibraryContextMenu}
        playlists={playlists}
        currentPlaylistId={currentPlaylistId}
        onPlaylistClick={handlePlaylistClick}
        onPlaylistContextMenu={handlePlaylistContextMenu}
        onCreatePlaylist={openCreateModal}
        onCreateSmartPlaylist={openCreateSmartModal}
        onAddFolder={handleAddScanFolder}
        isScanning={isScanning}
        scanProgress={scanProgress}
        onCancelScan={cancelScan}
        artworkProgress={artworkProgress}
        onCancelThumbPrewarm={cancelThumbPrewarm}
        onSync={openSyncModal}
        onSettings={() => setIsSettingsModalOpen(true)}
      />

      <div className={`sidebar-overlay ${isSidebarOpen ? 'visible' : ''}`} onClick={closeSidebar}></div>

      <main className="main-content">
        <Header
          onToggleSidebar={toggleSidebar}
          title={getHeaderTitle()}
          search={search}
          onSearchChange={setSearch}
          layoutToggle={
            (viewMode === 'artists' || viewMode === 'albums')
              ? { value: libraryLayout[viewMode], onChange: (v) => handleSetLibraryLayout(viewMode, v) }
              : undefined
          }
        />

        {error && (
          <div className="error-banner">
            <span className="error-banner-text">{error}</span>
            <button
              type="button"
              className="error-banner-dismiss"
              aria-label={t('common.close')}
              onClick={() => setError(null)}
            >
              <Icon name="x" size={14} />
            </button>
          </div>
        )}

        <div className="content-row">
          {trackListRegion}
          {lyricsPanel}
        </div>

        {playerBar}
      </main>

        <CreatePlaylistModal
          isOpen={isCreateModalOpen}
          onClose={() => setIsCreateModalOpen(false)}
          onSubmit={handleCreateSubmit}
          playlistName={newPlaylistName}
          setPlaylistName={setNewPlaylistName}
        />

        <SmartPlaylistModal
          editor={smartEditor}
          allTracks={allTracks}
          playlistOptions={playlists.filter(p => p.type !== 'smart').map(p => ({ id: p.id, name: p.name }))}
          membership={playlistMembership}
          onClose={() => setSmartEditor(null)}
          onSave={handleSaveSmartPlaylist}
        />

        <SyncModal
          isOpen={isSyncModalOpen}
          onClose={closeSyncModal}
          serverStatus={serverStatus}
          serverActivity={serverActivity}
          prepareProgress={prepareProgress}
          toggleServer={toggleServer}
        />

        <WelcomeModal
          isOpen={isWelcomeOpen}
          onClose={() => setIsWelcomeOpen(false)}
          hasFolders={scanFolders.length > 0}
          isScanning={isScanning}
          scanProgress={scanProgress}
          onAddFolder={handleAddScanFolder}
          onOpenSync={() => { setIsWelcomeOpen(false); openSyncModal(); }}
        />

        <SettingsModal
          isOpen={isSettingsModalOpen}
          onShowWelcome={() => setIsWelcomeOpen(true)}
          onClose={() => setIsSettingsModalOpen(false)}
          folders={scanFolders}
          isScanning={isScanning}
          scanProgress={scanProgress}
          onCancelScan={cancelScan}
          onAddFolder={handleAddScanFolder}
          onRemoveFolder={handleRemoveScanFolder}
          onRescan={handleRescanFolders}
          onRescanFolder={handleRescanFolder}
          onImportXml={handleImportXml}
          onSetFolderKind={handleSetFolderKind}
          showPathColumn={showPathColumn}
          onTogglePathColumn={handleTogglePathColumn}
          podcastNoShuffle={podcastNoShuffle}
          onTogglePodcastNoShuffle={handleTogglePodcastNoShuffle}
          serverAutostart={serverAutostart}
          onToggleServerAutostart={toggleServerAutostart}
          transcodeFormat={transcodeFormat}
          onChangeTranscodeFormat={changeTranscodeFormat}
          transcodeBitrate={transcodeBitrate}
          onChangeTranscodeBitrate={changeTranscodeBitrate}
          artistImageFetchProgress={artistImageFetchProgress}
          onFetchMissingArtistImages={handleFetchMissingArtistImages}
          onCancelFetchMissingArtistImages={cancelFetchMissingArtistImages}
          language={uiLanguage}
          onChangeLanguage={handleChangeLanguage}
          onExportBackup={handleExportBackup}
          onImportBackup={handleImportBackup}
        />

        <TrackContextMenu
          visible={contextMenu.visible}
          x={contextMenu.x}
          y={contextMenu.y}
          track={contextMenu.track}
          playlists={playlists}
          onAddToPlaylist={addToPlaylist}
          onAddToQueue={addToQueue}
          onShowInFinder={handleShowInFinder}
          onSetArtwork={handleSetArtwork}
          onFindAlbumCover={setAlbumCoverPickerTrack}
          onSetAlbumCover={handleSetAlbumCover}
          onResetAlbumCover={handleResetAlbumCover}
          onToggleFavorite={handleToggleFavorite}
          onSetKind={handleSetKind}
          onSetPlayState={handleSetPlayState}
          onGetInfo={setInfoTrack}
          onClose={closeTrackMenu}
        />

        <TrackInfoModal
          track={infoTrack}
          onClose={() => setInfoTrack(null)}
          onSave={handleSaveTrackTags}
          onShowInFinder={handleShowInFinder}
        />

        <SelectionContextMenu
          visible={selectionMenu.visible}
          x={selectionMenu.x}
          y={selectionMenu.y}
          tracks={selectionMenu.tracks}
          playlists={playlists}
          onPlay={playCollection}
          onAddToQueue={addCollectionToQueue}
          onAddToPlaylist={addTracksToPlaylistMulti}
          onClose={closeSelectionMenu}
        />

        <LibraryItemContextMenu
          visible={libraryContextMenu.visible}
          x={libraryContextMenu.x}
          y={libraryContextMenu.y}
          source={libraryContextMenu.source}
          syncToDevice={!!libraryContextMenu.source && librarySyncSources.includes(libraryContextMenu.source)}
          onToggleSyncToDevice={handleToggleLibrarySync}
        />

        <PlaylistContextMenu
          visible={playlistContextMenu.visible}
          x={playlistContextMenu.x}
          y={playlistContextMenu.y}
          playlistId={playlistContextMenu.playlistId}
          isSmart={playlists.find(p => p.id === playlistContextMenu.playlistId)?.type === 'smart'}
          syncToDevice={!!playlists.find(p => p.id === playlistContextMenu.playlistId)?.sync_to_device}
          kind={playlists.find(p => p.id === playlistContextMenu.playlistId)?.kind ?? 'music'}
          manualOrder={!!playlists.find(p => p.id === playlistContextMenu.playlistId)?.manual_order}
          onToggleSyncToDevice={handleToggleSyncToDevice}
          onSetKind={handleSetPlaylistKind}
          onResetManualOrder={handleResetManualOrder}
          onEditSmartPlaylist={openEditSmartModal}
          onDelete={deletePlaylist}
        />

        <AlbumContextMenu
          visible={albumContextMenu.visible}
          x={albumContextMenu.x}
          y={albumContextMenu.y}
          album={albumContextMenu.album}
          track={albumContextMenu.track}
          playlists={playlists}
          onPlay={playAlbum}
          onAddToQueue={addAlbumToQueue}
          onAddToPlaylist={addAlbumToPlaylist}
          onFindAlbumCover={setAlbumCoverPickerTrack}
          onSetAlbumCover={handleSetAlbumCover}
          onResetAlbumCover={handleResetAlbumCover}
          onGetInfo={setAlbumInfoTrack}
          onClose={closeAlbumMenu}
        />

        <AlbumInfoModal
          tracks={albumInfoTrack ? albumTracksFor(albumInfoTrack) : []}
          onClose={() => setAlbumInfoTrack(null)}
          onSave={handleSaveAlbumTags}
        />

        <ArtistContextMenu
          visible={artistContextMenu.visible}
          x={artistContextMenu.x}
          y={artistContextMenu.y}
          artist={artistContextMenu.artist}
          track={artistContextMenu.track}
          playlists={playlists}
          onPlay={playArtist}
          onAddToQueue={addArtistToQueue}
          onAddToPlaylist={addArtistToPlaylist}
          onSetArtistImage={handleSetArtistImage}
          onFindArtistImage={handleFindArtistImage}
          onResetArtistImage={handleResetArtistImage}
          onClose={closeArtistMenu}
        />

        <ArtistImagePicker
          isOpen={artistImagePickerArtist !== null}
          artist={artistImagePickerArtist ?? ""}
          onClose={() => setArtistImagePickerArtist(null)}
          onSelect={(pictureUrl) => applyArtistImageUrl(artistImagePickerArtist!, pictureUrl)}
        />

        <AlbumCoverPicker
          isOpen={albumCoverPickerTrack !== null}
          query={albumCoverPickerTrack ? `${albumCoverPickerTrack.artist ?? ""} ${effectiveAlbum(albumCoverPickerTrack) ?? ""}`.trim() : ""}
          onClose={() => setAlbumCoverPickerTrack(null)}
          onSelect={(imageUrl) => applyAlbumCoverUrl(albumCoverPickerTrack!, imageUrl)}
        />

        <QueuePanel
          open={isQueueOpen}
          onClose={() => setIsQueueOpen(false)}
          queue={queue}
          order={order}
          orderPos={orderPos}
          onJump={jumpInQueue}
          onMove={moveInQueue}
          onRemove={removeFromQueue}
        />

        {/* Playback itself has no DOM element — see src/player/engine.ts.
            The engine is wired up via engineHandlersRef's subscribe() effect. */}
    </div>
  );
}

export default App;
