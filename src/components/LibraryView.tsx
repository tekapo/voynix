import React from 'react';
import { useTranslation } from 'react-i18next';
import { Track, ViewMode } from '../types';
import { albumOf } from '../albumName';
import { UNKNOWN_ARTIST } from '../names';
import { useAlbumThumb } from '../albumArt';
import { useArtistThumb } from '../artistArt';

/** Deterministic background hue for a name's initial-letter placeholder, so
 *  the same artist/album always gets the same color across views. */
const placeholderHue = (name: string): number => {
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
    return hash % 360;
};

const initialOf = (name: string): string => name.trim().charAt(0).toUpperCase() || '?';

/** A colored initial-letter placeholder for a missing artist/album image,
 *  sized/shaped by the same `className` the image itself would use so it
 *  lines up in every context (grid cards, LibraryColumns' left-pane rows,
 *  section/columns headers). */
const ThumbPlaceholder: React.FC<{ name: string; className: string }> = ({ name, className }) => (
    <span
        className={`${className} library-thumb-placeholder`}
        style={{ background: `hsl(${placeholderHue(name)}, 38%, 28%)` }}
    >
        {initialOf(name)}
    </span>
);

interface LibraryViewProps {
    viewMode: ViewMode;
    items: string[];
    onItemClick: (item: string) => void;
    /** Album view only: a representative track per item, used to resolve a
     *  cover thumbnail (embedded art / user override, see albumArt.ts). Not
     *  used to resolve the artists view's images (see artistArt.ts, keyed by
     *  artist name alone), but still passed through to onItemContextMenu
     *  there so "Play" etc. have a track to act on. */
    artFor?: (item: string) => Track | null;
    /** Right-click on a card, e.g. to set/reset its cover/image. Gets the
     *  same representative track artFor would resolve (null if none). */
    onItemContextMenu?: (e: React.MouseEvent, item: string, track: Track | null) => void;
}

const THUMB_SIZE = 256;

/** One album card's artwork: a cover thumbnail if one resolves, else an
 *  initial-letter placeholder (of the album name) — never a loading spinner,
 *  since a cache miss (no embedded/override art) looks identical to "still
 *  loading" and a flash is not worth the complexity. Also used (at smaller
 *  sizes, via `className`) by LibraryColumns' left-pane rows and album
 *  section headers. */
export const AlbumThumb: React.FC<{ track: Track; size?: number; className?: string; iconSize?: number }> =
    ({ track, size = THUMB_SIZE, className = 'library-list-art' }) => {
        const art = useAlbumThumb(track, size);
        return art
            ? <img className={className} src={art} alt="" loading="lazy" />
            : <ThumbPlaceholder name={albumOf(track)} className={className} />;
    };

/** One artist card's image: a user-set override if one resolves, else an
 *  initial-letter placeholder of the artist's name. */
export const ArtistThumb: React.FC<{ artist: string; className?: string; iconSize?: number }> =
    ({ artist, className = 'library-list-art' }) => {
        const art = useArtistThumb(artist);
        return art
            ? <img className={className} src={art} alt="" loading="lazy" />
            : <ThumbPlaceholder name={artist} className={className} />;
    };

export const LibraryView: React.FC<LibraryViewProps> = ({ viewMode, items, onItemClick, artFor, onItemContextMenu }) => {
    const { t } = useTranslation();
    return (
        <ul className="library-list-container">
            {items.map(item => {
                const track = artFor?.(item) ?? null;
                return (
                    <li
                        key={item}
                        className="library-list-item"
                        onClick={() => onItemClick(item)}
                        onContextMenu={onItemContextMenu ? (e) => onItemContextMenu(e, item, track) : undefined}
                    >
                        {viewMode === 'artists'
                            ? <ArtistThumb artist={item} />
                            : track
                                ? <AlbumThumb track={track} />
                                : <ThumbPlaceholder name={item} className="library-list-art" />}
                        <span className="library-list-name">{viewMode === 'artists' && item === UNKNOWN_ARTIST ? t('common.unknownArtist') : item}</span>
                    </li>
                );
            })}
        </ul>
    );
};
