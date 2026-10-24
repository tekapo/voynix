import React from 'react';

/** Separator line shared by every context menu (ContextMenu, Album/Artist/
 *  Selection/PlaylistContextMenu). */
export const MenuDivider: React.FC = () =>
    <div className="context-menu-divider" style={{ height: '1px', background: 'var(--line)', margin: '4px 0' }}></div>;
