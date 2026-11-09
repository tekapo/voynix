import React from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "./Icon";
import type { Track } from "../types";

interface RatingButtonsProps {
    track: Track;
    onToggleFavorite: (track: Track) => void;
    onToggleDislike: (track: Track) => void;
    size?: number;
    className?: string;
}

/**
 * Thumbs up / thumbs down pair for a track row. Up = the old "favorite" flag;
 * down hides the track from the auto lists (Settings → Library). The two are
 * mutually exclusive — the handlers (usePlaylistActions) switch between them.
 */
export const RatingButtons: React.FC<RatingButtonsProps> = ({ track, onToggleFavorite, onToggleDislike, size = 15, className = "" }) => {
    const { t } = useTranslation();
    const up = !!track.favorite;
    const down = !!track.disliked;
    const upLabel = up ? t('rating.removeThumbUp') : t('rating.thumbUp');
    const downLabel = down ? t('rating.removeThumbDown') : t('rating.thumbDown');
    return (
        <div className={`rating-cell ${className}`}>
            <button
                className={`star-btn ${up ? 'is-favorite' : ''}`}
                title={upLabel}
                aria-label={upLabel}
                aria-pressed={up}
                onClick={(e) => { e.stopPropagation(); onToggleFavorite(track); }}
            >
                <Icon name={up ? "thumb-up-filled" : "thumb-up"} size={size} />
            </button>
            <button
                className={`star-btn ${down ? 'is-disliked' : ''}`}
                title={downLabel}
                aria-label={downLabel}
                aria-pressed={down}
                onClick={(e) => { e.stopPropagation(); onToggleDislike(track); }}
            >
                <Icon name={down ? "thumb-down-filled" : "thumb-down"} size={size} />
            </button>
        </div>
    );
};
