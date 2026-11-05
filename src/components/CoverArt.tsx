import React from 'react';
import { Track } from '../types';
import { useArtistThumb } from '../artistArt';

/** Deterministic background hue for a name's initial-letter placeholder, so
 *  the same artist/album always gets the same color across views. */
export const placeholderHue = (name: string): number => {
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
    return hash % 360;
};

export const initialOf = (name: string): string => name.trim().charAt(0).toUpperCase() || '?';

/** A colored initial-letter placeholder for a missing artist/album image,
 *  sized/shaped by the same `className` the image itself would use so it
 *  lines up in every context (grid cards, LibraryColumns' left-pane rows,
 *  section/columns headers, the player bar). */
export const ThumbPlaceholder: React.FC<{ name: string; className: string }> = ({ name, className }) => (
    <span
        className={`${className} library-thumb-placeholder`}
        style={{ background: `hsl(${placeholderHue(name)}, 38%, 28%)` }}
    >
        {initialOf(name)}
    </span>
);

/** A track's cover where there's no room for a loading state: the resolved
 *  cover (`artUrl`) if any, else the artist's image, else an initial-letter
 *  placeholder (of the artist, or of the title when there's no artist tag). */
export const TrackCover: React.FC<{
    track: Pick<Track, 'artist' | 'title'>;
    artUrl?: string | null;
    className: string;
    alt?: string;
}> = ({ track, artUrl, className, alt = '' }) => {
    const artistImage = useArtistThumb(artUrl ? null : track.artist ?? null);
    const src = artUrl || artistImage;
    return src
        ? <img className={className} src={src} alt={alt} />
        : <ThumbPlaceholder name={track.artist || track.title} className={className} />;
};
