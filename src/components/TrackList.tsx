import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useTranslation } from 'react-i18next';
import { albumOf } from '../albumName';
import { artistLabel } from '../names';
import { SortKey, SortState } from '../trackSort';
import { Track } from '../types';
import { RatingButtons } from "./RatingButtons";
import { Icon } from './Icon';
import { podcastBadge, podcastDurationText } from './trackFormat';

const rowId = (trackId: string) => `track-row-${trackId}`;

// Hoisted so React can bail out on the identical element reference — the star
// renders once per row across a library that can run to thousands of tracks.

// Below this, render every row directly (today's behaviour, unchanged) — a
// typical playlist (tens to a few hundred tracks) gets no windowing at all,
// which keeps it simple and keeps every existing DOM-based test valid.
// Above it (e.g. an "All Songs" view over a multi-thousand-track library —
// a 2,591-track report motivated this), only the visible rows (+ overscan)
// are mounted via @tanstack/react-virtual. See TrackList.test.tsx's "virtualized rendering"
// describe block for the behavioural contract this threshold protects.
const VIRTUALIZE_THRESHOLD = 300;
// Rows never wrap (see .cell-title/.cell-text's white-space: nowrap in
// styles/tracklist.css) so every row is the same height within a given breakpoint/setting
// — this is just a first-paint guess; the real height is measured per row
// (virtualizer.measureElement below) and converges immediately.
const ESTIMATED_ROW_HEIGHT = 38;
// Matches .track-item's `margin-bottom: 2px` (styles/tracklist.css) — told to the
// virtualizer directly (via `gap`) rather than left on the CSS, since
// getBoundingClientRect()/ResizeObserver (which measureElement uses) don't
// include margin, and a virtualizer that doesn't know about the gap would
// under-space rows.
const ROW_GAP = 2;

export type ResizableColumn = 'title' | 'artist' | 'album' | 'path' | 'time';
/** Custom column widths in px, keyed by column. Absent = the CSS default (fr). */
export type ColumnWidths = Partial<Record<ResizableColumn, number>>;
const MIN_COLUMN_WIDTH = 60;
// The Time column's default is the measured width of "00:00:00", which can be
// narrower than MIN_COLUMN_WIDTH, so it gets its own floor.
const MIN_TIME_COLUMN_WIDTH = 40;

interface TrackListProps {
    tracks: Track[];
    /** The cued/armed track — a single click sets this. Gets a selection highlight. */
    currentTrack: Track | null;
    /** The track actually loaded in the player (playing or paused) — now-playing marker. */
    loadedTrackId?: string | null;
    /** Show the file-path column. Off by default; toggled in Settings. */
    showPath?: boolean;
    /** Active column sort, or null for the view's natural order. */
    sortState?: SortState | null;
    /** Header click — cycles asc -> desc -> off for that column. */
    onSort?: (key: SortKey) => void;
    /** Single click — cue the track, don't play. */
    onTrackClick: (track: Track) => void;
    /** Double click — play the track now. */
    onTrackActivate: (track: Track) => void;
    onContextMenu: (e: React.MouseEvent, track: Track) => void;
    /** Right-click on a row that's part of a multi-selection (⌘/Ctrl-click
     *  toggles, Shift-click selects a range). Gets the selected tracks in list
     *  order. Without it, multi-select is disabled. */
    onSelectionContextMenu?: (e: React.MouseEvent, tracks: Track[]) => void;
    onToggleFavorite: (track: Track) => void;
    onToggleDislike: (track: Track) => void;
    /** Enables drag-and-drop row reordering (a manually-ordered playlist view
     *  only — disabled while a column sort or search filter is active, since
     *  then row index no longer matches the underlying DB position). */
    reorderable?: boolean;
    /** Drop `from` onto `to` (both indices into the currently rendered `tracks`). */
    onReorder?: (from: number, to: number) => void;
    /** Custom text-column widths. Omit `onColumnWidthsChange` to disable resizing. */
    columnWidths?: ColumnWidths;
    /** Drag finished (called once, on release) / handle double-clicked (reset). */
    onColumnWidthsChange?: (widths: ColumnWidths) => void;
}

