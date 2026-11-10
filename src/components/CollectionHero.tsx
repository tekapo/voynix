import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Track } from '../types';
import { albumOf } from '../albumName';
import { artistOf } from '../names';
import { Icon } from './Icon';
import { ThumbPlaceholder } from './CoverArt';
import { AlbumThumb, ArtistThumb } from './LibraryView';
import { collectionMeta } from './LibraryColumns';

export type CollectionKind = 'playlist' | 'album' | 'artist';

interface CollectionHeroProps {
    kind: CollectionKind;
    title: string;
    /** The whole collection (before any search filter): drives the cover and the counts. */
    tracks: Track[];
    onPlay: () => void;
    onShuffle: () => void;
    /** False hides the shuffle button (a podcast playlist that always plays in order). */
    showShuffle?: boolean;
}

/** Upper bound on tracks looked at while hunting for distinct covers. */
const COVER_CANDIDATES = 24;
const THUMB_SIZE = 256;

/** Up to `max` tracks, each from a different (artist, album), in list order. */
function pickCoverTracks(tracks: Track[], max: number): Track[] {
    const seen = new Set<string>();
    const picked: Track[] = [];
    for (const track of tracks.slice(0, COVER_CANDIDATES)) {
        const key = `${artistOf(track)}␟${albumOf(track)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        picked.push(track);
        if (picked.length === max) break;
    }
    return picked;
}

/**
 * The block above a playlist / album / artist track list: cover, kind label,
 * big title, counts and the Play / Shuffle buttons. It scrolls away with the
 * list (it sits inside .track-list-container, before the TrackList).
 */
const CollectionHeroInner: React.FC<CollectionHeroProps> = ({ kind, title, tracks, onPlay, onShuffle, showShuffle = true }) => {
    const { t } = useTranslation();
    const empty = tracks.length === 0;
    const tiles = useMemo(() => pickCoverTracks(tracks, kind === 'album' ? 1 : 4), [tracks, kind]);

    const label = kind === 'playlist' ? t('common.playlist') : kind === 'album' ? t('trackList.album') : t('trackList.artist');

    let meta = collectionMeta(tracks, t);
    if (kind === 'album' && !empty) {
        meta = `${artistOf(tracks[0])} · ${meta}`;
    } else if (kind === 'artist') {
        const albumCount = new Set(tracks.map(albumOf)).size;
        meta = `${t('libraryColumns.albumsCount', { count: albumCount })} · ${meta}`;
    }

    return (
        <div className={`collection-hero collection-hero-${kind}`}>
            {kind === 'artist' ? (
                <ArtistThumb artist={empty ? title : artistOf(tracks[0])} className="collection-hero-art-round" />
            ) : (
                <div className="collection-hero-cover" data-count={tiles.length}>
                    {tiles.length === 0
                        ? <ThumbPlaceholder name={title} className="collection-hero-tile" />
                        : tiles.map(track => (
                            <AlbumThumb key={track.id} track={track} size={THUMB_SIZE} className="collection-hero-tile" />
                        ))}
                </div>
            )}
            <div className="collection-hero-body">
                <div className="collection-hero-kind">{label}</div>
                <h2 className="collection-hero-title" title={title}>{title}</h2>
                <div className="collection-hero-meta">{meta}</div>
                <div className="collection-hero-actions">
                    {/* The accessible names carry the title so the player bar's own
                        "Play" stays the only button named exactly that. */}
                    <button type="button" className="collection-hero-play" disabled={empty} onClick={onPlay} aria-label={t('collectionHero.playNamed', { name: title })}>
                        <Icon name="play" size={16} />
                        {t('libraryColumns.play')}
                    </button>
                    {showShuffle && (
                        <button type="button" className="collection-hero-shuffle" disabled={empty} onClick={onShuffle} aria-label={t('collectionHero.shuffleNamed', { name: title })}>
                            <Icon name="shuffle" size={17} />
                            {t('libraryColumns.shuffle')}
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
};

// Memoised: App re-renders ~4×/s while playing (currentTime ticks), and its
// props here are stable between those renders.
export const CollectionHero = React.memo(CollectionHeroInner);
