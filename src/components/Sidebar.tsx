import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Playlist, ViewMode } from '../types';
import { Icon, IconName } from './Icon';
import { LibrarySyncSource } from '../smartLists';

const PLAYLIST_TYPE_ICON: Record<string, IconName> = {
    folder: 'folder',
    xml: 'file-text',
    mirror: 'smartphone',
    smart: 'wand',
};

interface SidebarProps {
    isOpen: boolean;
    onClose: () => void;
    viewMode: ViewMode;
    onLibraryClick: (mode: ViewMode) => void;
    librarySyncSources?: LibrarySyncSource[];
    onLibraryContextMenu?: (e: React.MouseEvent, source: LibrarySyncSource) => void;
    playlists: Playlist[];
    currentPlaylistId: string | null;
    onPlaylistClick: (id: string) => void;
    onPlaylistContextMenu: (e: React.MouseEvent, id: string) => void;
    onCreatePlaylist: () => void;
    onCreateSmartPlaylist: () => void;
    onAddFolder: () => void;
    onSync: () => void;
    onSettings: () => void;
    isScanning?: boolean;
    scanProgress?: { done: number; total: number } | null;
    onCancelScan?: () => void;
    /** Album-art prewarm running in the background after a scan (see
     *  useScanFolders' prewarmForTracks) — shown once scanning itself has
     *  finished, so the two statuses never compete for the same slot. */
    artworkProgress?: { done: number; total: number } | null;
    onCancelThumbPrewarm?: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
    isOpen,
    onClose,
    viewMode,
    onLibraryClick,
    librarySyncSources = [],
    onLibraryContextMenu,
    playlists,
    currentPlaylistId,
    onPlaylistClick,
    onPlaylistContextMenu,
    onCreatePlaylist,
    onCreateSmartPlaylist,
    onAddFolder,
    onSync,
    onSettings,
    isScanning = false,
    scanProgress = null,
    onCancelScan,
    artworkProgress = null,
    onCancelThumbPrewarm
}) => {
    const { t } = useTranslation();
    const scanLabel = scanProgress
        ? t('sidebar.scanningProgress', { done: scanProgress.done, total: scanProgress.total })
        : t('sidebar.scanning');
    const [newMenuOpen, setNewMenuOpen] = useState(false);
    const newMenuRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!newMenuOpen) return;
        const handlePointerDown = (e: PointerEvent) => {
            if (newMenuRef.current && !newMenuRef.current.contains(e.target as Node)) {
                setNewMenuOpen(false);
            }
        };
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setNewMenuOpen(false);
        };
        document.addEventListener('pointerdown', handlePointerDown);
        document.addEventListener('keydown', handleKeyDown);
        return () => {
            document.removeEventListener('pointerdown', handlePointerDown);
            document.removeEventListener('keydown', handleKeyDown);
        };
    }, [newMenuOpen]);

    const runAndClose = (action: () => void) => {
        setNewMenuOpen(false);
        action();
    };

    return (
        <aside className={`sidebar ${isOpen ? 'open' : ''}`}>
            {/* Library Section */}
            <div className="sidebar-section">
                <div className="sidebar-header">
                    <h2>{t('sidebar.library')}</h2>
                </div>
                <ul className="sidebar-list">
                    <li
                        className={`playlist-item ${viewMode === 'all_songs' ? 'active' : ''}`}
                        onClick={() => { onLibraryClick('all_songs'); onClose(); }}
                        onContextMenu={(e) => onLibraryContextMenu?.(e, 'all_songs')}
                    >
                        <span className="playlist-icon"><Icon name="music" /></span>
                        <span className="item-label">{t('sidebar.allSongs')}</span>
                        {librarySyncSources.includes('all_songs') ? (
                            <span className="playlist-sync-badge" title={t('sidebar.syncedToDevices')}>
                                <Icon name="broadcast" size={14} />
                            </span>
                        ) : null}
                    </li>
                    <li
                        className={`playlist-item ${viewMode === 'favorites' ? 'active' : ''}`}
                        onClick={() => { onLibraryClick('favorites'); onClose(); }}
                        onContextMenu={(e) => onLibraryContextMenu?.(e, 'favorites')}
                    >
                        <span className="playlist-icon"><Icon name="star" /></span>
                        <span className="item-label">{t('sidebar.favorites')}</span>
                        {librarySyncSources.includes('favorites') ? (
                            <span className="playlist-sync-badge" title={t('sidebar.syncedToDevices')}>
                                <Icon name="broadcast" size={14} />
                            </span>
                        ) : null}
                    </li>
                    <li
                        className={`playlist-item ${viewMode === 'most_played' ? 'active' : ''}`}
                        onClick={() => { onLibraryClick('most_played'); onClose(); }}
                        onContextMenu={(e) => onLibraryContextMenu?.(e, 'most_played')}
                    >
                        <span className="playlist-icon"><Icon name="flame" /></span>
                        <span className="item-label">{t('sidebar.mostPlayed')}</span>
                        {librarySyncSources.includes('most_played') ? (
                            <span className="playlist-sync-badge" title={t('sidebar.syncedToDevices')}>
                                <Icon name="broadcast" size={14} />
                            </span>
                        ) : null}
                    </li>
                    <li
                        className={`playlist-item ${viewMode === 'recently_added' ? 'active' : ''}`}
                        onClick={() => { onLibraryClick('recently_added'); onClose(); }}
                        onContextMenu={(e) => onLibraryContextMenu?.(e, 'recently_added')}
                    >
                        <span className="playlist-icon"><Icon name="sparkle" /></span>
                        <span className="item-label">{t('sidebar.recentlyAdded')}</span>
                        {librarySyncSources.includes('recently_added') ? (
                            <span className="playlist-sync-badge" title={t('sidebar.syncedToDevices')}>
                                <Icon name="broadcast" size={14} />
                            </span>
                        ) : null}
                    </li>
                    <li
                        className={`playlist-item ${viewMode === 'recently_played' ? 'active' : ''}`}
                        onClick={() => { onLibraryClick('recently_played'); onClose(); }}
                        onContextMenu={(e) => onLibraryContextMenu?.(e, 'recently_played')}
                    >
                        <span className="playlist-icon"><Icon name="clock" /></span>
                        <span className="item-label">{t('sidebar.recentlyPlayed')}</span>
                        {librarySyncSources.includes('recently_played') ? (
                            <span className="playlist-sync-badge" title={t('sidebar.syncedToDevices')}>
                                <Icon name="broadcast" size={14} />
                            </span>
                        ) : null}
                    </li>
                    <li
                        className={`playlist-item ${viewMode === 'artists' ? 'active' : ''}`}
                        onClick={() => { onLibraryClick('artists'); onClose(); }}
                    >
                        <span className="playlist-icon"><Icon name="mic" /></span>
                        <span className="item-label">{t('sidebar.artists')}</span>
                    </li>
                    <li
                        className={`playlist-item ${viewMode === 'albums' ? 'active' : ''}`}
                        onClick={() => { onLibraryClick('albums'); onClose(); }}
                    >
                        <span className="playlist-icon"><Icon name="disc" /></span>
                        <span className="item-label">{t('sidebar.albums')}</span>
                    </li>
                </ul>
            </div>

            <div className="sidebar-divider"></div>

            {/* Playlists Section */}
            <div className="sidebar-section scrollable">
                <div className="sidebar-header">
                    <h2>{t('sidebar.playlists')}</h2>
                </div>
                <ul className="playlist-list">
                    {playlists.map(pl => (
                        <li
                            key={pl.id}
                            className={`playlist-item ${currentPlaylistId === pl.id && viewMode === 'playlist' ? 'active' : ''}`}
                            onClick={() => { onPlaylistClick(pl.id); onClose(); }}
                            onContextMenu={(e) => onPlaylistContextMenu(e, pl.id)}
                        >
                            <span className="playlist-icon">
                                <Icon name={PLAYLIST_TYPE_ICON[pl.type] ?? 'list-music'} />
                            </span>
                            <span className="playlist-name">{pl.name}</span>
                            {pl.kind === 'podcast' ? (
                                <span className="playlist-kind-badge" role="img" aria-label={t('sidebar.podcast')} title={t('sidebar.podcast')}>
                                    <Icon name="podcast" size={14} />
                                </span>
                            ) : null}
                            {pl.sync_to_device ? (
                                <span className="playlist-sync-badge" title={t('sidebar.syncedToDevices')}>
                                    <Icon name="broadcast" size={14} />
                                </span>
                            ) : null}
                        </li>
                    ))}
                </ul>
            </div>

            <div className="sidebar-actions">
                {isScanning && (
                    <div className="sidebar-scan-status">
                        <span className="sidebar-scan-label">{scanLabel}</span>
                        <span className="sidebar-scan-bar">
                            {scanProgress && scanProgress.total > 0 && (
                                <i style={{ width: `${Math.min(100, (scanProgress.done / scanProgress.total) * 100)}%` }} />
                            )}
                        </span>
                        {onCancelScan && (
                            <button
                                className="sidebar-scan-cancel"
                                onClick={onCancelScan}
                                title={t('sidebar.cancelScan')}
                                aria-label={t('sidebar.cancelScan')}
                            >
                                <Icon name="x" size={12} />
                            </button>
                        )}
                    </div>
                )}
                {!isScanning && artworkProgress && (
                    <div className="sidebar-scan-status">
                        <span className="sidebar-scan-label">
                            {t('sidebar.loadingArtwork', { done: artworkProgress.done, total: artworkProgress.total })}
                        </span>
                        <span className="sidebar-scan-bar">
                            {artworkProgress.total > 0 && (
                                <i style={{ width: `${Math.min(100, (artworkProgress.done / artworkProgress.total) * 100)}%` }} />
                            )}
                        </span>
                        {onCancelThumbPrewarm && (
                            <button
                                className="sidebar-scan-cancel"
                                onClick={onCancelThumbPrewarm}
                                title={t('sidebar.cancelLoadingArtwork')}
                                aria-label={t('sidebar.cancelLoadingArtwork')}
                            >
                                <Icon name="x" size={12} />
                            </button>
                        )}
                    </div>
                )}
                <div className="sidebar-footer-row" ref={newMenuRef}>
                    {newMenuOpen && (
                        <div className="context-menu sidebar-new-menu">
                            <div
                                className="context-menu-item"
                                onClick={() => runAndClose(onCreatePlaylist)}
                            >
                                <Icon name="plus" size={16} /> {t('sidebar.newPlaylist')}
                            </div>
                            <div
                                className="context-menu-item"
                                onClick={() => runAndClose(onCreateSmartPlaylist)}
                            >
                                <Icon name="wand" size={16} /> {t('sidebar.newSmartPlaylist')}
                            </div>
                            <div
                                className={`context-menu-item ${isScanning ? 'disabled' : ''}`}
                                onClick={() => { if (!isScanning) runAndClose(onAddFolder); }}
                            >
                                <Icon name="folder" size={16} /> {t('sidebar.addMusicFolder')}
                            </div>
                        </div>
                    )}
                    <button
                        className="sidebar-btn sidebar-new-btn"
                        onClick={() => setNewMenuOpen(o => !o)}
                    >
                        <Icon name="plus" size={16} />
                        <span>{t('sidebar.new')}</span>
                        <Icon name={newMenuOpen ? 'chevron-down' : 'chevron-up'} size={14} />
                    </button>
                    <button
                        className="sidebar-btn sidebar-icon-btn sync-btn"
                        onClick={onSync}
                        title={t('sidebar.sync')}
                        aria-label={t('sidebar.sync')}
                    >
                        <Icon name="broadcast" size={16} />
                    </button>
                    <button
                        className="sidebar-btn sidebar-icon-btn"
                        onClick={onSettings}
                        title={t('sidebar.settings')}
                        aria-label={t('sidebar.settings')}
                    >
                        <Icon name="settings" size={16} />
                    </button>
                </div>
            </div>
        </aside>
    );
};
