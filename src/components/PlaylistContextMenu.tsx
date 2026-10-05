import React from 'react';
import { useTranslation } from 'react-i18next';
import { TrackKind } from '../types';
import { KINDS } from './ContextMenu';
import { Icon } from './Icon';
import { useMenuPosition } from '../hooks/useMenuPosition';
import { MenuDivider } from './Menu';

interface PlaylistContextMenuProps {
    visible: boolean;
    x: number;
    y: number;
    playlistId: string | null;
    /** type === 'smart' — hides Kind/Reset Manual Order (meaningless for a
     *  playlist with no stored membership) and shows Edit Smart Playlist…
     *  instead. */
    isSmart: boolean;
    syncToDevice: boolean;
    kind: TrackKind;
    /** True once the user has drag-reordered this playlist (see
     *  setPlaylistTrackOrder in db.ts) — shows the reset option. */
    manualOrder: boolean;
    onToggleSyncToDevice: (id: string) => void;
    onSetKind: (id: string, kind: TrackKind) => void;
    onResetManualOrder: (id: string) => void;
    onEditSmartPlaylist: (id: string) => void;
    onDelete: (id: string) => void;
}

export const PlaylistContextMenu: React.FC<PlaylistContextMenuProps> = ({
    visible,
    x,
    y,
    playlistId,
    isSmart,
    syncToDevice,
    kind,
    manualOrder,
    onToggleSyncToDevice,
    onSetKind,
    onResetManualOrder,
    onEditSmartPlaylist,
    onDelete
}) => {
    const { t } = useTranslation();
    const { ref, style } = useMenuPosition(visible, x, y);
    if (!visible) return null;

    return (
        <div
            ref={ref}
            className="context-menu"
            style={style}
            onClick={(e) => e.stopPropagation()}
        >
            {isSmart && (
                <>
                    <div className="context-menu-item" onClick={() => playlistId && onEditSmartPlaylist(playlistId)}>
                        {t('playlistMenu.editSmartPlaylist')}
                    </div>
                    <MenuDivider />
                </>
            )}
            <div
                className="context-menu-item context-menu-item-check"
                onClick={() => playlistId && onToggleSyncToDevice(playlistId)}
            >
                <span className="context-menu-check">{syncToDevice ? <Icon name="check" size={14} /> : null}</span>
                {t('playlistMenu.syncToDevice')}
            </div>
            {!isSmart && (
                <>
                    <MenuDivider />
                    <div className="context-menu-header">{t('contextMenu.kind')}</div>
                    {KINDS.map(k => (
                        <div
                            key={k.value}
                            className="context-menu-item"
                            onClick={() => playlistId && onSetKind(playlistId, k.value)}
                        >
                            {kind === k.value ? '✓ ' : '  '}{t(k.labelKey)}
                        </div>
                    ))}
                </>
            )}
            {!isSmart && manualOrder && (
                <>
                    <MenuDivider />
                    <div className="context-menu-item" onClick={() => playlistId && onResetManualOrder(playlistId)}>
                        {t('playlistMenu.resetManualOrder')}
                    </div>
                </>
            )}
            <MenuDivider />
            <div className="context-menu-item" onClick={() => playlistId && onDelete(playlistId)}>
                {t('playlistMenu.deletePlaylist')}
            </div>
        </div>
    );
};
