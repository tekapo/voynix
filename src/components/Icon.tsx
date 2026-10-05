import React from 'react';

/**
 * Inline SVG icon set. One file so the `IconName` union and the `ICONS`
 * record stay adjacent and `tsc` checks the record is exhaustive.
 *
 * All paths are drawn on a 24x24 grid. Outline icons stroke `currentColor`;
 * solid icons fill it. Nothing here sets `color` — the button/parent does,
 * which is the whole point of the switch away from colour-emoji glyphs.
 */
export type IconName =
    | 'music'
    | 'star'
    | 'star-filled'
    | 'flame'
    | 'mic'
    | 'disc'
    | 'folder'
    | 'file-text'
    | 'smartphone'
    | 'list-music'
    | 'broadcast'
    | 'podcast'
    | 'settings'
    | 'plus'
    | 'menu'
    | 'queue'
    | 'search'
    | 'shuffle'
    | 'repeat'
    | 'repeat-one'
    | 'skip-back'
    | 'skip-forward'
    | 'skip-back-10'
    | 'skip-forward-10'
    | 'rewind'
    | 'fast-forward'
    | 'play'
    | 'pause'
    | 'volume'
    | 'lyrics'
    | 'chevron-up'
    | 'chevron-down'
    | 'chevron-left'
    | 'chevron-right'
    | 'arrow-left'
    | 'more-vertical'
    | 'x'
    | 'check'
    | 'sparkle'
    | 'clock'
    | 'grid'
    | 'list'
    | 'wand';

interface IconDef {
    /** SVG child markup. */
    body: React.ReactNode;
    /** Solid icons fill currentColor instead of stroking it. */
    solid?: boolean;
}

