import { invoke } from '@tauri-apps/api/core';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from './Icon';
import { Portal } from './Modals';

export interface ArtistImageCandidate {
    id: number;
    name: string;
    picture_url: string;
    thumb_url: string;
    nb_fan: number;
}

interface ArtistImagePickerProps {
    isOpen: boolean;
    artist: string;
    onClose: () => void;
    /** Downloads `pictureUrl` and stores it as the artist's cover override. */
    onSelect: (pictureUrl: string) => Promise<void>;
}

/**
 * "Find Artist Image…" — searches Deezer for `artist` and lets the user pick
 * one of the candidate photos. Distinct from the plain file picker
 * (`handleSetArtistImage` in App.tsx): this one goes out to the network.
 */
export const ArtistImagePicker: React.FC<ArtistImagePickerProps> = ({ isOpen, artist, onClose, onSelect }) => {
    const { t } = useTranslation();
    const [query, setQuery] = useState(artist);
    const [candidates, setCandidates] = useState<ArtistImageCandidate[]>([]);
    const [loading, setLoading] = useState(false);
    const [applyingId, setApplyingId] = useState<number | null>(null);
    const [error, setError] = useState<string | null>(null);

    const search = async (q: string) => {
        setLoading(true);
        setError(null);
        try {
            const results = await invoke<ArtistImageCandidate[]>("search_artist_images", { artist: q });
            setCandidates(results);
        } catch (err) {
            console.error("Artist image search failed:", err);
            setError(t('artistImagePicker.searchFailed', { error: String(err) }));
            setCandidates([]);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (!isOpen) return;
        setQuery(artist);
        setCandidates([]);
        setError(null);
        search(artist);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen, artist]);

    if (!isOpen) return null;

    const handlePick = async (candidate: ArtistImageCandidate) => {
        setApplyingId(candidate.id);
        setError(null);
        try {
            await onSelect(candidate.picture_url);
            onClose();
        } catch (err) {
            console.error("Failed to apply artist image:", err);
            setError(t('artistImagePicker.applyFailed', { error: String(err) }));
        } finally {
            setApplyingId(null);
        }
    };

    return (
        <Portal><div className="modal-overlay" onClick={onClose}>
            <div className="modal-content artist-image-picker" onClick={e => e.stopPropagation()}>
                <h3>{t('artistImagePicker.title')}</h3>
                <form
                    onSubmit={e => { e.preventDefault(); search(query); }}
                    style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem' }}
                >
                    <input
                        type="text"
                        className="modal-input"
                        value={query}
                        onChange={e => setQuery(e.target.value)}
                        placeholder={t('artistImagePicker.artistNamePlaceholder')}
                        autoFocus
                    />
                    <button type="submit" className="modal-btn cancel" disabled={loading || !query.trim()}>
                        {t('artistImagePicker.search')}
                    </button>
                </form>

                {error && <p className="settings-hint" style={{ color: 'var(--danger, #e55)' }}>{error}</p>}

                {loading ? (
                    <p className="settings-hint">{t('artistImagePicker.searching')}</p>
                ) : candidates.length === 0 ? (
                    <p className="settings-hint">{t('artistImagePicker.noMatches')}</p>
                ) : (
                    <div className="artist-image-grid">
                        {candidates.map(c => (
                            <button
                                key={c.id}
                                type="button"
                                className="artist-image-candidate"
                                disabled={applyingId !== null}
                                onClick={() => handlePick(c)}
                                title={t('artistImagePicker.fansTitle', { name: c.name, count: c.nb_fan.toLocaleString() })}
                            >
                                <img src={c.thumb_url} alt={c.name} />
                                <span className="artist-image-candidate-name">{c.name}</span>
                                {applyingId === c.id && <span className="artist-image-candidate-loading">{t('artistImagePicker.applying')}</span>}
                            </button>
                        ))}
                    </div>
                )}

                <div className="modal-actions">
                    <button type="button" className="modal-btn cancel" onClick={onClose}>
                        <Icon name="x" size={14} /> {t('artistImagePicker.close')}
                    </button>
                </div>
            </div>
        </div></Portal>
    );
};
