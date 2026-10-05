import React, { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Portal } from './Modals';
import { useAlbumThumb } from '../albumArt';
import { Track } from '../types';
import { formatDuration } from './trackFormat';
import { formatBytes } from '../format';
import { Icon } from './Icon';
import { useModalKeys } from '../hooks/useModalKeys';
import i18n from '../i18n';

/** Read-only technical + tag info from `get_track_file_info` (Rust). */
interface TrackFileInfo {
    title: string | null;
    artist: string | null;
    album: string | null;
    genre: string | null;
    year: number | null;
    disc_no: number | null;
    track_no: number | null;
    duration_ms: number;
    format: string;
    audio_bitrate_kbps: number | null;
    sample_rate_hz: number | null;
    bit_depth: number | null;
    channels: number | null;
    size_bytes: number;
    modified_at: number | null;
    cloud_only: boolean;
}

export interface TrackTagFields {
    title: string;
    artist: string;
    album: string;
    disc_no: number | null;
    track_no: number | null;
}

interface TrackInfoModalProps {
    track: Track | null;
    onClose: () => void;
    onSave: (track: Track, fields: TrackTagFields) => Promise<void>;
    onShowInFinder: (track: Track) => void;
}

const formatChannels = (n: number | null, t: TFunction): string => {
    if (n === 1) return t('trackInfo.mono');
    if (n === 2) return t('trackInfo.stereo');
    if (n == null) return t('trackInfo.unknown');
    return t('trackInfo.channels', { count: n });
};

/** Number input that keeps its own text so the user can clear the field
 *  entirely; empty commits as `null`. */
const NumberField: React.FC<{
    value: number | null;
    onChange: (v: number | null) => void;
    disabled?: boolean;
    'aria-label'?: string;
}> = ({ value, onChange, disabled, ...rest }) => (
    <input
        type="number"
        min={0}
        className="modal-input track-info-number"
        value={value ?? ''}
        disabled={disabled}
        onChange={(e) => {
            const raw = e.target.value;
            onChange(raw === '' ? null : Math.max(0, parseInt(raw, 10) || 0));
        }}
        {...rest}
    />
);

type Tab = 'details' | 'file';

/**
 * "Get Info…" — shows DB + on-disk metadata for a track and lets the user
 * edit title/artist/album/disc/track, writing both the file's own tags
 * (`write_track_tags`) and the DB row (`onSave` -> App.tsx's
 * handleSaveTrackTags, which also re-keys play_events).
 *
 * Layout: a fixed header (art + live title/artist/album + tabs), a scrolling
 * body (the active tab), and a fixed footer — so Save/Cancel never scroll out
 * of view the way they did in the single-column v1 of this dialog.
 */
