import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Portal } from './Modals';
import { Icon } from './Icon';
import { SmartCondition, SmartRules, SmartSortKey, Track } from '../types';
import { evaluateSmartPlaylist, DEFAULT_SMART_RULES } from '../smartPlaylist';
import { useModalKeys } from '../hooks/useModalKeys';

type FieldKind = 'text' | 'number' | 'date' | 'kind' | 'favorite' | 'play_state' | 'playlist';

// `labelKey` instead of a literal label: these are module-level constants
// (not components), so they can't call useTranslation() themselves — each
// render site below resolves the key via its own `t`.
const FIELD_OPTIONS = [
    { value: 'title', labelKey: 'smartPlaylist.fieldTitle', kind: 'text' },
    { value: 'artist', labelKey: 'smartPlaylist.fieldArtist', kind: 'text' },
    { value: 'album', labelKey: 'smartPlaylist.fieldAlbum', kind: 'text' },
    { value: 'album_artist', labelKey: 'smartPlaylist.fieldAlbumArtist', kind: 'text' },
    { value: 'genre', labelKey: 'smartPlaylist.fieldGenre', kind: 'text' },
    { value: 'composer', labelKey: 'smartPlaylist.fieldComposer', kind: 'text' },
    { value: 'play_count', labelKey: 'smartPlaylist.fieldPlayCount', kind: 'number' },
    { value: 'year', labelKey: 'smartPlaylist.fieldYear', kind: 'number' },
    { value: 'duration', labelKey: 'smartPlaylist.fieldDuration', kind: 'number' },
    { value: 'track_no', labelKey: 'smartPlaylist.fieldTrackNumber', kind: 'number' },
    { value: 'disc_no', labelKey: 'smartPlaylist.fieldDiscNumber', kind: 'number' },
    { value: 'added_at', labelKey: 'smartPlaylist.fieldDateAdded', kind: 'date' },
    { value: 'last_played', labelKey: 'smartPlaylist.fieldLastPlayed', kind: 'date' },
    { value: 'kind', labelKey: 'smartPlaylist.fieldKind', kind: 'kind' },
    { value: 'favorite', labelKey: 'smartPlaylist.fieldFavorite', kind: 'favorite' },
    { value: 'play_state', labelKey: 'smartPlaylist.fieldPlayState', kind: 'play_state' },
    { value: 'playlist', labelKey: 'smartPlaylist.fieldPlaylist', kind: 'playlist' },
] as const;
const FIELD_KIND: Record<string, FieldKind> = Object.fromEntries(FIELD_OPTIONS.map(f => [f.value, f.kind]));

