import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  getLibrarySyncSources,
  resetPlaylistManualOrder,
  setLibrarySyncSources,
  setPlaylistKind,
  setPlaylistSyncToDevice,
  setTrackRating,
  type TrackRating,
  setTrackKind,
  setTrackPlayState,
} from "../db";
import type { LibrarySyncSource } from "../smartLists";
import type { Playlist, Track, TrackKind } from "../types";

interface Params {
  playlists: Playlist[];
  refreshPlaylists: () => Promise<void>;
  setError: (message: string | null) => void;
  patchCurrentTrackIfId: (id: string, patch: Partial<Track>) => void;
  setCurrentTrack: React.Dispatch<React.SetStateAction<Track | null>>;
  bumpSnapshot: () => void;
  closeTrackMenu: () => void;
  closePlaylistMenu: () => void;
  closeLibraryMenu: () => void;
}

/**
 * Context-menu actions that flip one attribute of a track or playlist
 * (favorite, kind, podcast play state, sync flags, manual order reset) and
 * then refresh the library. Pure move out of App.tsx — behaviour is unchanged.
 */
export function usePlaylistActions({
  playlists, refreshPlaylists, setError, patchCurrentTrackIfId, setCurrentTrack,
  bumpSnapshot, closeTrackMenu, closePlaylistMenu, closeLibraryMenu,
}: Params) {
  const { t } = useTranslation();

  const [librarySyncSources, setLibrarySyncSourcesState] = useState<LibrarySyncSource[]>([]);
  useEffect(() => {
    getLibrarySyncSources().then(setLibrarySyncSourcesState).catch(e =>
      console.error("Failed to load library sync sources:", e));
  }, []);

  const applyRating = async (track: Track, rating: TrackRating) => {
    try {
      await setTrackRating(track.id, rating);
      patchCurrentTrackIfId(track.id, {
        favorite: rating === 'up' ? 1 : 0,
        disliked: rating === 'down' ? 1 : 0,
        favorite_updated_at: Date.now(),
      });
      await refreshPlaylists();
    } catch (e) {
      console.error("Failed to set rating:", e);
      setError(t('errors.updateFavoriteFailed', { error: String(e) }));
    }
  };

  /** Thumbs up: toggles on/off; from thumbs down it switches to up. */
  const handleToggleFavorite = (track: Track) => applyRating(track, track.favorite ? 'none' : 'up');
  /** Thumbs down: toggles on/off; from thumbs up it switches to down. */
  const handleToggleDislike = (track: Track) => applyRating(track, track.disliked ? 'none' : 'down');

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

  return {
    librarySyncSources,
    handleToggleFavorite,
    handleToggleDislike,
    handleSetKind,
    handleSetPlayState,
    handleToggleLibrarySync,
    handleToggleSyncToDevice,
    handleSetPlaylistKind,
    handleResetManualOrder,
  };
}
