import React from 'react';
import { useTranslation } from 'react-i18next';
import { Playlist, Track } from '../types';
import { UNKNOWN_ARTIST } from '../names';
import { useMenuPosition } from '../hooks/useMenuPosition';
import { MenuDivider } from './Menu';

interface ArtistContextMenuProps {
    visible: boolean;
    x: number;
    y: number;
    /** Artist name shown in the menu header. */
    artist: string | null;
    /** A representative track for the artist — stands in for "play this
     *  artist" (see LibraryView's artFor). Null while the library hasn't
     *  resolved one yet, in which case Play/Set/Reset are hidden rather than
     *  acting on nothing. */
    track: Track | null;
    playlists: Playlist[];
    onPlay: (track: Track) => void;
    onAddToQueue?: (track: Track) => void;
    /** Adds every track by this artist to the given playlist. */
    onAddToPlaylist: (playlistId: string, artist: string) => void;
    onSetArtistImage: (artist: string) => void;
    onFindArtistImage: (artist: string) => void;
    onResetArtistImage: (artist: string) => void;
    onClose: () => void;
}

export const ArtistContextMenu: React.FC<ArtistContextMenuProps> = ({
    visible,
    x,
    y,
    artist,
    track,
    playlists,
    onPlay,
    onAddToQueue,
    onAddToPlaylist,
    onSetArtistImage,
    onFindArtistImage,
    onResetArtistImage,
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
            {artist && <div className="context-menu-header">{artist === UNKNOWN_ARTIST ? t('common.unknownArtist') : artist}</div>}
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
            <div className={`context-menu-item ${artist ? '' : 'disabled'}`} onClick={() => {
                if (artist) onFindArtistImage(artist);
                onClose();
            }}>
                {t('artistMenu.findArtistImage')}
            </div>
            <div className={`context-menu-item ${artist ? '' : 'disabled'}`} onClick={() => {
                if (artist) onSetArtistImage(artist);
                onClose();
            }}>
                {t('artistMenu.setArtistImage')}
            </div>
            <div className={`context-menu-item ${artist ? '' : 'disabled'}`} onClick={() => {
                if (artist) onResetArtistImage(artist);
                onClose();
            }}>
                {t('artistMenu.resetArtistImage')}
            </div>
            <MenuDivider />
            <div className="context-menu-header">{t('contextMenu.addToPlaylist')}</div>
            {customPlaylists.length > 0 ? (
                customPlaylists.map(pl => (
                    <div
                        key={pl.id}
                        className={`context-menu-item ${artist ? '' : 'disabled'}`}
                        onClick={() => {
                            if (artist) onAddToPlaylist(pl.id, artist);
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
