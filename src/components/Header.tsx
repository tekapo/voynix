import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from './Icon';
import { LibraryLayout } from '../types';

interface HeaderProps {
    onToggleSidebar: () => void;
    title: string;
    search: string;
    onSearchChange: (value: string) => void;
    /** Artists/Albums grid<->list switch. Present only on those two views. */
    layoutToggle?: { value: LibraryLayout; onChange: (v: LibraryLayout) => void };
}

export const Header: React.FC<HeaderProps> = ({ onToggleSidebar, title, search, onSearchChange, layoutToggle }) => {
    const { t } = useTranslation();
    // On phone widths the search field crowds out the title, so it collapses to
    // a magnifier that expands the field on tap. Desktop CSS keeps it always-open
    // (the `.search-open` class and this state are inert there).
    const [searchOpen, setSearchOpen] = useState(false);
    const open = searchOpen || search.length > 0;
    const inputRef = useRef<HTMLInputElement>(null);

    // The input stays mounted (CSS toggles visibility), so `autoFocus` never
    // fires on expand — focus it explicitly instead.
    useEffect(() => {
        if (searchOpen) inputRef.current?.focus();
    }, [searchOpen]);

    const closeSearch = () => {
        setSearchOpen(false);
        onSearchChange('');
    };

    return (
        <header className={`header ${open ? 'search-open' : ''}`}>
            <div className="header-left">
                <button className="hamburger-btn" onClick={onToggleSidebar} aria-label={t('header.toggleSidebar')}>
                    <Icon name="menu" size={22} />
                </button>
                <div className="view-title">
                    {title}
                </div>
            </div>
            <div className="header-actions">
                {layoutToggle && (
                    <div className="layout-toggle" role="group" aria-label={t('header.layout')}>
                        <button
                            type="button"
                            className={`layout-toggle-btn ${layoutToggle.value === 'grid' ? 'active' : ''}`}
                            aria-label={t('header.gridView')}
                            aria-pressed={layoutToggle.value === 'grid'}
                            onClick={() => layoutToggle.onChange('grid')}
                        >
                            <Icon name="grid" size={16} />
                        </button>
                        <button
                            type="button"
                            className={`layout-toggle-btn ${layoutToggle.value === 'list' ? 'active' : ''}`}
                            aria-label={t('header.listView')}
                            aria-pressed={layoutToggle.value === 'list'}
                            onClick={() => layoutToggle.onChange('list')}
                        >
                            <Icon name="list" size={16} />
                        </button>
                    </div>
                )}
                <button
                    className="header-search-toggle"
                    aria-label={t('header.search')}
                    aria-expanded={open}
                    onClick={() => setSearchOpen(v => !v)}
                >
                    <Icon name="search" size={18} />
                </button>
                <div className="header-search">
                    <span className="search-icon"><Icon name="search" size={16} /></span>
                    <input
                        ref={inputRef}
                        id="global-search-input"
                        type="search"
                        placeholder={t('header.searchPlaceholder')}
                        aria-label={t('header.search')}
                        spellCheck={false}
                        value={search}
                        onChange={(e) => onSearchChange(e.target.value)}
                        onBlur={() => { if (!search) setSearchOpen(false); }}
                    />
                    {open && (
                        <button
                            className="header-search-clear"
                            aria-label={t('header.clearSearch')}
                            onClick={closeSearch}
                        >
                            <Icon name="x" size={14} />
                        </button>
                    )}
                </div>
            </div>
        </header>
    );
};
