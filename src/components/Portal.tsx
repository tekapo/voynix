import React from 'react';
import { createPortal } from 'react-dom';

// Render modals at <body> so the fixed-position overlay isn't offset by an
// ancestor that establishes a containing block (the sidebar's transform, the
// header/player-bar backdrop-filter, …).
export const Portal: React.FC<{ children: React.ReactNode }> = ({ children }) =>
    createPortal(children, document.body);