export const TrackInfoModal: React.FC<TrackInfoModalProps> = ({ track, onClose, onSave, onShowInFinder }) => {
    const { t } = useTranslation();
    const [info, setInfo] = useState<TrackFileInfo | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [tab, setTab] = useState<Tab>('details');
    const [confirmDiscard, setConfirmDiscard] = useState(false);
    const [copied, setCopied] = useState(false);

    const [title, setTitle] = useState('');
    const [artist, setArtist] = useState('');
    const [album, setAlbum] = useState('');
    const [discNo, setDiscNo] = useState<number | null>(null);
    const [trackNo, setTrackNo] = useState<number | null>(null);

    const titleInputRef = useRef<HTMLInputElement>(null);
    const art = useAlbumThumb(track, 96);

    useEffect(() => {
        if (!track) return;
        setInfo(null);
        setError(null);
        setTab('details');
        setConfirmDiscard(false);
        setLoading(true);
        invoke<TrackFileInfo>('get_track_file_info', { path: track.file_path })
            .then((result) => {
                setInfo(result);
                setTitle(result.title ?? track.title);
                setArtist(result.artist ?? track.artist ?? '');
                setAlbum(result.album ?? track.album ?? '');
                setDiscNo(result.disc_no ?? track.disc_no ?? null);
                setTrackNo(result.track_no ?? track.track_no ?? null);
            })
            .catch((err) => {
                console.error('Failed to read track info:', err);
                setError(t('trackInfo.readFileInfoFailed', { error: String(err) }));
            })
            .finally(() => setLoading(false));
    }, [track]);

    // Focus Title as soon as it's editable, so typing can start immediately.
    useEffect(() => {
        if (info && !info.cloud_only) titleInputRef.current?.focus();
    }, [info]);

    const dirty = useMemo(() => info != null && (
        title !== (info.title ?? track?.title ?? '') ||
        artist !== (info.artist ?? track?.artist ?? '') ||
        album !== (info.album ?? track?.album ?? '') ||
        discNo !== (info.disc_no ?? track?.disc_no ?? null) ||
        trackNo !== (info.track_no ?? track?.track_no ?? null)
    ), [info, track, title, artist, album, discNo, trackNo]);

    const canEdit = info != null && !info.cloud_only;

    const handleSave = async () => {
        if (!track) return;
        setSaving(true);
        setError(null);
        try {
            await onSave(track, { title: title.trim(), artist: artist.trim(), album: album.trim(), disc_no: discNo, track_no: trackNo });
            onClose();
        } catch (err) {
            console.error('Failed to save track tags:', err);
            setError(t('trackInfo.saveFailed', { error: String(err) }));
        } finally {
            setSaving(false);
        }
    };

    const requestClose = () => {
        if (dirty && !saving) {
            setConfirmDiscard(true);
            return;
        }
        onClose();
    };

    useModalKeys({ onEscape: requestClose, onSave: handleSave, canSave: canEdit && dirty && !saving });

    const handleCopyPath = () => {
        if (!track) return;
        navigator.clipboard?.writeText(track.file_path).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        }).catch(() => {});
    };

    if (!track) return null;

    return (
        <Portal><div className="modal-overlay" onClick={requestClose}>
            <div className="modal-content info-modal" onClick={e => e.stopPropagation()}>
                <div className="info-modal-header">
                    {art
                        ? <img src={art} alt="" className="info-modal-art" />
                        : <div className="info-modal-art info-modal-art-placeholder"><Icon name="music" size={28} /></div>}
                    <div className="info-modal-header-text">
                        <div className="info-modal-title" title={title || track.file_name}>{title || track.file_name}</div>
                        <div className="info-modal-subtitle">
                            {[artist, album].filter(Boolean).join(' — ') || track.file_name}
                        </div>
                    </div>
                </div>

                <div className="settings-tabs info-modal-tabs" role="tablist">
                    <button type="button" role="tab" aria-selected={tab === 'details'}
                        className={`settings-tab${tab === 'details' ? ' active' : ''}`}
                        onClick={() => setTab('details')}>
                        {t('trackInfo.details')}
                    </button>
                    <button type="button" role="tab" aria-selected={tab === 'file'}
                        className={`settings-tab${tab === 'file' ? ' active' : ''}`}
                        onClick={() => setTab('file')}>
                        {t('trackInfo.file')}
                    </button>
                </div>

                <div className="info-modal-body">
                    {loading && (
                        <div className="info-modal-skeleton">
                            <div className="info-modal-skeleton-line" />
                            <div className="info-modal-skeleton-line" />
                            <div className="info-modal-skeleton-line" />
                        </div>
                    )}

                    {!loading && tab === 'details' && (
                        <form className="info-modal-form" onSubmit={(e) => { e.preventDefault(); if (canEdit && dirty) handleSave(); }}>
                            {info?.cloud_only && (
                                <p className="settings-hint track-info-cloud-notice">
                                    {t('trackInfo.cloudNotEditable')}
                                </p>
                            )}
                            <div className="info-modal-fields">
                                <label htmlFor="info-modal-title">{t('trackInfo.title')}</label>
                                <input id="info-modal-title" ref={titleInputRef} type="text" className="modal-input"
                                    value={title} disabled={!canEdit} onChange={(e) => setTitle(e.target.value)} />

                                <label htmlFor="track-info-artist">{t('trackInfo.artist')}</label>
                                <input id="track-info-artist" type="text" className="modal-input"
                                    value={artist} disabled={!canEdit} onChange={(e) => setArtist(e.target.value)} />

                                <label htmlFor="track-info-album">{t('trackInfo.album')}</label>
                                <input id="track-info-album" type="text" className="modal-input"
                                    value={album} disabled={!canEdit} onChange={(e) => setAlbum(e.target.value)} />

                                <label htmlFor="track-info-disc">{t('trackInfo.discTrack')}</label>
                                <div className="track-info-numbers">
                                    <NumberField value={discNo} onChange={setDiscNo} disabled={!canEdit} aria-label={t('trackInfo.discNumber')} />
                                    <span className="track-info-numbers-sep">/</span>
                                    <NumberField value={trackNo} onChange={setTrackNo} disabled={!canEdit} aria-label={t('trackInfo.trackNumber')} />
                                </div>
                            </div>
                            {/* Enter-to-submit needs a submit button in the form. */}
                            <button type="submit" style={{ display: 'none' }} aria-hidden="true" />

                            <div className="info-modal-chips">
                                <span className="info-modal-chip">
                                    <Icon name="play" size={12} /> {track.play_count ?? 0}
                                </span>
                                <span className="info-modal-chip">
                                    {track.last_played ? new Date(track.last_played).toLocaleDateString(i18n.language) : t('trackInfo.neverPlayed')}
                                </span>
                                {!!track.favorite && (
                                    <span className="info-modal-chip">
                                        <Icon name="star-filled" size={12} /> {t('trackInfo.favorite')}
                                    </span>
                                )}
                                <span className="info-modal-chip">{track.kind ?? 'music'}</span>
                                {track.added_at && (
                                    <span className="info-modal-chip">{t('trackInfo.added', { date: new Date(track.added_at).toLocaleDateString(i18n.language) })}</span>
                                )}
                            </div>
                        </form>
                    )}

                    {!loading && tab === 'file' && info && !info.cloud_only && (
                        <div className="track-info-file">
                            <section className="track-info-section">
                                <h4>{t('trackInfo.audio')}</h4>
                                <dl className="track-info-grid">
                                    <dt>{t('trackInfo.format')}</dt><dd>{info.format || t('trackInfo.unknown')}</dd>
                                    <dt>{t('trackInfo.duration')}</dt><dd>{formatDuration(info.duration_ms / 1000)}</dd>
                                    <dt>{t('trackInfo.bitrate')}</dt><dd>{info.audio_bitrate_kbps ? t('trackInfo.bitrateValue', { kbps: info.audio_bitrate_kbps }) : t('trackInfo.unknown')}</dd>
                                    <dt>{t('trackInfo.sampleRate')}</dt><dd>{info.sample_rate_hz ? t('trackInfo.sampleRateValue', { khz: (info.sample_rate_hz / 1000).toFixed(1) }) : t('trackInfo.unknown')}</dd>
                                    <dt>{t('trackInfo.bitDepth')}</dt><dd>{info.bit_depth ? t('trackInfo.bitDepthValue', { bits: info.bit_depth }) : t('trackInfo.unknown')}</dd>
                                    <dt>{t('trackInfo.channelsLabel')}</dt><dd>{formatChannels(info.channels, t)}</dd>
                                </dl>
                            </section>

                            <section className="track-info-section">
                                <h4>{t('trackInfo.tags')}</h4>
                                <dl className="track-info-grid">
                                    <dt>{t('trackInfo.genre')}</dt><dd>{info.genre ?? t('trackInfo.unknown')}</dd>
                                    <dt>{t('trackInfo.year')}</dt><dd>{info.year ?? t('trackInfo.unknown')}</dd>
                                </dl>
                            </section>

                            <section className="track-info-section">
                                <h4>{t('trackInfo.file')}</h4>
                                <dl className="track-info-grid">
                                    <dt>{t('trackInfo.size')}</dt><dd>{formatBytes(info.size_bytes)}</dd>
                                    <dt>{t('trackInfo.modified')}</dt><dd>{info.modified_at ? new Date(info.modified_at).toLocaleString(i18n.language) : t('trackInfo.unknown')}</dd>
                                </dl>
                                <div className="track-info-path-row">
                                    <span className="track-info-path" title={track.file_path}>{track.file_path}</span>
                                    <button type="button" className="modal-btn track-info-copy-btn" onClick={handleCopyPath}>
                                        {copied ? t('trackInfo.copied') : t('trackInfo.copy')}
                                    </button>
                                </div>
                            </section>
                        </div>
                    )}

                    {!loading && tab === 'file' && info?.cloud_only && (
                        <p className="settings-hint track-info-cloud-notice">
                            {t('trackInfo.cloudNotAvailable')}
                        </p>
                    )}
                </div>

                {error && <div className="error-banner info-modal-error">{error}</div>}

                <div className="info-modal-footer">
                    {confirmDiscard ? (
                        <div className="info-modal-confirm-discard">
                            <span>{t('trackInfo.unsavedChanges')}</span>
                            <div className="info-modal-confirm-actions">
                                <button type="button" className="modal-btn" onClick={() => setConfirmDiscard(false)}>{t('trackInfo.keepEditing')}</button>
                                <button type="button" className="modal-btn cancel" onClick={onClose}>{t('trackInfo.discard')}</button>
                            </div>
                        </div>
                    ) : (
                        <>
                            <button type="button" className="modal-btn track-info-finder-btn" onClick={() => onShowInFinder(track)}>
                                <Icon name="folder" size={14} /> {t('trackInfo.showInFinder')}
                            </button>
                            <div className="modal-actions info-modal-footer-actions">
                                <button type="button" className="modal-btn cancel" onClick={requestClose}>{t('trackInfo.cancel')}</button>
                                <button type="button" className="modal-btn confirm" disabled={!dirty || !canEdit || saving} onClick={handleSave}>
                                    {saving ? t('trackInfo.saving') : t('trackInfo.save')}
                                </button>
                            </div>
                        </>
                    )}
                </div>
            </div>
        </div></Portal>
    );
};
