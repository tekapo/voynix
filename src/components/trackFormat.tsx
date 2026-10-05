import React from 'react';
import { TFunction } from 'i18next';
import { formatSeconds } from '../format';
import { Track } from '../types';

/** "m:ss" (or "h:mm:ss" past an hour), or a placeholder when the duration is unknown. */
export function formatDuration(val?: number, placeholder = '--:--'): string {
    if (!val) return placeholder;
    return formatSeconds(val);
}

/** Podcast status dot for the title cell. 'played' renders nothing (the row is
 *  dimmed instead); 'unplayed' / 'in_progress' get a small badge. `t` is the
 *  translator from `useTranslation()`, threaded through since this is a plain
 *  function (not a component) and can't call the hook itself. */
export function podcastBadge(track: Track, t: TFunction): React.ReactNode {
    if (track.kind !== 'podcast') return null;
    const state = track.play_state ?? 'unplayed';
    if (state === 'played') return null;
    const pct = state === 'in_progress' && track.duration
        ? Math.round(((track.resume_position ?? 0) / track.duration) * 100)
        : 0;
    return (
        <span
            className={`podcast-badge podcast-badge--${state}`}
            title={state === 'in_progress' ? t('trackList.podcastTitlePct', { pct }) : t('trackList.podcastTitleUnplayed')}
            aria-label={state === 'in_progress' ? t('trackList.podcastAriaPct', { pct }) : t('trackList.podcastAriaUnplayed')}
        />
    );
}

/** True when this podcast has been played to the end (row should be dimmed). */
export function isPlayedPodcast(track: Track): boolean {
    return track.kind === 'podcast' && (track.play_state ?? 'unplayed') === 'played';
}

/** Duration-column text: "10:23 / 1:30:30" for an in-progress podcast with a
 *  known duration, otherwise the plain duration. */
export function podcastDurationText(track: Track): string {
    if (track.kind === 'podcast' && track.play_state === 'in_progress' && track.duration) {
        return `${formatSeconds(track.resume_position ?? 0)} / ${formatSeconds(track.duration)}`;
    }
    return formatDuration(track.duration);
}
