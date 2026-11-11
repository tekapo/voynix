import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDialogFocus } from '../hooks/useDialogFocus';
import { useModalKeys } from '../hooks/useModalKeys';
import { Track } from '../types';
import { filterTracks } from '../search';
import { artistLabel } from '../names';
import { Portal } from './Portal';

/** Rows drawn at once. The library can hold tens of thousands of songs; the search box narrows it. */
export const ADD_TRACKS_ROW_LIMIT = 200;

interface AddTracksModalProps {
    isOpen: boolean;
    /** Every song that can be picked (already-added ones are left out by the caller). */
    tracks: Track[];
    onClose: () => void;
    /** Called with the picked songs, in the order they appear in `tracks`. */
    onAdd: (tracks: Track[]) => void;
}

/**
 * "Add Songs…" — a search box over the library with a checkbox per song.
 * Picks survive changing the search, so songs can be gathered across several
 * searches before one "Add".
 */
export const AddTracksModal: React.FC<AddTracksModalProps> = ({ isOpen, tracks, onClose, onAdd }) => {
    const { t } = useTranslation();
    const dialogRef = useDialogFocus(isOpen);
    const [query, setQuery] = useState('');
    const [picked, setPicked] = useState<Set<string>>(new Set());

    useEffect(() => {
        if (isOpen) {
            setQuery('');
            setPicked(new Set());
        }
    }, [isOpen]);

    const matches = useMemo(() => filterTracks(tracks, query), [tracks, query]);
    const shown = matches.slice(0, ADD_TRACKS_ROW_LIMIT);

    const submit = () => {
        if (picked.size === 0) return;
        onAdd(tracks.filter(track => picked.has(track.id)));
    };

    useModalKeys({ enabled: isOpen, onEscape: onClose, onSave: submit, canSave: picked.size > 0 });

    const toggle = (id: string) => {
        setPicked(prev => {
            const next = new Set(prev);
            if (!next.delete(id)) next.add(id);
            return next;
        });
    };

    if (!isOpen) return null;
    return (
        <Portal><div className="modal-overlay">
            <div className="modal-content add-tracks-modal" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="add-tracks-title">
                <h3 id="add-tracks-title">{t('addTracks.title')}</h3>
                <input
                    type="search"
                    autoFocus
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    className="modal-input add-tracks-search"
                    placeholder={t('addTracks.searchPlaceholder')}
                    aria-label={t('addTracks.searchPlaceholder')}
                />
                {shown.length === 0 ? (
                    <div className="add-tracks-empty">{t('addTracks.noMatches')}</div>
                ) : (
                    <ul className="add-tracks-list" aria-label={t('addTracks.title')}>
                        {shown.map(track => (
                            <li key={track.id}>
                                <label className="add-tracks-row">
                                    <input type="checkbox" checked={picked.has(track.id)} onChange={() => toggle(track.id)} />
                                    <span className="add-tracks-row-text">
                                        <span className="add-tracks-row-title">{track.title}</span>
                                        <span className="add-tracks-row-sub">
                                            {[artistLabel(track, t), track.album].filter(Boolean).join(' · ')}
                                        </span>
                                    </span>
                                </label>
                            </li>
                        ))}
                    </ul>
                )}
                {matches.length > shown.length && (
                    <div className="add-tracks-more">{t('addTracks.moreHint', { shown: shown.length, total: matches.length })}</div>
                )}
                <div className="modal-actions">
                    <button type="button" className="modal-btn cancel" onClick={onClose}>{t('modals.cancel')}</button>
                    <button type="button" className="modal-btn confirm" disabled={picked.size === 0} onClick={submit}>
                        {picked.size === 0 ? t('addTracks.add') : t('addTracks.addCount', { count: picked.size })}
                    </button>
                </div>
            </div>
        </div></Portal>
    );
};
