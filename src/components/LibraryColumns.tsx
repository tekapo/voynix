import React, { useEffect, useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { albumOf } from '../albumName';
import { artistOf, artistLabel, UNKNOWN_ARTIST } from '../names';
import { Track } from '../types';
import { Icon } from './Icon';
import { AlbumThumb, ArtistThumb } from './LibraryView';
import { podcastBadge, podcastDurationText } from './trackFormat';

// Hoisted like TrackList's — one shared element per state avoids a fresh
// element per row across a library-sized list.
const STAR_ON = <Icon name="star-filled" size={15} />;
const STAR_OFF = <Icon name="star" size={15} />;

/** Same threshold/approach as TrackList.tsx: below it, plain DOM; above it,
 *  windowed via @tanstack/react-virtual. The left-pane names list can run to
 *  thousands of artists/albums in a large library. */
const VIRTUALIZE_THRESHOLD = 300;
const ESTIMATED_ROW_HEIGHT = 56;

/** "12 songs · 48 min" / "1 song · 3 min". */
function collectionMeta(tracks: Track[], t: TFunction): string {
    const songs = tracks.length;
    const totalSeconds = tracks.reduce((sum, t) => sum + (t.duration || 0), 0);
    const totalMinutes = Math.round(totalSeconds / 60);
    return t('libraryColumns.meta', { count: songs, minutes: totalMinutes });
}

/** Groups already-sorted tracks (sortNatural order: artist -> album -> disc ->
 *  track) into consecutive album runs, keeping that order. Two different
 *  artists' albums that happen to share a name stay separate, since a run
 *  breaks on artist OR album change. */
function groupByAlbum(tracks: Track[]): { artist: string; album: string; tracks: Track[] }[] {
    const groups: { artist: string; album: string; tracks: Track[] }[] = [];
    for (const t of tracks) {
        const artist = artistOf(t);
        const album = albumOf(t);
        const last = groups[groups.length - 1];
        if (last && last.artist === artist && last.album === album) {
            last.tracks.push(t);
        } else {
            groups.push({ artist, album, tracks: [t] });
        }
    }
    return groups;
}

interface LibraryColumnsProps {
    viewMode: 'artists' | 'albums';
    /** Left pane names, already search-filtered — same list LibraryView's grid uses. */
    items: string[];
    selected: string | null;
    onSelect: (item: string) => void;
    onItemContextMenu: (e: React.MouseEvent, item: string, track: Track | null) => void;
    artFor: (item: string) => Track | null;
    /** The selected item's tracks, in natural (sortNatural) order. Empty when nothing's selected. */
    tracks: Track[];
    currentTrack: Track | null;
    loadedTrackId: string | null;
    onTrackClick: (track: Track) => void;
    onTrackActivate: (track: Track) => void;
    onTrackContextMenu: (e: React.MouseEvent, track: Track) => void;
    onToggleFavorite: (track: Track) => void;
    onPlay: (tracks: Track[]) => void;
    onShuffle: (tracks: Track[]) => void;
    /** Artist-view header's "..." — opens the artist context menu. */
    onArtistMore: (e: React.MouseEvent, artist: string, track: Track | null) => void;
    /** Each album section's "..." (both views) — opens the album context menu. */
    onAlbumMore: (e: React.MouseEvent, album: string, track: Track | null) => void;
    /** Back to the left pane on phone widths (single-pane layout). */
    onBack: () => void;
}

const AlbumSection: React.FC<{
    artist: string;
    album: string;
    tracks: Track[];
    showArtist: boolean;
    large: boolean;
    currentTrack: Track | null;
    loadedTrackId: string | null;
    onTrackClick: (track: Track) => void;
    onTrackActivate: (track: Track) => void;
    onTrackContextMenu: (e: React.MouseEvent, track: Track) => void;
    onToggleFavorite: (track: Track) => void;
    onAlbumMore: (e: React.MouseEvent, album: string, track: Track | null) => void;
}> = ({ artist, album, tracks, showArtist, large, currentTrack, loadedTrackId, onTrackClick, onTrackActivate, onTrackContextMenu, onToggleFavorite, onAlbumMore }) => {
    const { t } = useTranslation();
    // Only worth a per-row artist cell when this album's own tracks disagree
    // (e.g. a compilation) — otherwise it's redundant with the section header.
    const mixedArtists = useMemo(() => new Set(tracks.map(artistOf)).size > 1, [tracks]);
    return (
        <section className={`album-section ${large ? 'album-section-large' : ''}`}>
            <div className="album-section-header">
                <AlbumThumb
                    track={tracks[0]}
                    size={large ? 400 : 128}
                    className="album-section-art"
                    iconSize={large ? 48 : 28}
                />
                <div className="album-section-meta">
                    <div className="album-section-title">{album}</div>
                    {showArtist && <div className="album-section-artist">{artist === UNKNOWN_ARTIST ? t('common.unknownArtist') : artist}</div>}
                    <div className="album-section-count">{collectionMeta(tracks, t)}</div>
                </div>
                <button
                    className="album-section-more"
                    aria-label={t('libraryColumns.moreOptionsFor', { name: album })}
                    onClick={(e) => onAlbumMore(e, album, tracks[0])}
                >
                    <Icon name="more-vertical" size={16} />
                </button>
            </div>
            <ul className="album-section-tracks">
                {tracks.map((track, index) => {
                    const isPlaying = loadedTrackId === track.id;
                    const isCued = !isPlaying && currentTrack?.id === track.id;
                    return (
                        <li
                            key={track.id}
                            className={`album-track-row ${isPlaying ? 'active' : ''} ${isCued ? 'selected' : ''}`}
                            onClick={() => onTrackClick(track)}
                            onDoubleClick={() => onTrackActivate(track)}
                            onContextMenu={(e) => onTrackContextMenu(e, track)}
                        >
                            <div className="album-track-num">
                                {isPlaying ? <Icon name="play" size={11} /> : (track.track_no ?? index + 1)}
                            </div>
                            <div className="album-track-title">
                                {podcastBadge(track, t)}{track.title}
                                {mixedArtists && <span className="album-track-artist"> — {artistLabel(track, t)}</span>}
                            </div>
                            <button
                                className={`cell-center star-btn ${track.favorite ? 'is-favorite' : ''}`}
                                title={track.favorite ? t('libraryColumns.removeFromFavorites') : t('libraryColumns.addToFavorites')}
                                aria-label={track.favorite ? t('libraryColumns.removeFromFavorites') : t('libraryColumns.addToFavorites')}
                                aria-pressed={!!track.favorite}
                                onClick={(e) => { e.stopPropagation(); onToggleFavorite(track); }}
                            >
                                {track.favorite ? STAR_ON : STAR_OFF}
                            </button>
                            <div className="album-track-duration">{podcastDurationText(track)}</div>
                            <button
                                className="album-track-more"
                                aria-label={t('libraryColumns.moreOptionsFor', { name: track.title })}
                                onClick={(e) => onTrackContextMenu(e, track)}
                            >
                                <Icon name="more-vertical" size={14} />
                            </button>
                        </li>
                    );
                })}
            </ul>
        </section>
    );
};

export const LibraryColumns: React.FC<LibraryColumnsProps> = ({
    viewMode, items, selected, onSelect, onItemContextMenu, artFor,
    tracks, currentTrack, loadedTrackId, onTrackClick, onTrackActivate, onTrackContextMenu, onToggleFavorite,
    onPlay, onShuffle, onArtistMore, onAlbumMore, onBack,
}) => {
    const { t } = useTranslation();
    const listRef = useRef<HTMLDivElement>(null);
    const virtualized = items.length > VIRTUALIZE_THRESHOLD;
    const rowVirtualizer = useVirtualizer({
        count: items.length,
        getScrollElement: () => listRef.current,
        estimateSize: () => ESTIMATED_ROW_HEIGHT,
        overscan: 10,
        enabled: virtualized,
    });

    // Keep the selected row in view when it was restored/selected from
    // elsewhere (e.g. last-session restore), not just from a click here.
    useEffect(() => {
        if (!virtualized || !selected) return;
        const index = items.indexOf(selected);
        if (index >= 0) rowVirtualizer.scrollToIndex(index, { align: 'auto' });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selected, virtualized]);

    const albumGroups = useMemo(() => groupByAlbum(tracks), [tracks]);

    const renderRow = (item: string, extra?: { style: React.CSSProperties; measureRef: (node: Element | null) => void }) => {
        const track = artFor(item);
        return (
            <li
                key={item}
                ref={extra?.measureRef}
                data-index={items.indexOf(item)}
                style={extra?.style}
                className={`library-col-item ${selected === item ? 'active' : ''}`}
                onClick={() => onSelect(item)}
                onContextMenu={(e) => onItemContextMenu(e, item, track)}
            >
                {viewMode === 'artists'
                    ? <ArtistThumb artist={item} className="library-col-art library-col-art-round" iconSize={18} />
                    : track
                        ? <AlbumThumb track={track} size={64} className="library-col-art" iconSize={18} />
                        : <span className="library-col-icon"><Icon name="disc" size={18} /></span>}
                <span className="library-col-name">{viewMode === 'artists' && item === UNKNOWN_ARTIST ? t('common.unknownArtist') : item}</span>
            </li>
        );
    };

    return (
        <div className={`library-columns ${selected ? 'has-selection' : ''}`}>
            <div className="library-columns-left" ref={listRef}>
                {virtualized ? (
                    <ul className="library-col-list" style={{ position: 'relative', height: rowVirtualizer.getTotalSize() }}>
                        {rowVirtualizer.getVirtualItems().map((item) => renderRow(items[item.index], {
                            measureRef: rowVirtualizer.measureElement,
                            style: { position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${item.start}px)` },
                        }))}
                    </ul>
                ) : (
                    <ul className="library-col-list">
                        {items.map(item => renderRow(item))}
                        {items.length === 0 && (
                            <li className="empty-state">{viewMode === 'artists' ? t('libraryColumns.noArtistsFound') : t('libraryColumns.noAlbumsFound')}</li>
                        )}
                    </ul>
                )}
            </div>
            <div className="library-columns-right">
                {!selected ? (
                    <div className="empty-state">{viewMode === 'artists' ? t('libraryColumns.selectArtist') : t('libraryColumns.selectAlbum')}</div>
                ) : (
                    <>
                        <button className="library-columns-back" aria-label={t('libraryColumns.back')} onClick={onBack}>
                            <Icon name="chevron-left" size={16} /> {t('libraryColumns.back')}
                        </button>
                        {viewMode === 'artists' && (
                            <div className="library-columns-header">
                                <ArtistThumb artist={selected} className="library-columns-header-art library-columns-header-art-round" iconSize={40} />
                                <div className="library-columns-header-meta">
                                    <h2>{selected === UNKNOWN_ARTIST ? t('common.unknownArtist') : selected}</h2>
                                    <div className="library-columns-header-count">
                                        {t('libraryColumns.albumsCount', { count: albumGroups.length })}, {collectionMeta(tracks, t)}
                                    </div>
                                    <div className="library-columns-header-actions">
                                        <button className="library-columns-play" onClick={() => onPlay(tracks)} aria-label={t('libraryColumns.play')}>
                                            <Icon name="play" size={16} />
                                        </button>
                                        <button className="library-columns-shuffle" onClick={() => onShuffle(tracks)} aria-label={t('libraryColumns.shuffle')}>
                                            <Icon name="shuffle" size={16} />
                                        </button>
                                        <button className="library-columns-more" onClick={(e) => onArtistMore(e, selected, tracks[0] ?? null)} aria-label={t('libraryColumns.moreOptions')}>
                                            <Icon name="more-vertical" size={16} />
                                        </button>
                                    </div>
                                </div>
                            </div>
                        )}
                        <div className="album-sections">
                            {albumGroups.map(g => (
                                <AlbumSection
                                    key={`${g.artist}␟${g.album}`}
                                    artist={g.artist}
                                    album={g.album}
                                    tracks={g.tracks}
                                    showArtist={viewMode === 'albums'}
                                    large={viewMode === 'albums'}
                                    currentTrack={currentTrack}
                                    loadedTrackId={loadedTrackId}
                                    onTrackClick={onTrackClick}
                                    onTrackActivate={onTrackActivate}
                                    onTrackContextMenu={onTrackContextMenu}
                                    onToggleFavorite={onToggleFavorite}
                                    onAlbumMore={onAlbumMore}
                                />
                            ))}
                        </div>
                    </>
                )}
            </div>
        </div>
    );
};
