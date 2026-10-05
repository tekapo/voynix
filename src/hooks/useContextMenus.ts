import { useEffect, useState } from "react";
import { ContextMenuState, Track } from "../types";
import { LibrarySyncSource } from "../smartLists";

interface PlaylistMenuState {
  visible: boolean;
  x: number;
  y: number;
  playlistId: string | null;
}

interface LibraryMenuState {
  visible: boolean;
  x: number;
  y: number;
  source: LibrarySyncSource | null;
}

interface AlbumMenuState {
  visible: boolean;
  x: number;
  y: number;
  album: string | null;
  track: Track | null;
}

interface ArtistMenuState {
  visible: boolean;
  x: number;
  y: number;
  artist: string | null;
  track: Track | null;
}

/**
 * The four right-click context menus (track / playlist / album / artist).
 * All four close together on any window click, and each also has its own
 * explicit close paths (Escape-equivalent actions like "Add to Playlist").
 */
export function useContextMenus() {
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    track: null
  });

  const [playlistContextMenu, setPlaylistContextMenu] = useState<PlaylistMenuState>({
    visible: false,
    x: 0,
    y: 0,
    playlistId: null
  });

  const [libraryContextMenu, setLibraryContextMenu] = useState<LibraryMenuState>({
    visible: false,
    x: 0,
    y: 0,
    source: null
  });

  const [albumContextMenu, setAlbumContextMenu] = useState<AlbumMenuState>({
    visible: false,
    x: 0,
    y: 0,
    album: null,
    track: null
  });

  const [artistContextMenu, setArtistContextMenu] = useState<ArtistMenuState>({
    visible: false,
    x: 0,
    y: 0,
    artist: null,
    track: null
  });

  const closeTrackMenu = () => setContextMenu(prev => ({ ...prev, visible: false }));
  const closePlaylistMenu = () => setPlaylistContextMenu(prev => ({ ...prev, visible: false }));
  const closeLibraryMenu = () => setLibraryContextMenu(prev => ({ ...prev, visible: false }));
  const closeAlbumMenu = () => setAlbumContextMenu(prev => ({ ...prev, visible: false }));
  const closeArtistMenu = () => setArtistContextMenu(prev => ({ ...prev, visible: false }));

  useEffect(() => {
    const handleClick = () => {
      closeTrackMenu();
      closePlaylistMenu();
      closeLibraryMenu();
      closeAlbumMenu();
      closeArtistMenu();
    };
    window.addEventListener('click', handleClick);
    return () => window.removeEventListener('click', handleClick);
  }, []);

  const openTrackMenu = (e: React.MouseEvent, track: Track) => {
    e.preventDefault();
    setContextMenu({ visible: true, x: e.clientX, y: e.clientY, track });
  };

  const openPlaylistMenu = (e: React.MouseEvent, playlistId: string) => {
    e.preventDefault();
    setPlaylistContextMenu({ visible: true, x: e.clientX, y: e.clientY, playlistId });
  };

  const openLibraryMenu = (e: React.MouseEvent, source: LibrarySyncSource) => {
    e.preventDefault();
    setLibraryContextMenu({ visible: true, x: e.clientX, y: e.clientY, source });
  };

  const openAlbumMenu = (e: React.MouseEvent, album: string, track: Track | null) => {
    e.preventDefault();
    setAlbumContextMenu({ visible: true, x: e.clientX, y: e.clientY, album, track });
  };

  const openArtistMenu = (e: React.MouseEvent, artist: string, track: Track | null) => {
    e.preventDefault();
    setArtistContextMenu({ visible: true, x: e.clientX, y: e.clientY, artist, track });
  };

  return {
    contextMenu,
    playlistContextMenu,
    libraryContextMenu,
    albumContextMenu,
    artistContextMenu,
    openTrackMenu,
    openPlaylistMenu,
    openLibraryMenu,
    openAlbumMenu,
    openArtistMenu,
    closeTrackMenu,
    closePlaylistMenu,
    closeLibraryMenu,
    closeAlbumMenu,
    closeArtistMenu,
  };
}
