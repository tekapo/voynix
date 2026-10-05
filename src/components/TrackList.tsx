import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useTranslation } from 'react-i18next';
import { albumOf } from '../albumName';
import { artistLabel } from '../names';
import { SortKey, SortState } from '../trackSort';
import { Track } from '../types';
import { Icon } from './Icon';
import { podcastBadge, podcastDurationText } from './trackFormat';

// Hoisted so React can bail out on the identical element reference — the star
// renders once per row across a library that can run to thousands of tracks.
const STAR_ON = <Icon name="star-filled" size={15} />;
const STAR_OFF = <Icon name="star" size={15} />;

// Below this, render every row directly (today's behaviour, unchanged) — a
// typical playlist (tens to a few hundred tracks) gets no windowing at all,
// which keeps it simple and keeps every existing DOM-based test valid.
// Above it (e.g. an "All Songs" view over a multi-thousand-track library —
// a 2,591-track report motivated this), only the visible rows (+ overscan)
// are mounted via @tanstack/react-virtual. See TrackList.test.tsx's "virtualized rendering"
// describe block for the behavioural contract this threshold protects.
const VIRTUALIZE_THRESHOLD = 300;
// Rows never wrap (see .cell-title/.cell-text's white-space: nowrap in
// App.css) so every row is the same height within a given breakpoint/setting
// — this is just a first-paint guess; the real height is measured per row
// (virtualizer.measureElement below) and converges immediately.
const ESTIMATED_ROW_HEIGHT = 38;
// Matches .track-item's `margin-bottom: 2px` (App.css) — told to the
// virtualizer directly (via `gap`) rather than left on the CSS, since
// getBoundingClientRect()/ResizeObserver (which measureElement uses) don't
// include margin, and a virtualizer that doesn't know about the gap would
// under-space rows.
const ROW_GAP = 2;

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
    /** Enables drag-and-drop row reordering (a manually-ordered playlist view
     *  only — disabled while a column sort or search filter is active, since
     *  then row index no longer matches the underlying DB position). */
    reorderable?: boolean;
    /** Drop `from` onto `to` (both indices into the currently rendered `tracks`). */
    onReorder?: (from: number, to: number) => void;
}