const TrackListInner: React.FC<TrackListProps> = ({ tracks, currentTrack, loadedTrackId = null, showPath = false, sortState = null, onSort, onTrackClick, onTrackActivate, onContextMenu, onSelectionContextMenu, onToggleFavorite, onToggleDislike, reorderable = false, onReorder, columnWidths, onColumnWidthsChange }) => {
    const { t } = useTranslation();
    // Index of the row currently being dragged, and the row currently under
    // the pointer (for a drop-position indicator). Local UI state only — the
    // actual reorder is committed on drop via onReorder.
    const [dragIndex, setDragIndex] = useState<number | null>(null);
    const [overIndex, setOverIndex] = useState<number | null>(null);
    // Multi-selection (⌘/Ctrl-click toggle, Shift-click range). Kept as ids so it
    // survives re-sorting; ids no longer in `tracks` are ignored via `selected`.
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const anchorRef = useRef<number | null>(null);
    // Keyboard cursor (listbox with aria-activedescendant: focus stays on the
    // <ul>, which survives the virtualizer unmounting rows). null until the
    // list is first focused or a row clicked.
    const [activeIndex, setActiveIndex] = useState<number | null>(null);
    const listRef = useRef<HTMLUListElement>(null);
    const selected = useMemo(
        () => tracks.filter(t => selectedIds.has(t.id)),
        [tracks, selectedIds],
    );
    const multi = selected.length > 1;

    const handleRowClick = (e: React.MouseEvent, track: Track, index: number) => {
        setActiveIndex(index);
        // Rows aren't focusable themselves; park focus on the list so the arrow
        // keys carry on from the clicked row.
        listRef.current?.focus({ preventScroll: true });
        if (onSelectionContextMenu && (e.metaKey || e.ctrlKey)) {
            setSelectedIds(prev => {
                const next = new Set(prev);
                if (next.has(track.id)) next.delete(track.id); else next.add(track.id);
                return next;
            });
            anchorRef.current = index;
            return;
        }
        if (onSelectionContextMenu && e.shiftKey && anchorRef.current !== null) {
            const [lo, hi] = [Math.min(anchorRef.current, index), Math.max(anchorRef.current, index)];
            setSelectedIds(new Set(tracks.slice(lo, hi + 1).map(t => t.id)));
            return;
        }
        if (selectedIds.size > 0) setSelectedIds(new Set());
        anchorRef.current = index;
        onTrackClick(track);
    };

    const handleRowContextMenu = (e: React.MouseEvent, track: Track) => {
        if (onSelectionContextMenu && multi && selectedIds.has(track.id)) {
            e.preventDefault();
            onSelectionContextMenu(e, selected);
            return;
        }
        if (selectedIds.size > 0) setSelectedIds(new Set());
        onContextMenu(e, track);
    };

    // Widths shown while a column drag is in flight; committed (one DB write)
    // on release. Falls back to the saved widths otherwise.
    const [liveWidths, setLiveWidths] = useState<ColumnWidths | null>(null);
    const [dragKey, setDragKey] = useState<ResizableColumn | null>(null);
    const widths = liveWidths ?? columnWidths ?? {};
    // The last text column takes whatever width is left, so the row can never
    // overflow no matter how wide the others are dragged.
    const flexColumn: 'path' | 'album' = showPath ? 'path' : 'album';

    // Default Time width: just wide enough for the widest HH:MM:SS (tabular
    // digits), measured from a hidden cell styled like a real one. Stays null
    // until measured (and where nothing lays out, e.g. jsdom) so the CSS
    // fallback applies.
    const timeSizerRef = useRef<HTMLSpanElement>(null);
    const [timeDefaultWidth, setTimeDefaultWidth] = useState<number | null>(null);
    useLayoutEffect(() => {
        const measure = () => {
            const w = timeSizerRef.current?.getBoundingClientRect().width ?? 0;
            if (w > 0) setTimeDefaultWidth(Math.ceil(w));
        };
        measure();
        // Web fonts can change the digit width after first paint.
        void document.fonts?.ready.then(measure);
    }, []);

    // Window-level listeners rather than pointer capture: SortHeader below is
    // re-created every render, so the handle remounts on each live update.
    const startResize = (key: ResizableColumn, e: React.PointerEvent<HTMLElement>) => {
        const cell = e.currentTarget.parentElement;
        if (!cell || e.button > 0) return;
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX;
        const startWidth = cell.getBoundingClientRect().width;
        const flexWidth = headerRef.current?.querySelector('.th-flex')?.getBoundingClientRect().width ?? MIN_COLUMN_WIDTH;
        // Time is the last column, so its handle is on the left edge and
        // dragging left widens it.
        const dir = key === 'time' ? -1 : 1;
        const min = key === 'time' ? MIN_TIME_COLUMN_WIDTH : MIN_COLUMN_WIDTH;
        const max = Math.max(min, startWidth + flexWidth - MIN_COLUMN_WIDTH);
        const base: ColumnWidths = { ...(columnWidths ?? {}) };
        let latest = startWidth;
        let moved = false;
        setDragKey(key);
        const onMove = (ev: PointerEvent) => {
            moved = true;
            latest = Math.min(max, Math.max(min, startWidth + dir * (ev.clientX - startX)));
            setLiveWidths({ ...base, [key]: latest });
        };
        const onUp = () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            window.removeEventListener('pointercancel', onUp);
            setLiveWidths(null);
            setDragKey(null);
            if (moved) onColumnWidthsChange?.({ ...base, [key]: Math.round(latest) });
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
    };

    const resetColumn = (key: ResizableColumn) => {
        const next = { ...(columnWidths ?? {}) };
        delete next[key];
        onColumnWidthsChange?.(next);
    };

    const resizer = (key?: ResizableColumn) => (key && onColumnWidthsChange ? (
        <div
            className={`col-resizer ${key === 'time' ? 'is-left' : ''} ${dragKey === key ? 'is-dragging' : ''}`}
            role="separator"
            aria-orientation="vertical"
            onPointerDown={(e) => startResize(key, e)}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => { e.stopPropagation(); resetColumn(key); }}
        />
    ) : null);

    // A header cell that sorts its column when clicked. Falls back to a plain
    // <div> when the list isn't sortable (no onSort passed).
    const SortHeader = ({ col, className, label, resizeKey, children }: { col: SortKey; className: string; label?: string; resizeKey?: ResizableColumn; children: React.ReactNode }) => {
        const active = sortState?.key === col;
        const ariaSort = active ? (sortState!.dir === 'asc' ? 'ascending' : 'descending') : 'none';
        if (!onSort) return <div className={className} title={label} aria-sort={ariaSort}>{children}{resizer(resizeKey)}</div>;
        return (
            <div className={className} aria-sort={ariaSort}>
                <button type="button" className="th-sort" title={label ? t('trackList.sortBy', { label }) : undefined} onClick={() => onSort(col)}>
                    {children}
                    {active && <Icon name={sortState!.dir === 'asc' ? 'chevron-up' : 'chevron-down'} size={11} className="th-sort-caret" />}
                </button>
                {resizer(resizeKey)}
            </div>
        );
    };

    // Shared by both render paths below so they can never drift apart. `extra`
    // carries the bits only the virtualized path needs (absolute positioning +
    // the virtualizer's measure-on-mount/resize ref).
    const renderRow = (
        track: Track,
        index: number,
        extra?: { key: React.Key; style: React.CSSProperties; measureRef: (node: Element | null) => void },
    ) => {
        const isPlaying = loadedTrackId === track.id;
        const isCued = !isPlaying && currentTrack?.id === track.id;
        return (
            <li
                key={extra?.key ?? track.id}
                ref={extra?.measureRef}
                id={rowId(track.id)}
                role="option"
                aria-selected={multi ? selectedIds.has(track.id) : isCued || isPlaying}
                data-index={index}
                style={extra?.style}
                className={`track-item ${activeIndex === index ? 'kb-focus' : ''} ${isPlaying ? 'active' : ''} ${isCued && !multi ? 'selected' : ''} ${multi && selectedIds.has(track.id) ? 'multi-selected' : ''} ${track.kind === 'podcast' && (track.play_state ?? 'unplayed') === 'played' ? 'is-played' : ''} ${dragIndex === index ? 'is-dragging' : ''} ${reorderable && overIndex === index && dragIndex !== index ? 'drop-target' : ''}`}
                onClick={(e) => handleRowClick(e, track, index)}
                onDoubleClick={() => onTrackActivate(track)}
                onContextMenu={(e) => handleRowContextMenu(e, track)}
                draggable={reorderable}
                onDragStart={reorderable ? (e) => {
                    setDragIndex(index);
                    e.dataTransfer.effectAllowed = 'move';
                } : undefined}
                onDragOver={reorderable ? (e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    if (overIndex !== index) setOverIndex(index);
                } : undefined}
                onDrop={reorderable ? (e) => {
                    e.preventDefault();
                    if (dragIndex !== null && dragIndex !== index) onReorder?.(dragIndex, index);
                    setDragIndex(null);
                    setOverIndex(null);
                } : undefined}
                onDragEnd={reorderable ? () => {
                    setDragIndex(null);
                    setOverIndex(null);
                } : undefined}
            >
                <div className="track-icon">
                    {isPlaying ? <Icon name="play" size={11} /> : index + 1}
                </div>
                <div className="cell-title">{podcastBadge(track, t)}{track.title}</div>
                <div className="cell-text">{artistLabel(track, t)}</div>
                <div className="cell-text">{albumOf(track)}</div>
                {showPath && (
                    <div className="cell-text cell-path" style={{ fontSize: '0.8rem', opacity: 0.7 }}>{track.file_path}</div>
                )}
                <div className="cell-center cell-playcount">{track.play_count || ""}</div>
                <RatingButtons track={track} onToggleFavorite={onToggleFavorite} onToggleDislike={onToggleDislike} className="cell-center" />
                <div className="cell-duration" title={podcastDurationText(track)}>{podcastDurationText(track)}</div>
            </li>
        );
    };

    const wrapperRef = useRef<HTMLDivElement>(null);
    const headerRef = useRef<HTMLDivElement>(null);
    const virtualized = tracks.length > VIRTUALIZE_THRESHOLD;
    // .track-list-container (App.tsx) — the scrollable ancestor — is the
    // <ul>'s grandparent (wrapperRef's parent). Only resolved/used when
    // actually virtualizing; `enabled: false` below makes this a no-op
    // otherwise, so a standalone render (e.g. in tests, with no such
    // ancestor) never touches it.
    // How far below the scroll element's top the list starts: the collection
    // hero (and this list's own sticky header) sit above it, so the virtualizer
    // must not mistake that distance for scrolled rows. Measured in recompute()
    // below; 0 where nothing sits above (and in jsdom, where nothing has layout).
    const [listOffset, setListOffset] = useState(0);
    const rowVirtualizer = useVirtualizer({
        count: tracks.length,
        getScrollElement: () => (wrapperRef.current?.parentElement as HTMLElement | null) ?? wrapperRef.current,
        estimateSize: () => ESTIMATED_ROW_HEIGHT,
        overscan: 15,
        gap: ROW_GAP,
        scrollMargin: listOffset,
        enabled: virtualized,
    });

    // Measure that offset when the list changes (a different view can bring or
    // drop a hero above it) and when the scroll area is resized (a narrow window
    // restacks the hero) — not on every scroll: the distance doesn't change while
    // scrolling, and the formula below is only exact where rects follow the scroll.
    useEffect(() => {
        const scrollEl = wrapperRef.current?.parentElement as HTMLElement | null;
        const listEl = listRef.current;
        if (!virtualized || !scrollEl || !listEl) return;
        const measure = () => {
            const offset = Math.max(0, Math.round(
                listEl.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top + scrollEl.scrollTop,
            ));
            setListOffset(prev => (prev === offset ? prev : offset));
        };
        measure();
        if (typeof ResizeObserver === 'undefined') return;
        const resizeObserver = new ResizeObserver(measure);
        resizeObserver.observe(scrollEl);
        return () => resizeObserver.disconnect();
    }, [virtualized, tracks]);

    // Index (in the currently-rendered `tracks`) of the track actually loaded
    // in the player. -1 when it isn't in this list at all (a different view,
    // a search filter, ...) — the "where's now playing" UI below stays hidden
    // in that case.
    const playingIndex = useMemo(
        () => (loadedTrackId ? tracks.findIndex(t => t.id === loadedTrackId) : -1),
        [tracks, loadedTrackId],
    );

    // Whether the now-playing row is above/below the visible window (for the
    // jump button), whether the list is tall enough to scroll at all (for the
    // rail marker), and the scroll container's current height (to place the
    // marker along the rail). Recomputed on scroll/resize; see the effect
    // below. Kept as one state object so a no-op recompute (nothing changed)
    // doesn't trigger a re-render.
    const [nowPlaying, setNowPlaying] = useState<{
        direction: 'above' | 'below' | null;
        canScroll: boolean;
        containerHeight: number;
        headerHeight: number;
    }>({ direction: null, canScroll: false, containerHeight: 0, headerHeight: 0 });

    useEffect(() => {
        const scrollEl = wrapperRef.current?.parentElement as HTMLElement | null;
        if (!scrollEl) return;
        const recompute = () => {
            const containerRect = scrollEl.getBoundingClientRect();
            // offsetHeight, not scrollHeight/clientHeight: the virtualized
            // path's total content height only exists virtually (most rows
            // aren't mounted), so it's measured via the virtualizer's own
            // estimate instead of the real (unvirtualized) DOM height.
            const contentHeight = virtualized ? rowVirtualizer.getTotalSize() : (wrapperRef.current?.offsetHeight ?? 0);
            const canScroll = contentHeight > scrollEl.offsetHeight + 1;
            const headerHeight = headerRef.current?.getBoundingClientRect().height ?? 0;
            let direction: 'above' | 'below' | null = null;
            // A list that fits entirely within its viewport has nothing to
            // scroll to, so skip the (comparatively expensive, and in a
            // zero-height layout ill-defined) row-position check below.
            if (playingIndex >= 0 && canScroll) {
                if (virtualized) {
                    const range = rowVirtualizer.range;
                    if (range) {
                        if (playingIndex < range.startIndex) direction = 'above';
                        else if (playingIndex > range.endIndex) direction = 'below';
                    }
                } else {
                    const rowEl = wrapperRef.current?.querySelector(
                        `li.track-item[data-index="${playingIndex}"]`,
                    ) as HTMLElement | null;
                    if (rowEl) {
                        const rowRect = rowEl.getBoundingClientRect();
                        const visibleTop = containerRect.top + headerHeight;
                        if (rowRect.bottom <= visibleTop) direction = 'above';
                        else if (rowRect.top >= containerRect.bottom) direction = 'below';
                    }
                }
            }
            setNowPlaying(prev => (
                prev.direction === direction && prev.canScroll === canScroll
                    && prev.containerHeight === containerRect.height && prev.headerHeight === headerHeight
                    ? prev
                    : { direction, canScroll, containerHeight: containerRect.height, headerHeight }
            ));
        };
        recompute();
        scrollEl.addEventListener('scroll', recompute, { passive: true });
        let resizeObserver: ResizeObserver | undefined;
        if (typeof ResizeObserver !== 'undefined') {
            resizeObserver = new ResizeObserver(recompute);
            resizeObserver.observe(scrollEl);
        }
        return () => {
            scrollEl.removeEventListener('scroll', recompute);
            resizeObserver?.disconnect();
        };
        // rowVirtualizer is a stable instance (mutated in place, not replaced)
        // so it doesn't need to be a dependency — recompute() always reads its
        // current .range.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [playingIndex, virtualized, tracks.length]);

    const scrollToNowPlaying = () => {
        if (playingIndex < 0) return;
        if (virtualized) {
            rowVirtualizer.scrollToIndex(playingIndex, { align: 'center' });
        } else {
            wrapperRef.current
                ?.querySelector(`li.track-item[data-index="${playingIndex}"]`)
                ?.scrollIntoView({ block: 'center' });
        }
    };

    const scrollToRow = (index: number) => {
        if (virtualized) {
            rowVirtualizer.scrollToIndex(index, { align: 'auto' });
        } else {
            wrapperRef.current
                ?.querySelector(`li.track-item[data-index="${index}"]`)
                ?.scrollIntoView?.({ block: 'nearest' });
        }
    };

    const clampedActive = activeIndex === null ? null : Math.min(activeIndex, tracks.length - 1);

    const handleListFocus = () => {
        // Functional update: focus fires synchronously inside a row's click,
        // after that click already set the cursor to the clicked row.
        if (tracks.length > 0) setActiveIndex(prev => prev ?? (playingIndex >= 0 ? playingIndex : 0));
    };

    // Arrow keys move the cursor (Shift extends a range), Enter plays, the
    // Menu key / Shift+F10 opens the row's context menu. Space and ←/→ are left
    // to useKeyboardShortcuts (play/pause, prev/next).
    const handleListKeyDown = (e: React.KeyboardEvent<HTMLUListElement>) => {
        // A control inside a row (the thumbs buttons) keeps its own keys: Enter
        // presses it, the arrows are not a list move.
        if (e.target !== e.currentTarget) return;
        if (tracks.length === 0) return;
        const cur = clampedActive ?? 0;
        const move = (to: number) => {
            e.preventDefault();
            const next = Math.max(0, Math.min(tracks.length - 1, to));
            if (onSelectionContextMenu && e.shiftKey) {
                const anchor = anchorRef.current ?? cur;
                anchorRef.current = anchor;
                const [lo, hi] = [Math.min(anchor, next), Math.max(anchor, next)];
                setSelectedIds(new Set(tracks.slice(lo, hi + 1).map(t => t.id)));
            } else {
                anchorRef.current = next;
                if (selectedIds.size > 0) setSelectedIds(new Set());
            }
            setActiveIndex(next);
            scrollToRow(next);
        };
        switch (e.key) {
            case 'ArrowDown': move(cur + 1); break;
            case 'ArrowUp': move(cur - 1); break;
            case 'Home': move(0); break;
            case 'End': move(tracks.length - 1); break;
            case 'Enter':
                e.preventDefault();
                onTrackActivate(tracks[cur]);
                break;
            case 'ContextMenu':
            case 'F10': {
                if (e.key === 'F10' && !e.shiftKey) break;
                e.preventDefault();
                const rowEl = wrapperRef.current?.querySelector(`li.track-item[data-index="${cur}"]`);
                const rect = rowEl?.getBoundingClientRect();
                const at = {
                    clientX: rect ? rect.left + 24 : 0,
                    clientY: rect ? rect.top + rect.height / 2 : 0,
                    preventDefault: () => {},
                    stopPropagation: () => {},
                };
                handleRowContextMenu(at as unknown as React.MouseEvent, tracks[cur]);
                break;
            }
        }
    };

    const wrapperStyle = useMemo(() => {
        const style: Record<string, string> = {};
        let custom = false;
        for (const k of ['title', 'artist', 'album', 'path'] as const) {
            const w = widths[k];
            if (k !== flexColumn && w !== undefined) {
                style[`--col-${k}`] = `${w}px`;
                custom = true;
            }
        }
        // Time is always px (the fr columns absorb the difference), so it never
        // counts as "custom" for the flex column below.
        const timeWidth = widths.time ?? timeDefaultWidth;
        if (timeWidth !== null && timeWidth !== undefined) style['--col-time'] = `${timeWidth}px`;
        // Only once something is custom — otherwise the flex column keeps its
        // default fr share and the stock proportions are unchanged.
        if (custom) style[`--col-${flexColumn}`] = `minmax(${MIN_COLUMN_WIDTH}px, 1fr)`;
        return style as React.CSSProperties;
    }, [widths, flexColumn, timeDefaultWidth]);

    // Both jump buttons sit at the vertical centre of the visible rows (between
    // the header and the player bar); styles/tracklist.css turns these into top/bottom.
    const jumpSlotStyle = {
        position: 'sticky',
        height: 0,
        '--np-container': `${nowPlaying.containerHeight}px`,
        '--np-header': `${nowPlaying.headerHeight}px`,
    } as React.CSSProperties;

    const listProps = {
        ref: listRef,
        role: 'listbox' as const,
        tabIndex: 0,
        'aria-label': t('trackList.listLabel'),
        'aria-multiselectable': onSelectionContextMenu ? true : undefined,
        'aria-activedescendant': clampedActive !== null && tracks[clampedActive] ? rowId(tracks[clampedActive].id) : undefined,
        onFocus: handleListFocus,
        onKeyDown: handleListKeyDown,
    };

    const nowPlayingFraction = tracks.length > 1 ? playingIndex / (tracks.length - 1) : 0;

    return (
        <div className={`track-list-wrapper ${showPath ? '' : 'hide-path'}`} ref={wrapperRef} style={wrapperStyle}>
            {playingIndex >= 0 && nowPlaying.canScroll && (
                // Zero-height sticky box at the very top so the rail floats over
                // the viewport at every scroll position (a sticky box only pins
                // once its natural position has scrolled past, so it must sit
                // at the start of the list, not the end).
                <div className="now-playing-rail-slot" style={{ position: 'sticky', top: 0, height: 0 }}>
                    <div className="now-playing-rail" style={{ height: nowPlaying.containerHeight }}>
                        <button
                            type="button"
                            className="now-playing-marker"
                            style={{ top: `${nowPlayingFraction * 100}%` }}
                            title={t('trackList.nowPlaying')}
                            onClick={scrollToNowPlaying}
                        />
                    </div>
                </div>
            )}
            <span className="cell-duration time-sizer" ref={timeSizerRef} aria-hidden="true">00:00:00</span>
            <div className="track-list-header" ref={headerRef}>
                <div className="th-num">#</div>
                <SortHeader col="title" className="th-title" resizeKey="title">{t('trackList.title')}</SortHeader>
                <SortHeader col="artist" className="th-artist" resizeKey="artist">{t('trackList.artist')}</SortHeader>
                <SortHeader col="album" className={showPath ? 'th-album' : 'th-album th-flex'} resizeKey={showPath ? 'album' : undefined}>{t('trackList.album')}</SortHeader>
                {showPath && <div className="th-path th-flex">{t('trackList.path')}</div>}
                <SortHeader col="plays" className="cell-center th-plays" label={t('trackList.playCount')}><Icon name="play" size={11} /></SortHeader>
                <div className="cell-center th-fav"><Icon name="thumb-up" size={13} /><Icon name="thumb-down" size={13} /></div>
                <SortHeader col="duration" className="th-time" resizeKey="time">{t('trackList.time')}</SortHeader>
            </div>
            {playingIndex >= 0 && nowPlaying.direction === 'above' && (
                // Right after the header: sticky top pins only once this has
                // scrolled out of view, i.e. exactly when the playing row is
                // above the window. Placed at the end of the list it would
                // stay below the viewport and never show.
                <div
                    className="now-playing-jump-slot is-above"
                    style={jumpSlotStyle}
                >
                    <button type="button" className="now-playing-jump" onClick={scrollToNowPlaying}>
                        <Icon name="chevron-up" size={13} />
                        {t('trackList.nowPlaying')}
                    </button>
                </div>
            )}
            {virtualized ? (
                <ul className="track-list is-virtualized" {...listProps} style={{ position: 'relative', height: rowVirtualizer.getTotalSize() }}>
                    {rowVirtualizer.getVirtualItems().map((item) => renderRow(tracks[item.index], item.index, {
                        key: item.key,
                        measureRef: rowVirtualizer.measureElement,
                        style: {
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            right: 0,
                            // item.start counts the list's offset in the scroll area; the <ul> itself starts below it.
                            transform: `translateY(${item.start - listOffset}px)`,
                        },
                    }))}
                </ul>
            ) : (
                <ul className="track-list" {...listProps}>
                    {tracks.map((track, index) => renderRow(track, index))}
                    {tracks.length === 0 && (
                        <li className="empty-state" role="presentation">{t('trackList.noTracksFound')}</li>
                    )}
                </ul>
            )}
            {playingIndex >= 0 && nowPlaying.direction === 'below' && (
                // Wrapped in a height:0 sticky box so it floats at the bottom
                // of the scrollable viewport (App.tsx's .track-list-container)
                // without taking up space or needing that ancestor to be
                // position:relative — the usual "sticky overlay" trick.
                <div
                    className="now-playing-jump-slot is-below"
                    style={jumpSlotStyle}
                >
                    <button type="button" className="now-playing-jump" onClick={scrollToNowPlaying}>
                        <Icon name="chevron-down" size={13} />
                        {t('trackList.nowPlaying')}
                    </button>
                </div>
            )}
        </div>
    );
};

// Memoised: the parent App re-renders ~4×/s while playing (currentTime ticks),
// and this list can be thousands of rows. Props from App are stable refs.
export const TrackList = React.memo(TrackListInner);
