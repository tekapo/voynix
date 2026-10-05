import React from 'react';
import { useTranslation } from 'react-i18next';
import { Playlist, Track, TrackKind } from '../types';
import { useMenuPosition } from '../hooks/useMenuPosition';
import { MenuDivider } from './Menu';

interface ContextMenuProps {
    visible: boolean;
    x: number;
    y: number;
    track: Track | null;
    playlists: Playlist[];
    onAddToPlaylist: (playlistId: string, track: Track) => void;
    onAddToQueue?: (track: Track) => void;
    onShowInFinder: (track: Track) => void;
    onSetArtwork: (track: Track) => void;
    onFindAlbumCover?: (track: Track) => void;
    onSetAlbumCover?: (track: Track) => void;
    onResetAlbumCover?: (track: Track) => void;
    onToggleFavorite: (track: Track) => void;
    onSetKind?: (track: Track, kind: TrackKind) => void;
    onSetPlayState?: (track: Track, state: 'unplayed' | 'played') => void;
    onGetInfo?: (track: Track) => void;
    onClose: () => void;
}

export const KINDS: { value: TrackKind; labelKey: 'contextMenu.kindMusic' | 'contextMenu.kindPodcast' | 'contextMenu.kindOther' }[] = [
    { value: 'music', labelKey: 'contextMenu.kindMusic' },
    { value: 'podcast', labelKey: 'contextMenu.kindPodcast' },
    { value: 'other', labelKey: 'contextMenu.kindOther' },
];

export const TrackContextMenu: React.FC<ContextMenuProps> = ({
    visible,
    x,
    y,
    track,
    playlists,
    onAddToPlaylist,
    onAddToQueue,
    onShowInFinder,
    onSetArtwork,
    onFindAlbumCover,
    onSetAlbumCover,
    onResetAlbumCover,
    onToggleFavorite,
    onSetKind,
    onSetPlayState,
    onGetInfo,
    onClose
}) => {
    const { t } = useTranslation();
    const { ref, style } = useMenuPosition(visible, x, y);
    if (!visible) return null;
    const customPlaylists = playlists.filter(p => p.type === 'custom');
    const kind: TrackKind = track?.kind ?? 'music';

    return (
        <div
            ref={ref}
            className="context-menu"
            style={style}
            onClick={(e) => e.stopPropagation()}
        >
            {onGetInfo && (
                <div className="context-menu-item" onClick={() => {
                    if (track) onGetInfo(track);
                    onClose();
                }}>
                    {t('contextMenu.getInfo')}
                </div>
            )}
            <div className="context-menu-item" onClick={() => {
                if (track) onToggleFavorite(track);
                onClose();
            }}>
                {track?.favorite ? t('contextMenu.removeFromFavorites') : t('contextMenu.addToFavorites')}
            </div>
            {onAddToQueue && (
                <div className="context-menu-item" onClick={() => {
                    if (track) onAddToQueue(track);
                    onClose();
                }}>
                    {t('contextMenu.addToQueue')}
                </div>
            )}
            <div className="context-menu-item" onClick={() => {
                if (track) onShowInFinder(track);
                onClose();
            }}>
                {t('contextMenu.showInFinder')}
            </div>
            <div className="context-menu-item" onClick={() => {
                if (track) onSetArtwork(track);
                onClose();
            }}>
                {t('contextMenu.setArtwork')}
            </div>
            {onFindAlbumCover && (
                <div className="context-menu-item" onClick={() => {
                    if (track) onFindAlbumCover(track);
                    onClose();
                }}>
                    {t('contextMenu.findAlbumCover')}
                </div>
            )}
            {onSetAlbumCover && (
                <div className="context-menu-item" onClick={() => {
                    if (track) onSetAlbumCover(track);
                    onClose();
                }}>
                    {t('contextMenu.setAlbumCover')}
                </div>
            )}
            {onResetAlbumCover && (
                <div className="context-menu-item" onClick={() => {
                    if (track) onResetAlbumCover(track);
                    onClose();
                }}>
                    {t('contextMenu.resetAlbumCover')}
                </div>
            )}
            {onSetKind && (
                <>
                    <MenuDivider />
                    <div className="context-menu-header">{t('contextMenu.kind')}</div>
                    {KINDS.map(k => (
                        <div
                            key={k.value}
                            className="context-menu-item"
                            onClick={() => {
                                if (track) onSetKind(track, k.value);
                                onClose();
                            }}
                        >
                            {kind === k.value ? '✓ ' : '  '}{t(k.labelKey)}
                        </div>
                    ))}
                    {kind === 'podcast' && onSetPlayState && (
                        <>
                            <div className="context-menu-item" onClick={() => {
                                if (track) onSetPlayState(track, track.play_state === 'played' ? 'unplayed' : 'played');
                                onClose();
                            }}>
                                {track?.play_state === 'played' ? t('contextMenu.markAsUnplayed') : t('contextMenu.markAsPlayed')}
                            </div>
                        </>
                    )}
                </>
            )}
            <MenuDivider />
            <div className="context-menu-header">{t('contextMenu.addToPlaylist')}</div>
            {customPlaylists.length > 0 ? (
                customPlaylists.map(pl => (
                    <div
                        key={pl.id}
                        className="context-menu-item"
                        onClick={() => {
                            if (track) onAddToPlaylist(pl.id, track);
                            onClose();
                        }}
                    >
                        {pl.name}
                    </div>
                ))
            ) : (
                <div className="context-menu-item disabled">{t('contextMenu.noCustomPlaylists')}</div>
            )}
        </div>
    );
};
