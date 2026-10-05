import React from 'react';
import { useTranslation } from 'react-i18next';
import { Playlist, Track } from '../types';
import { useMenuPosition } from '../hooks/useMenuPosition';
import { MenuDivider } from './Menu';

interface SelectionContextMenuProps {
    visible: boolean;
    x: number;
    y: number;
    /** The multi-selected tracks, in list order. */
    tracks: Track[];
    playlists: Playlist[];
    onPlay: (tracks: Track[]) => void;
    onAddToQueue: (tracks: Track[]) => void;
    onAddToPlaylist: (playlistId: string, tracks: Track[]) => void;
    onClose: () => void;
}

export const SelectionContextMenu: React.FC<SelectionContextMenuProps> = ({
    visible, x, y, tracks, playlists, onPlay, onAddToQueue, onAddToPlaylist, onClose
}) => {
    const { t } = useTranslation();
    const { ref, style } = useMenuPosition(visible, x, y);
    if (!visible) return null;
    const customPlaylists = playlists.filter(p => p.type === 'custom');

    return (
        <div ref={ref} className="context-menu" style={style} onClick={(e) => e.stopPropagation()}>
            <div className="context-menu-header">{t('selectionMenu.tracksSelected', { count: tracks.length })}</div>
            <div className="context-menu-item" onClick={() => { onPlay(tracks); onClose(); }}>{t('contextMenu.play')}</div>
            <div className="context-menu-item" onClick={() => { onAddToQueue(tracks); onClose(); }}>{t('contextMenu.addToQueue')}</div>
            <MenuDivider />
            <div className="context-menu-header">{t('contextMenu.addToPlaylist')}</div>
            {customPlaylists.length > 0 ? (
                customPlaylists.map(pl => (
                    <div key={pl.id} className="context-menu-item" onClick={() => { onAddToPlaylist(pl.id, tracks); onClose(); }}>
                        {pl.name}
                    </div>
                ))
            ) : (
                <div className="context-menu-item disabled">{t('contextMenu.noCustomPlaylists')}</div>
            )}
        </div>
    );
};
