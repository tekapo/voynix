import React, { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { formatSeconds } from '../format';
import { artistLabel } from '../names';
import { formatSpeed } from '../playback';
import { PlaybackClock } from '../playbackClock';
import { RepeatMode } from '../queue';
import { Track } from '../types';
import { Icon } from './Icon';

interface PlayerBarProps {
    currentTrack: Track | null;
    isPlaying: boolean;
    togglePlay: () => void;
    onNext?: () => void;
    onPrev?: () => void;
    onSkipBack?: () => void;
    onSkipForward?: () => void;
    shuffle?: boolean;
    onToggleShuffle?: () => void;
    repeatMode?: RepeatMode;
    onCycleRepeat?: () => void;
    // The ~250ms playback position, read via useSyncExternalStore below so a
    // tick only re-renders this component, not the whole App tree.
    clock: PlaybackClock;
    duration?: number;
    onSeek?: (time: number) => void;
    volume?: number;
    onVolumeChange?: (vol: number) => void;
    onLyricsClick?: () => void;
    isLyricsOpen?: boolean;
    artworkUrl?: string | null;
    isFavorite?: boolean;
    onToggleFavorite?: () => void;
    onQueueClick?: () => void;
    // Podcast-only playback speed (0.8–2.0x). Shown next to the ±10s buttons
    // only while a podcast is loaded.
    podcastSpeed?: number;
    onCyclePodcastSpeed?: () => void;
}

export const PlayerBar: React.FC<PlayerBarProps> = ({
    currentTrack,
    isPlaying,
    togglePlay,
    onNext,
    onPrev,
    onSkipBack,
    onSkipForward,
    shuffle = false,
    onToggleShuffle,
    repeatMode = "off",
    onCycleRepeat,
    clock,
    duration = 0,
    onSeek,
    volume = 1,
    onVolumeChange,
    onLyricsClick,
    isLyricsOpen = false,
    artworkUrl,
    isFavorite = false,
    onToggleFavorite,
    onQueueClick,
    podcastSpeed = 1.0,
    onCyclePodcastSpeed,
}) => {
    const { t } = useTranslation();
    const currentTime = useSyncExternalStore(clock.subscribe, clock.get);

    // ±10s skip is only useful for podcasts; shuffle / repeat are meaningless
    // there. A track with no `kind` (or `other`, or nothing playing) counts as
    // music. Mirrors the read pattern used elsewhere (ContextMenu.tsx).
    const isPodcast = currentTrack?.kind === 'podcast';

    const formatTime = (time: number) => (!time ? "0:00" : formatSeconds(time));

    // <input type=range> can't paint the elapsed side natively on WebKit, so the
    // track is a gradient whose stop is driven by this custom property.
    const seekPct = duration > 0
        ? Math.min(100, Math.max(0, (currentTime / duration) * 100))
        : 0;

    // Artist and album share one line; drop the separator when there's no album.
    const subtitle = currentTrack
        ? [artistLabel(currentTrack, t), currentTrack.album]
            .filter(Boolean)
            .join(" — ")
        : "";

    return (
        <div className="player-bar">
            {/* Single row: transport (left) | now-playing info | time + fav/queue/lyrics/volume */}
            <div className="player-row">
                <div className="player-controls">
                    {!isPodcast && (
                        <button
                            className={`control-btn icon-btn ${shuffle ? 'is-active' : ''}`}
                            title={shuffle ? t('player.shuffleOn') : t('player.shuffleOff')}
                            aria-label={t('player.shuffle')}
                            aria-pressed={shuffle}
                            onClick={onToggleShuffle}
                        >
                            <Icon name="shuffle" size={18} />
                        </button>
                    )}
                    <button
                        className="control-btn prev-btn"
                        onClick={onPrev}
                        disabled={!onPrev}
                        aria-label={t('player.previous')}
                    >
                        <Icon name="rewind" size={20} />
                    </button>
                    {isPodcast && (
                        <button
                            className="control-btn skip-back-btn"
                            onClick={onSkipBack}
                            disabled={!currentTrack || !onSkipBack}
                            aria-label={t('player.backTenSeconds')}
                            title={t('player.backTenSeconds')}
                        >
                            <Icon name="skip-back-10" size={20} />
                        </button>
                    )}
                    <button
                        className="play-btn"
                        onClick={togglePlay}
                        disabled={!currentTrack}
                        aria-label={isPlaying ? t('player.pause') : t('player.play')}
                    >
                        <Icon name={isPlaying ? "pause" : "play"} size={20} />
                    </button>
                    {isPodcast && (
                        <button
                            className="control-btn skip-forward-btn"
                            onClick={onSkipForward}
                            disabled={!currentTrack || !onSkipForward}
                            aria-label={t('player.forwardTenSeconds')}
                            title={t('player.forwardTenSeconds')}
                        >
                            <Icon name="skip-forward-10" size={20} />
                        </button>
                    )}
                    {isPodcast && (
                        <button
                            className="control-btn icon-btn player-speed-btn"
                            onClick={onCyclePodcastSpeed}
                            disabled={!onCyclePodcastSpeed}
                            aria-label={t('player.playbackSpeed')}
                            title={t('player.playbackSpeed')}
                        >
                            {formatSpeed(podcastSpeed)}
                        </button>
                    )}
                    <button
                        className="control-btn next-btn"
                        onClick={onNext}
                        disabled={!onNext}
                        aria-label={t('player.next')}
                    >
                        <Icon name="fast-forward" size={20} />
                    </button>
                    {!isPodcast && (
                        <button
                            className={`control-btn icon-btn ${repeatMode !== 'off' ? 'is-active' : ''}`}
                            title={t('player.repeatState', { mode: t(`player.repeatMode${repeatMode === 'off' ? 'Off' : repeatMode === 'one' ? 'One' : 'All'}`) })}
                            aria-label={t('player.repeat')}
                            aria-pressed={repeatMode !== 'off'}
                            onClick={onCycleRepeat}
                        >
                            <Icon name="repeat" size={18} />
                            {repeatMode === 'one' && <span className="repeat-one-badge" data-testid="repeat-one-badge" aria-hidden="true">1</span>}
                        </button>
                    )}
                </div>

                <div className="player-info">
                    {currentTrack ? (
                        <>
                            <div className="player-art-placeholder">
                                {artworkUrl ? (
                                    <img src={artworkUrl} alt={t('player.albumArtAlt')} style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 'inherit' }} />
                                ) : (
                                    <Icon name="music" size={22} />
                                )}
                            </div>
                            <div className="player-text">
                                <div className="player-track-title">{currentTrack.title}</div>
                                <div className="player-track-artist">{subtitle}</div>
                            </div>
                        </>
                    ) : null}
                </div>

                <div className="player-extra">
                    <span className="player-time">
                        <span className="time-current">{formatTime(currentTime)}</span>
                        {" / "}
                        <span className="time-total">{formatTime(duration)}</span>
                    </span>
                    <button
                        className={`control-btn icon-btn player-fav-btn ${isFavorite ? 'is-favorite' : ''}`}
                        title={isFavorite ? t('player.removeFromFavorites') : t('player.addToFavorites')}
                        aria-label={isFavorite ? t('player.removeFromFavorites') : t('player.addToFavorites')}
                        aria-pressed={isFavorite}
                        onClick={onToggleFavorite}
                    >
                        <Icon name={isFavorite ? "star-filled" : "star"} />
                    </button>
                    {onQueueClick && (
                        <button
                            className="control-btn icon-btn player-queue-btn"
                            title={t('player.playQueue')}
                            aria-label={t('player.playQueue')}
                            onClick={onQueueClick}
                        >
                            <Icon name="queue" size={20} />
                        </button>
                    )}
                    <button
                        className={`control-btn icon-btn player-lyrics-btn ${isLyricsOpen ? 'is-active' : ''}`}
                        title={t('player.lyrics')}
                        aria-label={t('player.lyrics')}
                        aria-pressed={isLyricsOpen}
                        onClick={onLyricsClick}
                        disabled={!currentTrack}
                    >
                        <Icon name="lyrics" size={18} />
                    </button>
                    <div className="volume-control">
                        <button className="volume-icon control-btn icon-btn" aria-label={t('player.volume')}><Icon name="volume" size={18} /></button>
                        <div className="volume-popover">
                            <input
                                type="range"
                                className="volume-slider"
                                aria-label={t('player.volumeLevel')}
                                min="0"
                                max="1"
                                step="0.01"
                                value={volume}
                                onChange={(e) => onVolumeChange && onVolumeChange(Number(e.target.value))}
                            />
                        </div>
                    </div>
                </div>

                {/* Seek line. Desktop: absolutely pinned to the bar's bottom edge.
                    Mobile: in-flow between the info row and the transport row
                    (order: 2) so a thumb near the gesture bar can't be grabbed by
                    mistake. */}
                <div className="player-seek">
                    <input
                        type="range"
                        className="progress-bar"
                        style={{ '--seek-pct': `${seekPct}%` } as React.CSSProperties}
                        aria-label={t('player.seek')}
                        min="0"
                        max={duration || 100}
                        value={currentTime}
                        onChange={(e) => onSeek && onSeek(Number(e.target.value))}
                        disabled={!currentTrack}
                    />
                </div>
            </div>
        </div>
    );
};
