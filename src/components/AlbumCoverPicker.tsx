import { invoke } from '@tauri-apps/api/core';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from './Icon';
import { Portal } from './Modals';

export interface AlbumCoverCandidate {
    id: string;
    title: string;
    artist: string;
    image_url: string;
    thumb_url: string;
    source: 'itunes' | 'deezer';
}

interface AlbumCoverPickerProps {
    isOpen: boolean;
    query: string;
    onClose: () => void;
    /** Downloads `imageUrl` and stores it as the album's cover override. */
    onSelect: (imageUrl: string) => Promise<void>;
}

/**
 * "Find Album Cover…" — searches iTunes + Deezer for `query` ("artist album")
 * and lets the user pick one of the candidate covers. Distinct from the plain
 * file picker (`handleSetAlbumCover` in App.tsx): this one goes out to the
 * network.
 */
export const AlbumCoverPicker: React.FC<AlbumCoverPickerProps> = ({ isOpen, query: initialQuery, onClose, onSelect }) => {
    const { t } = useTranslation();
    const [query, setQuery] = useState(initialQuery);
    const [candidates, setCandidates] = useState<AlbumCoverCandidate[]>([]);
    const [loading, setLoading] = useState(false);
    const [applyingId, setApplyingId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const search = async (q: string) => {
        setLoading(true);
        setError(null);
        try {
            const results = await invoke<AlbumCoverCandidate[]>("search_album_covers", { query: q });
            setCandidates(results);
        } catch (err) {
            console.error("Album cover search failed:", err);
            setError(t('albumCoverPicker.searchFailed', { error: String(err) }));
            setCandidates([]);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (!isOpen) return;
        setQuery(initialQuery);
        setCandidates([]);
        setError(null);
        search(initialQuery);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen, initialQuery]);

    if (!isOpen) return null;

    const handlePick = async (candidate: AlbumCoverCandidate) => {
        setApplyingId(candidate.id);
        setError(null);
        try {
            await onSelect(candidate.image_url);
            onClose();
        } catch (err) {
            console.error("Failed to apply album cover:", err);
            setError(t('albumCoverPicker.applyFailed', { error: String(err) }));
        } finally {
            setApplyingId(null);
        }
    };

    return (
        <Portal><div className="modal-overlay" onClick={onClose}>
            <div className="modal-content artist-image-picker" onClick={e => e.stopPropagation()}>
                <h3>{t('albumCoverPicker.title')}</h3>
                <form
                    onSubmit={e => { e.preventDefault(); search(query); }}
                    style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem' }}
                >
                    <input
                        type="text"
                        className="modal-input"
                        value={query}
                        onChange={e => setQuery(e.target.value)}
                        placeholder={t('albumCoverPicker.queryPlaceholder')}
                        autoFocus
                    />
                    <button type="submit" className="modal-btn cancel" disabled={loading || !query.trim()}>
                        {t('albumCoverPicker.search')}
                    </button>
                </form>

                {error && <p className="settings-hint" style={{ color: 'var(--danger, #e55)' }}>{error}</p>}

                {loading ? (
                    <p className="settings-hint">{t('albumCoverPicker.searching')}</p>
                ) : candidates.length === 0 ? (
                    <p className="settings-hint">{t('albumCoverPicker.noMatches')}</p>
                ) : (
                    <div className="artist-image-grid">
                        {candidates.map(c => (
                            <button
                                key={c.id}
                                type="button"
                                className="artist-image-candidate"
                                disabled={applyingId !== null}
                                onClick={() => handlePick(c)}
                                title={`${c.title} — ${c.artist}`}
                            >
                                <img src={c.thumb_url} alt={c.title} />
                                <span className="artist-image-candidate-name">{c.title}<br />{c.artist}</span>
                                {applyingId === c.id && <span className="artist-image-candidate-loading">{t('albumCoverPicker.applying')}</span>}
                            </button>
                        ))}
                    </div>
                )}

                <div className="modal-actions">
                    <button type="button" className="modal-btn cancel" onClick={onClose}>
                        <Icon name="x" size={14} /> {t('albumCoverPicker.close')}
                    </button>
                </div>
            </div>
        </div></Portal>
    );
};