const TEXT_OPS = [
    { value: 'contains', labelKey: 'smartPlaylist.opContains' },
    { value: 'not_contains', labelKey: 'smartPlaylist.opNotContains' },
    { value: 'is', labelKey: 'smartPlaylist.opIs' },
    { value: 'is_not', labelKey: 'smartPlaylist.opIsNot' },
    { value: 'starts_with', labelKey: 'smartPlaylist.opStartsWith' },
    { value: 'ends_with', labelKey: 'smartPlaylist.opEndsWith' },
] as const;
const NUMBER_OPS = [
    { value: 'eq', labelKey: 'smartPlaylist.opEq' },
    { value: 'ne', labelKey: 'smartPlaylist.opNe' },
    { value: 'gt', labelKey: 'smartPlaylist.opGt' },
    { value: 'lt', labelKey: 'smartPlaylist.opLt' },
    { value: 'between', labelKey: 'smartPlaylist.opBetween' },
] as const;
const DATE_OPS = [
    { value: 'in_last', labelKey: 'smartPlaylist.opInLast' },
    { value: 'not_in_last', labelKey: 'smartPlaylist.opNotInLast' },
] as const;
const IS_OPS = [
    { value: 'is', labelKey: 'smartPlaylist.opIs' },
    { value: 'is_not', labelKey: 'smartPlaylist.opIsNot' },
] as const;
const FAVORITE_OPS = [
    { value: 'is_true', labelKey: 'smartPlaylist.opIsTrue' },
    { value: 'is_false', labelKey: 'smartPlaylist.opIsFalse' },
] as const;
const PLAYLIST_OPS = [
    { value: 'in', labelKey: 'smartPlaylist.opIn' },
    { value: 'not_in', labelKey: 'smartPlaylist.opNotIn' },
] as const;
const UNITS = [
    { value: 'days', labelKey: 'smartPlaylist.unitDays' },
    { value: 'weeks', labelKey: 'smartPlaylist.unitWeeks' },
    { value: 'months', labelKey: 'smartPlaylist.unitMonths' },
] as const;
const KIND_VALUES = [
    { value: 'music', labelKey: 'smartPlaylist.kindMusic' },
    { value: 'podcast', labelKey: 'smartPlaylist.kindPodcast' },
    { value: 'other', labelKey: 'smartPlaylist.kindOther' },
] as const;
const PLAY_STATE_VALUES = [
    { value: 'unplayed', labelKey: 'smartPlaylist.playStateUnplayed' },
    { value: 'in_progress', labelKey: 'smartPlaylist.playStateInProgress' },
    { value: 'played', labelKey: 'smartPlaylist.playStatePlayed' },
] as const;
const SORT_OPTIONS = [
    { value: 'natural', labelKey: 'smartPlaylist.sortNatural' },
    { value: 'title', labelKey: 'smartPlaylist.sortTitle' },
    { value: 'artist', labelKey: 'smartPlaylist.sortArtist' },
    { value: 'album', labelKey: 'smartPlaylist.sortAlbum' },
    { value: 'play_count', labelKey: 'smartPlaylist.sortPlayCount' },
    { value: 'last_played', labelKey: 'smartPlaylist.sortLastPlayed' },
    { value: 'added_at', labelKey: 'smartPlaylist.sortDateAdded' },
    { value: 'year', labelKey: 'smartPlaylist.sortYear' },
] as const;

function defaultCondition(field: string, playlistOptions: { id: string; name: string }[]): SmartCondition {
    switch (FIELD_KIND[field]) {
        case 'text':
            return { field: field as any, op: 'contains', value: '' };
        case 'number':
            return { field: field as any, op: 'gt', value: 0 };
        case 'date':
            return { field: field as any, op: 'in_last', value: 7, unit: 'days' };
        case 'kind':
            return { field: 'kind', op: 'is', value: 'music' };
        case 'favorite':
            return { field: 'favorite', op: 'is_true' };
        case 'play_state':
            return { field: 'play_state', op: 'is', value: 'unplayed' };
        case 'playlist':
            return { field: 'playlist', op: 'in', value: playlistOptions[0]?.id ?? '' };
    }
}

interface SmartPlaylistModalProps {
    /** null when closed; { name, rules } for both create (empty rules) and edit. */
    editor: { name: string; rules: SmartRules } | null;
    allTracks: Track[];
    /** Every non-smart playlist, for the 'playlist' field's dropdown and preview. */
    playlistOptions: { id: string; name: string }[];
    membership: Map<string, Set<string>>;
    onClose: () => void;
    onSave: (name: string, rules: SmartRules) => Promise<void>;
}

