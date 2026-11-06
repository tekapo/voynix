import React from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from './Icon';
import type { SelfUpdate } from '../hooks/useUpdater';

/** Sidebar notice raised by the background update check; clicking opens the update dialog. */
export const UpdateNotice: React.FC<{ updater: SelfUpdate }> = ({ updater }) => {
    const { t } = useTranslation();
    const { status } = updater;
    const show = status.kind === 'available' && !updater.noticeDismissed;
    return (
        // Always mounted so assistive tech announces the text when it appears.
        <div aria-live="polite" className={show ? 'sidebar-update-notice' : undefined}>
            {show && (
                <>
                    <button type="button" className="sidebar-update-open" onClick={updater.openDialog}>
                        <Icon name="sparkle" size={14} />
                        <span>{t('update.noticeAvailable', { version: status.version })}</span>
                    </button>
                    <button
                        type="button"
                        className="sidebar-scan-cancel"
                        onClick={updater.dismissNotice}
                        title={t('update.dismissNotice')}
                        aria-label={t('update.dismissNotice')}
                    >
                        <Icon name="x" size={12} />
                    </button>
                </>
            )}
        </div>
    );
};