const TrackListInner: React.FC<TrackListProps> = ({ tracks, currentTrack, loadedTrackId = null, showPath = false, sortState = null, onSort, onTrackClick, onTrackActivate, onContextMenu, onSelectionContextMenu, onToggleFavorite, reorderable = false, onReorder }) => {
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
    const selected = useMemo(
        () => tracks.filter(t => selectedIds.has(t.id)),
        [tracks, selectedIds],
    );
    const multi = selected.length > 1;

    const handleRowClick = (e: React.MouseEvent, track: Track, index: number) => {
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

    // A header cell that sorts its column when clicked. Falls back to a plain
    // <div> when the list isn't sortable (no onSort passed).
    const SortHeader = ({ col, className, label, children }: { col: SortKey; className: string; label?: string; children: React.ReactNode }) => {
        const active = sortState?.key === col;
        const ariaSort = active ? (sortState!.dir === 'asc' ? 'ascending' : 'descending') : 'none';
        if (!onSort) return <div className={className} title={label} aria-sort={ariaSort}>{children}</div>;
        return (
            <div className={className} aria-sort={ariaSort}>
                <button type="button" className="th-sort" title={label ? t('trackList.sortBy', { label }) : undefined} onClick={() => onSort(col)}>
                    {children}
                    {active && <Icon name={sortState!.dir === 'asc' ? 'chevron-up' : 'chevron-down'} size={11} className="th-sort-caret" />}
                </button>
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
                data-index={index}
                style={extra?.style}
                className={`track-item ${isPlaying ? 'active' : ''} ${isCued && !multi ? 'selected' : ''} ${multi && selectedIds.has(track.id) ? 'multi-selected' : ''} ${track.kind === 'podcast' && (track.play_state ?? 'unplayed') === 'played' ? 'is-played' : ''} ${dragIndex === index ? 'is-dragging' : ''} ${reorderable && overIndex === index && dragIndex !== index ? 'drop-target' : ''}`}
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
                <button
                    className={`cell-center star-btn ${track.favorite ? 'is-favorite' : ''}`}
                    title={track.favorite ? t('trackList.removeFromFavorites') : t('trackList.addToFavorites')}
                    aria-label={track.favorite ? t('trackList.removeFromFavorites') : t('trackList.addToFavorites')}
                    aria-pressed={!!track.favorite}
                    onClick={(e) => { e.stopPropagation(); onToggleFavorite(track); }}
                >
                    {track.favorite ? STAR_ON : STAR_OFF}
                </button>
                <div className="cell-duration">{podcastDurationText(track)}</div>
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
    const rowVirtualizer = useVirtualizer({
        count: tracks.length,
        getScrollElement: () => (wrapperRef.current?.parentElement as HTMLElement | null) ?? wrapperRef.current,
        estimateSize: () => ESTIMATED_ROW_HEIGHT,
        overscan: 15,
        gap: ROW_GAP,
        enabled: virtualized,
    });

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
    }>({ direction: null, canScroll: false, containerHeight: 0 });

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
                        const headerHeight = headerRef.current?.getBoundingClientRect().height ?? 0;
                        const visibleTop = containerRect.top + headerHeight;
                        if (rowRect.bottom <= visibleTop) direction = 'above';
                        else if (rowRect.top >= containerRect.bottom) direction = 'below';
                    }
                }
            }
            setNowPlaying(prev => (
                prev.direction === direction && prev.canScroll === canScroll && prev.containerHeight === containerRect.height
                    ? prev
                    : { direction, canScroll, containerHeight: containerRect.height }
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

    const nowPlayingFraction = tracks.length > 1 ? playingIndex / (tracks.length - 1) : 0;

    return (
        <div className={`track-list-wrapper ${showPath ? '' : 'hide-path'}`} ref={wrapperRef}>
            <div className="track-list-header" ref={headerRef}>
                <div className="th-num">#</div>
                <SortHeader col="title" className="th-title">{t('trackList.title')}</SortHeader>
                <SortHeader col="artist" className="th-artist">{t('trackList.artist')}</SortHeader>
                <SortHeader col="album" className="th-album">{t('trackList.album')}</SortHeader>
                {showPath && <div className="th-path">{t('trackList.path')}</div>}
                <SortHeader col="plays" className="cell-center th-plays" label={t('trackList.playCount')}><Icon name="play" size={11} /></SortHeader>
                <div className="cell-center th-fav"><Icon name="star" size={13} /></div>
                <SortHeader col="duration" className="th-time">{t('trackList.time')}</SortHeader>
            </div>
            {virtualized ? (
                <ul className="track-list is-virtualized" style={{ position: 'relative', height: rowVirtualizer.getTotalSize() }}>
                    {rowVirtualizer.getVirtualItems().map((item) => renderRow(tracks[item.index], item.index, {
                        key: item.key,
                        measureRef: rowVirtualizer.measureElement,
                        style: {
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            right: 0,
                            transform: `translateY(${item.start}px)`,
                        },
                    }))}
                </ul>
            ) : (
                <ul className="track-list">
                    {tracks.map((track, index) => renderRow(track, index))}
                    {tracks.length === 0 && (
                        <li className="empty-state">{t('trackList.noTracksFound')}</li>
                    )}
                </ul>
            )}
            {playingIndex >= 0 && nowPlaying.direction && (
                // Wrapped in a height:0 sticky box so it floats at the top/bottom
                // of the scrollable viewport (App.tsx's .track-list-container)
                // without taking up space or needing that ancestor to be
                // position:relative — the usual "sticky overlay" trick.
                <div
                    className={`now-playing-jump-slot ${nowPlaying.direction === 'above' ? 'is-above' : 'is-below'}`}
                    style={
                        nowPlaying.direction === 'above'
                            ? { position: 'sticky', height: 0, top: 0 }
                            : { position: 'sticky', height: 0, bottom: 0 }
                    }
                >
                    <button type="button" className="now-playing-jump" onClick={scrollToNowPlaying}>
                        <Icon name={nowPlaying.direction === 'above' ? 'chevron-up' : 'chevron-down'} size={13} />
                        {t('trackList.nowPlaying')}
                    </button>
                </div>
            )}
            {playingIndex >= 0 && nowPlaying.canScroll && (
                <div
                    className="now-playing-rail"
                    style={{ position: 'sticky', top: 0, height: nowPlaying.containerHeight }}
                >
                    <button
                        type="button"
                        className="now-playing-marker"
                        style={{ top: `${nowPlayingFraction * 100}%` }}
                        title={t('trackList.nowPlaying')}
                        onClick={scrollToNowPlaying}
                    />
                </div>
            )}
        </div>
    );
};

// Memoised: the parent App re-renders ~4×/s while playing (currentTime ticks),
// and this list can be thousands of rows. Props from App are stable refs.
export const TrackList = React.memo(TrackListInner);
