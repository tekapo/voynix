import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Portal } from './Modals';
import { useAlbumThumb } from '../albumArt';
import { effectiveAlbum } from '../albumName';
import { Track } from '../types';
import { formatDuration } from './trackFormat';
import { Icon } from './Icon';
import { useModalKeys } from '../hooks/useModalKeys';
import { artistLabel } from '../names';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';

export interface AlbumTagFields {
    artist: string;
    album: string;
}

interface AlbumInfoModalProps {
    /** Every track in this album (sortNatural'd), or `[]` to render nothing —
     *  mirrors TrackInfoModal's `track: Track | null`. */
    tracks: Track[];
    onClose: () => void;
    /** Rewrites artist/album on every track's file + DB row. `onProgress` is
     *  called after each file so the Save button can show "Saving… n/total". */
    onSave: (tracks: Track[], fields: AlbumTagFields, onProgress: (done: number, total: number) => void) => Promise<void>;
}

type Tab = 'details' | 'tracks';

/**
 * Album-level "Get Info…" — same fixed-header/scrolling-body/fixed-footer
 * shell as TrackInfoModal (shares the `.info-modal-*` CSS), but edits
 * artist/album across every track in the album at once (title/disc/track are
 * per-track and stay out of scope here — use the track's own Get Info for
 * those). See App.tsx's handleSaveAlbumTags for the per-file write loop.
 */
