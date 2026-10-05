import React from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { Track } from '../types';
import { artistLabel } from '../names';
import { Icon } from './Icon';

interface QueuePanelProps {
    open: boolean;
    onClose: () => void;
    /** Immutable track lookup table; `order` indexes into it. */
    queue: Track[];
    /** Play order — indices into `queue`. */
    order: number[];
    /** Cursor into `order`; -1 before playback starts. */
    orderPos: number;
    /** Jump playback to `order[pos]`. */
    onJump: (pos: number) => void;
    /** Move the upcoming entry at `pos` one slot in `dir`. */
    onMove: (pos: number, dir: 1 | -1) => void;
    /** Drop the upcoming entry at `pos`. */
    onRemove: (pos: number) => void;
}

/**
 * Slide-in panel (right on desktop, full-width overlay on mobile) showing the
 * live play queue: what's played, what's playing, and what's next in the order
 * shuffle actually deals. Upcoming rows can be reordered with the up/down
 * chevrons or dropped.
 */
export const QueuePanel: React.FC<QueuePanelProps> = ({
    open,
    onClose,
    queue,
    order,
    orderPos,
    onJump,
    onMove,
    onRemove,
}) => {
    const { t } = useTranslation();
    const lastPos = order.length - 1;

    return createPortal(
        <>
            <div
                className={`queue-overlay ${open ? 'visible' : ''}`}
                onClick={onClose}
            />
            <aside
                className={`queue-panel ${open ? 'open' : ''}`}
                aria-hidden={!open}
                aria-label={t('queue.playQueue')}
            >
                <header className="queue-panel-header">
                    <h3>{t('queue.queue')}</h3>
                    <button className="close-btn" onClick={onClose} aria-label={t('queue.closeQueue')}>
                        <Icon name="x" size={18} />
                    </button>
                </header>

                <div className="queue-panel-body">
                    {order.length === 0 ? (
                        <p className="queue-empty">{t('queue.empty')}</p>
                    ) : (
                        <ol className="queue-list">
                            {order.map((idx, pos) => {
                                const track = queue[idx];
                                if (!track) return null;
                                const state =
                                    pos < orderPos ? 'played' : pos === orderPos ? 'current' : 'upcoming';
                                return (
                                    <li key={pos} className={`queue-row is-${state}`}>
                                        <button
                                            className="queue-row-main"
                                            onClick={() => onJump(pos)}
                                            disabled={state === 'current'}
                                            title={state === 'current' ? t('queue.nowPlaying') : t('queue.jumpToTrack')}
                                        >
                                            <span className="queue-row-mark">
                                                {state === 'current' ? <Icon name="play" size={11} /> : ''}
                                            </span>
                                            <span className="queue-row-text">
                                                <span className="queue-row-title">{track.title}</span>
                                                <span className="queue-row-artist">
                                                    {artistLabel(track, t)}
                                                </span>
                                            </span>
                                        </button>
                                        {state === 'upcoming' && (
                                            <span className="queue-row-actions">
                                                <button
                                                    className="queue-mini-btn"
                                                    onClick={() => onMove(pos, -1)}
                                                    disabled={pos === orderPos + 1}
                                                    aria-label={t('queue.moveUp')}
                                                >
                                                    <Icon name="chevron-up" size={16} />
                                                </button>
                                                <button
                                                    className="queue-mini-btn"
                                                    onClick={() => onMove(pos, 1)}
                                                    disabled={pos === lastPos}
                                                    aria-label={t('queue.moveDown')}
                                                >
                                                    <Icon name="chevron-down" size={16} />
                                                </button>
                                                <button
                                                    className="queue-mini-btn"
                                                    onClick={() => onRemove(pos)}
                                                    aria-label={t('queue.removeFromQueue')}
                                                >
                                                    <Icon name="x" size={15} />
                                                </button>
                                            </span>
                                        )}
                                    </li>
                                );
                            })}
                        </ol>
                    )}
                </div>
            </aside>
        </>,
        document.body,
    );
};
