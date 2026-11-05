import React from 'react';
import { useTranslation } from 'react-i18next';
import { LibrarySyncSource } from '../smartLists';
import { Icon } from './Icon';
import { useMenuPosition } from '../hooks/useMenuPosition';
import { useMenuKeyboard } from '../hooks/useMenuKeyboard';

interface LibraryItemContextMenuProps {
    visible: boolean;
    x: number;
    y: number;
    source: LibrarySyncSource | null;
    syncToDevice: boolean;
    onToggleSyncToDevice: (source: LibrarySyncSource) => void;
    onClose: () => void;
}

export const LibraryItemContextMenu: React.FC<LibraryItemContextMenuProps> = ({
    visible, x, y, source, syncToDevice, onToggleSyncToDevice, onClose
}) => {
    const { t } = useTranslation();
    const { ref, style } = useMenuPosition(visible, x, y);
    const menuProps = useMenuKeyboard(ref, visible, onClose);
    if (!visible) return null;

    return (
        <div
            ref={ref}
            className="context-menu" {...menuProps}
            style={style}
            onClick={(e) => e.stopPropagation()}
        >
            <div
                role="menuitem" tabIndex={-1}
                className="context-menu-item context-menu-item-check"
                onClick={() => source && onToggleSyncToDevice(source)}
            >
                <span className="context-menu-check">{syncToDevice ? <Icon name="check" size={14} /> : null}</span>
                {t('playlistMenu.syncToDevice')}
            </div>
        </div>
    );
};