export const AlbumInfoModal: React.FC<AlbumInfoModalProps> = ({ tracks, onClose, onSave }) => {
    const { t } = useTranslation();
    const [artist, setArtist] = useState('');
    const [album, setAlbum] = useState('');
    const [tab, setTab] = useState<Tab>('details');
    const [saving, setSaving] = useState(false);
    const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [confirmDiscard, setConfirmDiscard] = useState(false);

    const albumInputRef = useRef<HTMLInputElement>(null);
    const first = tracks[0] ?? null;
    const art = useAlbumThumb(first, 96);

    useEffect(() => {
        if (tracks.length === 0) return;
        setArtist(tracks[0].artist ?? '');
        setAlbum(tracks[0].album ?? '');
        setTab('details');
        setError(null);
        setConfirmDiscard(false);
        setProgress(null);
    }, [tracks]);

    useEffect(() => {
        if (tracks.length > 0) albumInputRef.current?.focus();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tracks.length > 0]);

    const dirty = tracks.length > 0 && (
        artist !== (tracks[0].artist ?? '') ||
        album !== (tracks[0].album ?? '')
    );

    const stats = useMemo(() => {
        const totalDuration = tracks.reduce((s, t) => s + (t.duration || 0), 0);
        const totalPlays = tracks.reduce((s, t) => s + (t.play_count ?? 0), 0);
        const favorites = tracks.filter(t => t.favorite).length;
        const addedDates = tracks.map(t => t.added_at).filter((d): d is number => !!d);
        const earliestAdded = addedDates.length ? Math.min(...addedDates) : null;
        return { totalDuration, totalPlays, favorites, earliestAdded };
    }, [tracks]);

    const handleSave = async () => {
        if (tracks.length === 0) return;
        setSaving(true);
        setError(null);
        setProgress({ done: 0, total: tracks.length });
        try {
            await onSave(tracks, { artist: artist.trim(), album: album.trim() }, (done, total) => setProgress({ done, total }));
            onClose();
        } catch (err) {
            console.error('Failed to save album tags:', err);
            setError(String(err instanceof Error ? err.message : err));
        } finally {
            setSaving(false);
            setProgress(null);
        }
    };

    const requestClose = () => {
        if (dirty && !saving) {
            setConfirmDiscard(true);
            return;
        }
        onClose();
    };

    useModalKeys({ onEscape: requestClose, onSave: handleSave, canSave: dirty && !saving });

    if (tracks.length === 0) return null;

    // The `album` field above is the raw, editable tag (blank when untagged,
    // so the user can type in a real one). The header title falls back to
    // the folder-derived name instead of a bare "Unknown Album" when it's
    // still blank, matching what the Albums grid already groups this under.
    const albumFallback = effectiveAlbum(first ?? tracks[0]) ?? t('albumInfo.unknownAlbum');

    return (
        <Portal><div className="modal-overlay" onClick={requestClose}>
            <div className="modal-content info-modal" onClick={e => e.stopPropagation()}>
                <div className="info-modal-header">
                    {art
                        ? <img src={art} alt="" className="info-modal-art" />
                        : <div className="info-modal-art info-modal-art-placeholder"><Icon name="disc" size={28} /></div>}
                    <div className="info-modal-header-text">
                        <div className="info-modal-title" title={album || albumFallback}>{album || albumFallback}</div>
                        <div className="info-modal-subtitle">{artistLabel({ artist }, t)}</div>
                    </div>
                </div>

                <div className="settings-tabs info-modal-tabs" role="tablist">
                    <button type="button" role="tab" aria-selected={tab === 'details'}
                        className={`settings-tab${tab === 'details' ? ' active' : ''}`}
                        onClick={() => setTab('details')}>
                        {t('albumInfo.details')}
                    </button>
                    <button type="button" role="tab" aria-selected={tab === 'tracks'}
                        className={`settings-tab${tab === 'tracks' ? ' active' : ''}`}
                        onClick={() => setTab('tracks')}>
                        {t('albumInfo.tracks')}
                    </button>
                </div>

                <div className="info-modal-body">
                    {tab === 'details' && (
                        <form className="info-modal-form" onSubmit={(e) => { e.preventDefault(); if (dirty) handleSave(); }}>
                            <div className="info-modal-fields">
                                <label htmlFor="album-info-artist">{t('albumInfo.artist')}</label>
                                <input id="album-info-artist" ref={albumInputRef} type="text" className="modal-input"
                                    value={artist} onChange={(e) => setArtist(e.target.value)} />

                                <label htmlFor="album-info-album">{t('albumInfo.album')}</label>
                                <input id="album-info-album" type="text" className="modal-input"
                                    value={album} onChange={(e) => setAlbum(e.target.value)} />
                            </div>
                            {/* Enter-to-submit needs a submit button in the form. */}
                            <button type="submit" style={{ display: 'none' }} aria-hidden="true" />

                            <div className="info-modal-chips">
                                <span className="info-modal-chip">{t('albumInfo.tracksCount', { count: tracks.length })}</span>
                                <span className="info-modal-chip">{formatDuration(stats.totalDuration)}</span>
                                <span className="info-modal-chip">
                                    <Icon name="play" size={12} /> {stats.totalPlays}
                                </span>
                                {stats.favorites > 0 && (
                                    <span className="info-modal-chip">
                                        <Icon name="star-filled" size={12} /> {t('albumInfo.favoritesCount', { count: stats.favorites })}
                                    </span>
                                )}
                                {stats.earliestAdded && (
                                    <span className="info-modal-chip">{t('albumInfo.added', { date: new Date(stats.earliestAdded).toLocaleDateString(i18n.language) })}</span>
                                )}
                            </div>
                        </form>
                    )}

                    {tab === 'tracks' && (
                        <div className="album-info-track-list">
                            {tracks.map(t => (
                                <div key={t.id} className="album-info-track-row">
                                    <span className="album-info-track-no">{t.track_no ?? ''}</span>
                                    <span className="album-info-track-title" title={t.title}>{t.title}</span>
                                    <span className="album-info-track-duration">{formatDuration(t.duration)}</span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {error && <div className="error-banner info-modal-error">{error}</div>}

                <div className="info-modal-footer">
                    {confirmDiscard ? (
                        <div className="info-modal-confirm-discard">
                            <span>{t('albumInfo.unsavedChanges')}</span>
                            <div className="info-modal-confirm-actions">
                                <button type="button" className="modal-btn" onClick={() => setConfirmDiscard(false)}>{t('albumInfo.keepEditing')}</button>
                                <button type="button" className="modal-btn cancel" onClick={onClose}>{t('albumInfo.discard')}</button>
                            </div>
                        </div>
                    ) : (
                        <div className="modal-actions info-modal-footer-actions" style={{ width: '100%', justifyContent: 'flex-end' }}>
                            <button type="button" className="modal-btn cancel" onClick={requestClose}>{t('albumInfo.cancel')}</button>
                            <button type="button" className="modal-btn confirm" disabled={!dirty || saving} onClick={handleSave}>
                                {saving && progress ? t('albumInfo.savingProgress', { done: progress.done, total: progress.total }) : saving ? t('albumInfo.saving') : t('albumInfo.save')}
                            </button>
                        </div>
                    )}
                </div>
            </div>
        </div></Portal>
    );
};
