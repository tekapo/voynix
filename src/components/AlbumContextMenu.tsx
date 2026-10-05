import React from 'react';
import { useTranslation } from 'react-i18next';
import { Playlist, Track } from '../types';
import { useMenuPosition } from '../hooks/useMenuPosition';
import { MenuDivider } from './Menu';

interface AlbumContextMenuProps {
    visible: boolean;
    x: number;
    y: number;
    /** Album name shown in the menu header. */
    album: string | null;
    /** A representative track for the album — resolves the (artist, album)
     *  cover key and stands in for "play this album" (see LibraryView's
     *  artFor). Null while the thumbnail cache hasn't resolved one yet, in
     *  which case Play/Set/Reset are hidden rather than acting on nothing. */
    track: Track | null;
    playlists: Playlist[];
    onPlay: (track: Track) => void;
    onAddToQueue?: (track: Track) => void;
    /** Adds every track in this album to the given playlist. */
    onAddToPlaylist: (playlistId: string, track: Track) => void;
    onFindAlbumCover: (track: Track) => void;
    onSetAlbumCover: (track: Track) => void;
    onResetAlbumCover: (track: Track) => void;
    onGetInfo?: (track: Track) => void;
    onClose: () => void;
}

export const AlbumContextMenu: React.FC<AlbumContextMenuProps> = ({
    visible,
    x,
    y,
    album,
    track,
    playlists,
    onPlay,
    onAddToQueue,
    onAddToPlaylist,
    onFindAlbumCover,
    onSetAlbumCover,
    onResetAlbumCover,
    onGetInfo,
    onClose
}) => {
    const { t } = useTranslation();
    const { ref, style } = useMenuPosition(visible, x, y);
    if (!visible) return null;

    const customPlaylists = playlists.filter(p => p.type === 'custom');

    return (
        <div
            ref={ref}
            className="context-menu"
            style={style}
            onClick={(e) => e.stopPropagation()}
        >
            {album && <div className="context-menu-header">{album}</div>}
            <div className={`context-menu-item ${track ? '' : 'disabled'}`} onClick={() => {
                if (track) onPlay(track);
                onClose();
            }}>
                {t('contextMenu.play')}
            </div>
            {onAddToQueue && (
                <div className={`context-menu-item ${track ? '' : 'disabled'}`} onClick={() => {
                    if (track) onAddToQueue(track);
                    onClose();
                }}>
                    {t('contextMenu.addToQueue')}
                </div>
            )}
            <MenuDivider />
            {onGetInfo && (
                <div className={`context-menu-item ${track ? '' : 'disabled'}`} onClick={() => {
                    if (track) onGetInfo(track);
                    onClose();
                }}>
                    {t('contextMenu.getInfo')}
                </div>
            )}
            <div className={`context-menu-item ${track ? '' : 'disabled'}`} onClick={() => {
                if (track) onFindAlbumCover(track);
                onClose();
            }}>
                {t('contextMenu.findAlbumCover')}
            </div>
            <div className={`context-menu-item ${track ? '' : 'disabled'}`} onClick={() => {
                if (track) onSetAlbumCover(track);
                onClose();
            }}>
                {t('contextMenu.setAlbumCover')}
            </div>
            <div className={`context-menu-item ${track ? '' : 'disabled'}`} onClick={() => {
                if (track) onResetAlbumCover(track);
                onClose();
            }}>
                {t('contextMenu.resetAlbumCover')}
            </div>
            <MenuDivider />
            <div className="context-menu-header">{t('contextMenu.addToPlaylist')}</div>
            {customPlaylists.length > 0 ? (
                customPlaylists.map(pl => (
                    <div
                        key={pl.id}
                        className={`context-menu-item ${track ? '' : 'disabled'}`}
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
