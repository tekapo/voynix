import React from 'react';
import { useTranslation } from 'react-i18next';
import { Portal } from './Modals';
import type { SelfUpdate } from '../hooks/useUpdater';

/** "Voynix X.Y.Z is available" — install is always the user's call. */
export const UpdateModal: React.FC<{ updater: SelfUpdate }> = ({ updater }) => {
    const { t } = useTranslation();
    const { status } = updater;
    const downloading = status.kind === 'downloading';
    if (!updater.dialogOpen || (status.kind !== 'available' && !downloading)) return null;

    const close = downloading ? () => {} : updater.dismiss;
    const percent = downloading && status.total ? Math.min(100, Math.floor((status.done / status.total) * 100)) : null;
    return (
        <Portal>
            <div className="modal-overlay" onClick={close}>
                <div
                    className="modal-content update-modal"
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="update-title"
                    onClick={e => e.stopPropagation()}
                >
                    <h3 id="update-title">{t('update.title', { version: status.version })}</h3>
                    {status.kind === 'available' && status.notes && <pre className="update-notes">{status.notes}</pre>}
                    {downloading && <p className="settings-hint">
                        {percent === null ? t('update.downloadingUnknown') : t('update.downloading', { percent })}
                    </p>}
                    <div className="modal-actions">
                        <button type="button" className="modal-btn cancel" onClick={close} disabled={downloading}>
                            {t('update.later')}
                        </button>
                        <button type="button" className="modal-btn confirm" onClick={updater.install} disabled={downloading} autoFocus>
                            {t('update.install')}
                        </button>
                    </div>
                </div>
            </div>
        </Portal>
    );
};