export const SmartPlaylistModal: React.FC<SmartPlaylistModalProps> = ({
    editor,
    allTracks,
    playlistOptions,
    membership,
    onClose,
    onSave,
}) => {
    const { t } = useTranslation();
    const [name, setName] = useState('');
    const [rules, setRules] = useState<SmartRules>(DEFAULT_SMART_RULES);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [confirmDiscard, setConfirmDiscard] = useState(false);
    const nameInputRef = useRef<HTMLInputElement>(null);
    const initialRef = useRef<{ name: string; rules: SmartRules } | null>(null);

    useEffect(() => {
        if (!editor) return;
        setName(editor.name);
        setRules(editor.rules);
        initialRef.current = editor;
        setError(null);
        setConfirmDiscard(false);
    }, [editor]);

    useEffect(() => {
        if (editor) nameInputRef.current?.focus();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [!!editor]);

    const dirty = !!editor && (
        name !== initialRef.current?.name ||
        JSON.stringify(rules) !== JSON.stringify(initialRef.current?.rules)
    );

    const preview = useMemo(
        () => evaluateSmartPlaylist(rules, allTracks, membership, Date.now()),
        [rules, allTracks, membership]
    );

    const handleSave = async () => {
        if (!name.trim()) return;
        setSaving(true);
        setError(null);
        try {
            await onSave(name.trim(), rules);
            onClose();
        } catch (err) {
            console.error('Failed to save smart playlist:', err);
            setError(String(err instanceof Error ? err.message : err));
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

    useModalKeys({ enabled: !!editor, onEscape: requestClose, onSave: handleSave, canSave: dirty && !saving });

    if (!editor) return null;

    const updateCondition = (i: number, next: SmartCondition) => {
        setRules(r => ({ ...r, conditions: r.conditions.map((c, idx) => (idx === i ? next : c)) }));
    };
    const removeCondition = (i: number) => {
        setRules(r => ({ ...r, conditions: r.conditions.filter((_, idx) => idx !== i) }));
    };
    const addCondition = () => {
        setRules(r => ({ ...r, conditions: [...r.conditions, defaultCondition('title', playlistOptions)] }));
    };

    return (
        <Portal><div className="modal-overlay" onClick={requestClose}>
            <div className="modal-content info-modal smart-playlist-modal" onClick={e => e.stopPropagation()}>
                <div className="info-modal-header">
                    <div className="info-modal-header-text">
                        <input
                            ref={nameInputRef}
                            type="text"
                            className="modal-input"
                            value={name}
                            onChange={e => setName(e.target.value)}
                            placeholder={t('smartPlaylist.namePlaceholder')}
                        />
                    </div>
                </div>

                <div className="info-modal-body">
                    <div className="smart-rules-match">
                        {t('smartPlaylist.match')}
                        <select
                            className="settings-folder-kind"
                            value={rules.match}
                            onChange={e => setRules(r => ({ ...r, match: e.target.value as 'all' | 'any' }))}
                        >
                            <option value="all">{t('smartPlaylist.matchAll')}</option>
                            <option value="any">{t('smartPlaylist.matchAny')}</option>
                        </select>
                        {t('smartPlaylist.ofTheFollowingRules')}
                    </div>

                    <div className="smart-rules-list">
                        {rules.conditions.map((cond, i) => (
                            <SmartConditionRow
                                key={i}
                                condition={cond}
                                playlistOptions={playlistOptions}
                                onChange={next => updateCondition(i, next)}
                                onRemove={() => removeCondition(i)}
                            />
                        ))}
                        {rules.conditions.length === 0 && (
                            <p className="settings-hint">{t('smartPlaylist.noRules')}</p>
                        )}
                    </div>

                    <button type="button" className="modal-btn cancel smart-rules-add" onClick={addCondition}>
                        <Icon name="plus" size={14} /> {t('smartPlaylist.addRule')}
                    </button>

                    <div className="smart-rules-options">
                        <label className="smart-rules-limit">
                            <input
                                type="checkbox"
                                checked={rules.limit != null}
                                onChange={e => setRules(r => ({ ...r, limit: e.target.checked ? 25 : null }))}
                            />
                            {t('smartPlaylist.limitTo')}
                            <input
                                type="number"
                                min={1}
                                className="modal-input smart-rules-limit-input"
                                disabled={rules.limit == null}
                                value={rules.limit ?? 25}
                                onChange={e => setRules(r => ({ ...r, limit: Math.max(1, Number(e.target.value) || 1) }))}
                            />
                            {t('smartPlaylist.items')}
                        </label>
                        <label className="smart-rules-sort">
                            {t('smartPlaylist.sortBy')}
                            <select
                                className="settings-folder-kind"
                                value={rules.sortBy}
                                onChange={e => setRules(r => ({ ...r, sortBy: e.target.value as SmartSortKey }))}
                            >
                                {SORT_OPTIONS.map(o => <option key={o.value} value={o.value}>{t(o.labelKey)}</option>)}
                            </select>
                            <select
                                className="settings-folder-kind"
                                value={rules.sortDesc ? 'desc' : 'asc'}
                                onChange={e => setRules(r => ({ ...r, sortDesc: e.target.value === 'desc' }))}
                            >
                                <option value="asc">{t('smartPlaylist.ascending')}</option>
                                <option value="desc">{t('smartPlaylist.descending')}</option>
                            </select>
                        </label>
                    </div>

                    <p className="settings-hint smart-rules-preview">
                        {t('smartPlaylist.songsMatch', { count: preview.length })}
                    </p>
                </div>

                {error && <div className="error-banner info-modal-error">{error}</div>}

                <div className="info-modal-footer">
                    {confirmDiscard ? (
                        <div className="info-modal-confirm-discard">
                            <span>{t('smartPlaylist.unsavedChanges')}</span>
                            <div className="info-modal-confirm-actions">
                                <button type="button" className="modal-btn" onClick={() => setConfirmDiscard(false)}>{t('smartPlaylist.keepEditing')}</button>
                                <button type="button" className="modal-btn cancel" onClick={onClose}>{t('smartPlaylist.discard')}</button>
                            </div>
                        </div>
                    ) : (
                        <div className="modal-actions info-modal-footer-actions" style={{ width: '100%', justifyContent: 'flex-end' }}>
                            <button type="button" className="modal-btn cancel" onClick={requestClose}>{t('smartPlaylist.cancel')}</button>
                            <button type="button" className="modal-btn confirm" disabled={!name.trim() || saving} onClick={handleSave}>
                                {saving ? t('smartPlaylist.saving') : t('smartPlaylist.save')}
                            </button>
                        </div>
                    )}
                </div>
            </div>
        </div></Portal>
    );
};

const MINUTE = 60;

interface SmartConditionRowProps {
    condition: SmartCondition;
    playlistOptions: { id: string; name: string }[];
    onChange: (next: SmartCondition) => void;
    onRemove: () => void;
}

const SmartConditionRow: React.FC<SmartConditionRowProps> = ({ condition, playlistOptions, onChange, onRemove }) => {
    const { t } = useTranslation();
    const kind = FIELD_KIND[condition.field] ?? 'text';
    const isDuration = condition.field === 'duration';

    const handleFieldChange = (field: string) => {
        onChange(defaultCondition(field, playlistOptions));
    };

    return (
        <div className="smart-rule-row">
            <select className="settings-folder-kind" value={condition.field} onChange={e => handleFieldChange(e.target.value)}>
                {FIELD_OPTIONS.map(f => <option key={f.value} value={f.value}>{t(f.labelKey)}</option>)}
            </select>

            {kind === 'text' && (
                <>
                    <select
                        className="settings-folder-kind"
                        value={condition.op}
                        onChange={e => onChange({ ...condition, op: e.target.value } as SmartCondition)}
                    >
                        {TEXT_OPS.map(o => <option key={o.value} value={o.value}>{t(o.labelKey)}</option>)}
                    </select>
                    <input
                        type="text"
                        className="modal-input smart-rule-value"
                        value={(condition as any).value}
                        onChange={e => onChange({ ...condition, value: e.target.value } as SmartCondition)}
                    />
                </>
            )}

            {kind === 'number' && (
                <>
                    <select
                        className="settings-folder-kind"
                        value={condition.op}
                        onChange={e => onChange({ ...condition, op: e.target.value } as SmartCondition)}
                    >
                        {NUMBER_OPS.map(o => <option key={o.value} value={o.value}>{t(o.labelKey)}</option>)}
                    </select>
                    <input
                        type="number"
                        className="modal-input smart-rule-value"
                        value={isDuration ? (condition as any).value / MINUTE : (condition as any).value}
                        onChange={e => onChange({
                            ...condition,
                            value: isDuration ? Number(e.target.value) * MINUTE : Number(e.target.value),
                        } as SmartCondition)}
                    />
                    {condition.op === 'between' && (
                        <>
                            {t('smartPlaylist.and')}
                            <input
                                type="number"
                                className="modal-input smart-rule-value"
                                value={isDuration ? ((condition as any).value2 ?? 0) / MINUTE : ((condition as any).value2 ?? 0)}
                                onChange={e => onChange({
                                    ...condition,
                                    value2: isDuration ? Number(e.target.value) * MINUTE : Number(e.target.value),
                                } as SmartCondition)}
                            />
                        </>
                    )}
                </>
            )}

            {kind === 'date' && (
                <>
                    <select
                        className="settings-folder-kind"
                        value={condition.op}
                        onChange={e => onChange({ ...condition, op: e.target.value } as SmartCondition)}
                    >
                        {DATE_OPS.map(o => <option key={o.value} value={o.value}>{t(o.labelKey)}</option>)}
                    </select>
                    <input
                        type="number"
                        min={1}
                        className="modal-input smart-rule-value"
                        value={(condition as any).value}
                        onChange={e => onChange({ ...condition, value: Math.max(1, Number(e.target.value) || 1) } as SmartCondition)}
                    />
                    <select
                        className="settings-folder-kind"
                        value={(condition as any).unit}
                        onChange={e => onChange({ ...condition, unit: e.target.value } as SmartCondition)}
                    >
                        {UNITS.map(u => <option key={u.value} value={u.value}>{t(u.labelKey)}</option>)}
                    </select>
                </>
            )}

            {kind === 'kind' && (
                <>
                    <select className="settings-folder-kind" value={condition.op} onChange={e => onChange({ ...condition, op: e.target.value } as SmartCondition)}>
                        {IS_OPS.map(o => <option key={o.value} value={o.value}>{t(o.labelKey)}</option>)}
                    </select>
                    <select className="settings-folder-kind" value={(condition as any).value} onChange={e => onChange({ ...condition, value: e.target.value } as SmartCondition)}>
                        {KIND_VALUES.map(o => <option key={o.value} value={o.value}>{t(o.labelKey)}</option>)}
                    </select>
                </>
            )}

            {kind === 'favorite' && (
                <select className="settings-folder-kind" value={condition.op} onChange={e => onChange({ ...condition, op: e.target.value } as SmartCondition)}>
                    {FAVORITE_OPS.map(o => <option key={o.value} value={o.value}>{t(o.labelKey)}</option>)}
                </select>
            )}

            {kind === 'play_state' && (
                <>
                    <select className="settings-folder-kind" value={condition.op} onChange={e => onChange({ ...condition, op: e.target.value } as SmartCondition)}>
                        {IS_OPS.map(o => <option key={o.value} value={o.value}>{t(o.labelKey)}</option>)}
                    </select>
                    <select className="settings-folder-kind" value={(condition as any).value} onChange={e => onChange({ ...condition, value: e.target.value } as SmartCondition)}>
                        {PLAY_STATE_VALUES.map(o => <option key={o.value} value={o.value}>{t(o.labelKey)}</option>)}
                    </select>
                </>
            )}

            {kind === 'playlist' && (
                <>
                    <select className="settings-folder-kind" value={condition.op} onChange={e => onChange({ ...condition, op: e.target.value } as SmartCondition)}>
                        {PLAYLIST_OPS.map(o => <option key={o.value} value={o.value}>{t(o.labelKey)}</option>)}
                    </select>
                    <select className="settings-folder-kind" value={(condition as any).value} onChange={e => onChange({ ...condition, value: e.target.value } as SmartCondition)}>
                        {playlistOptions.length === 0 && <option value="">{t('smartPlaylist.noOtherPlaylists')}</option>}
                        {playlistOptions.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                </>
            )}

            <button type="button" className="smart-rule-remove" aria-label={t('smartPlaylist.removeRule')} onClick={onRemove}>
                <Icon name="x" size={14} />
            </button>
        </div>
    );
};
