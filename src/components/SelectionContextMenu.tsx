import React from 'react';
import { useTranslation } from 'react-i18next';
import { Playlist, Track } from '../types';
import { useMenuPosition } from '../hooks/useMenuPosition';
import { useMenuKeyboard } from '../hooks/useMenuKeyboard';
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
    onRemoveFromPlaylist?: (tracks: Track[]) => void;
    onClose: () => void;
}

export const SelectionContextMenu: React.FC<SelectionContextMenuProps> = ({
    visible, x, y, tracks, playlists, onPlay, onAddToQueue, onAddToPlaylist, onRemoveFromPlaylist, onClose
}) => {
    const { t } = useTranslation();
    const { ref, style } = useMenuPosition(visible, x, y);
    const menuProps = useMenuKeyboard(ref, visible, onClose);
    if (!visible) return null;
    const customPlaylists = playlists.filter(p => p.type === 'custom');

    return (
        <div ref={ref} className="context-menu" {...menuProps} style={style} onClick={(e) => e.stopPropagation()}>
            <div className="context-menu-header">{t('selectionMenu.tracksSelected', { count: tracks.length })}</div>
            <div role="menuitem" tabIndex={-1} className="context-menu-item" onClick={() => { onPlay(tracks); onClose(); }}>{t('contextMenu.play')}</div>
            <div role="menuitem" tabIndex={-1} className="context-menu-item" onClick={() => { onAddToQueue(tracks); onClose(); }}>{t('contextMenu.addToQueue')}</div>
            {onRemoveFromPlaylist && (
                <div role="menuitem" tabIndex={-1} className="context-menu-item" onClick={() => { onRemoveFromPlaylist(tracks); onClose(); }}>{t('contextMenu.removeFromPlaylist')}</div>
            )}
            <MenuDivider />
            <div className="context-menu-header">{t('contextMenu.addToPlaylist')}</div>
            {customPlaylists.length > 0 ? (
                customPlaylists.map(pl => (
                    <div key={pl.id} role="menuitem" tabIndex={-1} className="context-menu-item" onClick={() => { onAddToPlaylist(pl.id, tracks); onClose(); }}>
                        {pl.name}
                    </div>
                ))
            ) : (
                <div role="menuitem" tabIndex={-1} className="context-menu-item disabled">{t('contextMenu.noCustomPlaylists')}</div>
            )}
        </div>
    );
};