const ICONS: Record<IconName, IconDef> = {
    music: {
        body: (
            <>
                <path d="M9 18V5l12-2v13" />
                <circle cx="6" cy="18" r="3" />
                <circle cx="18" cy="16" r="3" />
            </>
        ),
    },
    star: {
        body: <path d="M12 3l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.8 6.2 21l1.1-6.5L2.6 9.8l6.5-.9L12 3z" />,
    },
    'star-filled': {
        solid: true,
        body: <path d="M12 3l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.8 6.2 21l1.1-6.5L2.6 9.8l6.5-.9L12 3z" />,
    },
    flame: {
        body: (
            <path d="M12 3c1 3-2 4-2 7a2 2 0 004 0c0-1 0-2-1-3 3 1 5 3.5 5 7a6 6 0 01-12 0c0-4 3-6 6-8z" />
        ),
    },
    mic: {
        body: (
            <>
                <rect x="9" y="3" width="6" height="11" rx="3" />
                <path d="M6 11a6 6 0 0012 0M12 17v4M8 21h8" />
            </>
        ),
    },
    disc: {
        body: (
            <>
                <circle cx="12" cy="12" r="9" />
                <circle cx="12" cy="12" r="2.5" />
            </>
        ),
    },
    folder: {
        body: <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />,
    },
    'file-text': {
        body: (
            <>
                <path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8l-5-5z" />
                <path d="M14 3v5h5M9 13h6M9 17h6" />
            </>
        ),
    },
    smartphone: {
        body: (
            <>
                <rect x="7" y="3" width="10" height="18" rx="2" />
                <path d="M11 18h2" />
            </>
        ),
    },
    'list-music': {
        body: (
            <>
                <path d="M4 6h11M4 12h11M4 18h7" />
                <circle cx="17" cy="17" r="3" />
                <path d="M20 17V8l-3 1" />
            </>
        ),
    },
    broadcast: {
        body: (
            <>
                <circle cx="12" cy="12" r="2" />
                <path d="M7.8 7.8a6 6 0 000 8.4M16.2 16.2a6 6 0 000-8.4M4.9 4.9a10 10 0 000 14.2M19.1 19.1a10 10 0 000-14.2" />
            </>
        ),
    },
    podcast: {
        body: (
            <>
                <circle cx="12" cy="10" r="3" />
                <path d="M7.5 15.5a6 6 0 010-8.5M16.5 7a6 6 0 010 8.5M12 14v7" />
            </>
        ),
    },
    settings: {
        // 8-tooth gear, generated so every extent is equal in x and y and
        // centred on (12,12) — the old hand-drawn path was 15u wide by 20u
        // tall and rendered visibly 縦長 (taller than wide).
        body: (
            <>
                <circle cx="12" cy="12" r="3" />
                <path d="M10.4 2.6 L13.6 2.6 L14.4 6.2 L17.5 4.3 L19.7 6.5 L17.8 9.6 L21.4 10.4 L21.4 13.6 L17.8 14.4 L19.7 17.5 L17.5 19.7 L14.4 17.8 L13.6 21.4 L10.4 21.4 L9.6 17.8 L6.5 19.7 L4.3 17.5 L6.2 14.4 L2.6 13.6 L2.6 10.4 L6.2 9.6 L4.3 6.5 L6.5 4.3 L9.6 6.2 Z" />
            </>
        ),
    },
    plus: { body: <path d="M12 5v14M5 12h14" /> },
    menu: { body: <path d="M4 6h16M4 12h16M4 18h16" /> },
    queue: { body: <path d="M4 6h11M4 12h11M4 18h11M18 8v9M18 8l3-1" /> },
    search: {
        body: (
            <>
                <circle cx="11" cy="11" r="7" />
                <path d="M20 20l-3.5-3.5" />
            </>
        ),
    },
    shuffle: {
        body: (
            <path d="M18 4l3 3-3 3M18 14l3 3-3 3M3 7h4l10 10h4M3 17h4l3-3M14 7h3" />
        ),
    },
    repeat: { body: <path d="M17 2l3 3-3 3M4 11V9a4 4 0 014-4h12M7 22l-3-3 3-3M20 13v2a4 4 0 01-4 4H4" /> },
    'repeat-one': {
        body: (
            <>
                <path d="M17 2l3 3-3 3M4 11V9a4 4 0 014-4h12M7 22l-3-3 3-3M20 13v2a4 4 0 01-4 4H4" />
                <path d="M12 10.5l1.5-1V15" />
            </>
        ),
    },
    'skip-back': { solid: true, body: <path d="M18 5v14L8 12l10-7zM6 5h2v14H6z" /> },
    'skip-forward': { solid: true, body: <path d="M6 5v14l10-7L6 5zm12 0h-2v14h2z" /> },
    rewind: { solid: true, body: <path d="M11 5v14L2 12l9-7zm11 0v14l-9-7 9-7z" /> },
    'fast-forward': { solid: true, body: <path d="M2 5v14l9-7-9-7zm11 0v14l9-7-9-7z" /> },
    // Circular-arrow "jump back 10s" / "jump forward 10s". The arc strokes
    // currentColor; the "10" is filled (stroke:none) so it stays legible small.
    'skip-back-10': {
        body: (
            <>
                <polyline points="3 5 3 10 8 10" />
                <path d="M5 13a8 8 0 1 0 2-6.3L3 10" />
                <text x="12" y="15.5" textAnchor="middle" fontSize="8" fontWeight="700" fill="currentColor" stroke="none">10</text>
            </>
        ),
    },
    'skip-forward-10': {
        body: (
            <>
                <polyline points="21 5 21 10 16 10" />
                <path d="M19 13a8 8 0 1 1-2-6.3L21 10" />
                <text x="12" y="15.5" textAnchor="middle" fontSize="8" fontWeight="700" fill="currentColor" stroke="none">10</text>
            </>
        ),
    },
    play: { solid: true, body: <path d="M7 4l13 8L7 20V4z" /> },
    pause: { solid: true, body: <path d="M7 4h4v16H7zM13 4h4v16h-4z" /> },
    volume: {
        body: <path d="M11 5L6 9H3v6h3l5 4V5zM16 9a4 4 0 010 6M18.5 6.5a8 8 0 010 11" />,
    },
    lyrics: {
        body: (
            <>
                <path d="M4 6h10M4 10h10M4 14h6" />
                <circle cx="17" cy="16" r="3" />
                <path d="M20 16V7l-3 1" />
            </>
        ),
    },
    'chevron-up': { body: <path d="M6 15l6-6 6 6" /> },
    'chevron-down': { body: <path d="M6 9l6 6 6-6" /> },
    'chevron-left': { body: <path d="M15 6l-6 6 6 6" /> },
    'chevron-right': { body: <path d="M9 6l6 6-6 6" /> },
    'arrow-left': { body: <path d="M19 12H5M12 19l-7-7 7-7" /> },
    'more-vertical': {
        solid: true,
        body: (
            <>
                <circle cx="12" cy="5" r="1.6" />
                <circle cx="12" cy="12" r="1.6" />
                <circle cx="12" cy="19" r="1.6" />
            </>
        ),
    },
    x: { body: <path d="M6 6l12 12M18 6L6 18" /> },
    check: { body: <path d="M5 13l4 4L19 7" /> },
    sparkle: {
        solid: true,
        body: (
            <>
                <path d="M12 2l1.8 5.4L19 9l-5.2 1.6L12 16l-1.8-5.4L5 9l5.2-1.6L12 2z" />
                <path d="M19 15l.9 2.6L22.5 18.5l-2.6.9L19 22l-.9-2.6-2.6-.9 2.6-.9L19 15z" />
            </>
        ),
    },
    clock: {
        body: (
            <>
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v5l3.5 2" />
            </>
        ),
    },
    grid: {
        body: (
            <>
                <rect x="3" y="3" width="8" height="8" rx="1.5" />
                <rect x="13" y="3" width="8" height="8" rx="1.5" />
                <rect x="3" y="13" width="8" height="8" rx="1.5" />
                <rect x="13" y="13" width="8" height="8" rx="1.5" />
            </>
        ),
    },
    list: {
        body: <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />,
    },
    wand: {
        body: (
            <>
                <path d="M4 20L15 9" />
                <path d="M17 3l.9 2.1L20 6l-2.1.9L17 9l-.9-2.1L14 6l2.1-.9L17 3zM6 13l.6 1.4L8 15l-1.4.6L6 17l-.6-1.4L4 15l1.4-.6L6 13z" />
            </>
        ),
    },
};

interface IconProps {
    name: IconName;
    /** Pixel size; overridden by any CSS width/height on `.icon`. */
    size?: number;
    className?: string;
}

export const Icon: React.FC<IconProps> = ({ name, size = 18, className }) => {
    const def = ICONS[name];
    const solid = def.solid ?? false;
    return (
        <svg
            className={className ? `icon ${className}` : 'icon'}
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill={solid ? 'currentColor' : 'none'}
            stroke={solid ? 'none' : 'currentColor'}
            strokeWidth={1.75}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            focusable="false"
        >
            {def.body}
        </svg>
    );
};
