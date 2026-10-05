import { useEffect } from "react";

export interface UseModalKeysOptions {
    /** Skip attaching the listener entirely (e.g. while the modal has no data yet). Default true. */
    enabled?: boolean;
    onEscape: () => void;
    onSave: () => void;
    /** Whether Cmd/Ctrl+S should call `onSave` right now (e.g. `dirty && !saving`). */
    canSave: boolean;
}

/**
 * Escape-to-close and Cmd/Ctrl+S-to-save for a modal, replacing the same
 * `useEffect` + `window.addEventListener('keydown', ...)` written out
 * separately in AlbumInfoModal, SmartPlaylistModal and TrackInfoModal.
 */
export function useModalKeys({ enabled = true, onEscape, onSave, canSave }: UseModalKeysOptions): void {
    useEffect(() => {
        if (!enabled) return;
        const handleKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                onEscape();
            } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
                e.preventDefault();
                if (canSave) onSave();
            }
        };
        window.addEventListener('keydown', handleKey);
        return () => window.removeEventListener('keydown', handleKey);
    }, [enabled, onEscape, onSave, canSave]);
}
