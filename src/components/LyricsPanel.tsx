import { invoke } from '@tauri-apps/api/core';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { updateLyrics } from '../db';
import { artistLabel } from '../names';
import { Icon } from './Icon';
import { Track } from '../types';

interface LyricsPanelProps {
    isOpen: boolean;
    onClose: () => void;
    track: Track | null;
}

/**
 * Docked lyrics column. Lives to the right of the track list (a real flex
 * column that shrinks the list when open); on mobile it becomes a full-screen
 * overlay via CSS alone. Replaces the old centered LyricsModal.
 */
export const LyricsPanel: React.FC<LyricsPanelProps> = ({ isOpen, onClose, track }) => {
    const { t } = useTranslation();
    const [isEditing, setIsEditing] = useState(false);
    const [lyrics, setLyrics] = useState("");
    const [fetching, setFetching] = useState(false);
    // Local error surface — a failed save shouldn't reach for a blocking alert().
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!isOpen || !track) return;
        setLyrics(track.lyrics || "");
        setIsEditing(false); // Reset to view mode when opening / switching tracks
        if (track.lyrics && track.lyrics.trim()) return;

        // No embedded lyrics — try LRCLIB (cached on disk by the Rust side).
        let canceled = false;
        setFetching(true);
        invoke<string | null>("fetch_lyrics", {
            artist: track.artist ?? "",
            title: track.title,
            album: track.album ?? "",
            duration: track.duration ?? null,
        })
            .then(async (text) => {
                if (canceled || !text) return;
                setLyrics(text);
                track.lyrics = text;
                try { await updateLyrics(track.id, text); } catch (e) { console.error("Failed to cache lyrics:", e); }
            })
            .catch((e) => console.error("Lyrics fetch failed:", e))
            .finally(() => { if (!canceled) setFetching(false); });
        return () => { canceled = true; };
    }, [track, isOpen]);

    const handleSave = async () => {
        if (!track) return;
        try {
            await updateLyrics(track.id, lyrics);
            track.lyrics = lyrics;
            setIsEditing(false);
        } catch (error) {
            console.error("Failed to save lyrics:", error);
            setError(t("lyrics.saveFailed"));
        }
    };

    if (!isOpen) return null;

    return (
        <aside className="lyrics-panel" aria-label={t('lyrics.lyrics')}>
            <div className="lyrics-header">
                <h3>
                    {track ? track.title : t('lyrics.lyrics')}
                    {track && <span className="lyrics-artist"> - {artistLabel(track, t)}</span>}
                </h3>
                <button className="close-btn" onClick={onClose} aria-label={t('lyrics.closeLyrics')}>
                    <Icon name="x" size={18} />
                </button>
            </div>

            <div className="lyrics-body">
                {!track ? (
                    <div className="no-lyrics">{t('lyrics.noTrackPlaying')}</div>
                ) : isEditing ? (
                    <textarea
                        className="lyrics-editor"
                        value={lyrics}
                        onChange={(e) => setLyrics(e.target.value)}
                        placeholder={t('lyrics.enterLyricsHere')}
                    />
                ) : (
                    <div className="lyrics-display">
                        {lyrics ? (
                            lyrics.split('\n').map((line, i) => (
                                <p key={i} className="lyrics-line">{line || ' '}</p>
                            ))
                        ) : fetching ? (
                            <div className="no-lyrics">{t('lyrics.fetchingLyrics')}</div>
                        ) : (
                            <div className="no-lyrics">{t('lyrics.noLyricsAvailable')}</div>
                        )}
                    </div>
                )}
            </div>

            {error && <div className="lyrics-error">{error}</div>}

            {track && (
                <div className="lyrics-panel-actions">
                    {isEditing ? (
                        <>
                            <button className="modal-btn cancel" onClick={() => setIsEditing(false)}>{t('lyrics.cancel')}</button>
                            <button className="modal-btn confirm" onClick={handleSave}>{t('lyrics.save')}</button>
                        </>
                    ) : (
                        <button className="modal-btn confirm" onClick={() => setIsEditing(true)}>{t('lyrics.edit')}</button>
                    )}
                </div>
            )}
        </aside>
    );
};
