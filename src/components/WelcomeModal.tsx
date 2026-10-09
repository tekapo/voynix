import React, { useEffect, useState } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useTranslation } from 'react-i18next';
import { Portal } from './Modals';

const STEPS = [
    { title: 'welcome.step1Title', body: 'welcome.step1Body' },
    { title: 'welcome.step2Title', body: 'welcome.step2Body' },
    { title: 'welcome.step3Title', body: 'welcome.step3Body' },
] as const;

interface WelcomeModalProps {
    isOpen: boolean;
    onClose: () => void;
    hasFolders: boolean;
    isScanning: boolean;
    scanProgress?: { done: number; total: number } | null;
    onAddFolder: () => void;
    /** Closes this dialog and opens the sync (QR pairing) dialog. */
    onOpenSync: () => void;
}

/** First-launch guide: add a music folder, then pair with the Android app. */
export const WelcomeModal: React.FC<WelcomeModalProps> = ({
    isOpen, onClose, hasFolders, isScanning, scanProgress = null, onAddFolder, onOpenSync,
}) => {
    const { t } = useTranslation();
    const [step, setStep] = useState(0);

    useEffect(() => {
        if (isOpen) setStep(0);
    }, [isOpen]);

    useEffect(() => {
        if (!isOpen) return;
        const handleKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                onClose();
            }
        };
        window.addEventListener('keydown', handleKey);
        return () => window.removeEventListener('keydown', handleKey);
    }, [isOpen, onClose]);

    if (!isOpen) return null;

    const last = step === STEPS.length - 1;
    return (
        <Portal>
            <div className="modal-overlay" onClick={onClose}>
                <div
                    className="modal-content welcome-modal"
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="welcome-title"
                    onClick={e => e.stopPropagation()}
                >
                    <h3 id="welcome-title">{t(STEPS[step].title)}</h3>
                    <p className="settings-hint">{t(STEPS[step].body)}</p>

                    {step === 1 && <div className="welcome-action">
                        <button type="button" className="modal-btn confirm" onClick={onAddFolder} disabled={isScanning} autoFocus>
                            {t('welcome.addFolder')}
                        </button>
                        {isScanning && <p className="settings-hint">
                            {scanProgress
                                ? t('welcome.scanningProgress', { done: scanProgress.done, total: scanProgress.total })
                                : t('welcome.scanning')}
                        </p>}
                        {!isScanning && hasFolders && <p className="settings-hint">{t('welcome.folderAdded')}</p>}
                    </div>}

                    {last && <div className="welcome-action">
                        <button type="button" className="modal-btn confirm" onClick={onOpenSync} autoFocus>
                            {t('welcome.openSync')}
                        </button>
                        {' '}
                        <button type="button" className="modal-btn cancel" onClick={() => { openUrl(t('settings.websiteUrl')).catch(() => {}); }}>
                            {t('welcome.openManual')}
                        </button>
                    </div>}

                    <div className="welcome-dots" aria-hidden="true">
                        {Array.from({ length: STEPS.length }, (_, i) => <span key={i} className={i === step ? 'active' : ''} />)}
                    </div>

                    <div className="modal-actions">
                        <button type="button" className="modal-btn cancel" onClick={onClose}>
                            {last ? t('welcome.done') : t('welcome.skip')}
                        </button>
                        {step > 0 && <button type="button" className="modal-btn cancel" onClick={() => setStep(step - 1)}>
                            {t('welcome.back')}
                        </button>}
                        {!last && <button type="button" className="modal-btn confirm" onClick={() => setStep(step + 1)}>
                            {t('welcome.next')}
                        </button>}
                    </div>
                </div>
            </div>
        </Portal>
    );
};
