/** Name of the custom slot type the Alexa skill's interaction model declares
 *  for the playlist name (alexa-skill/skill-package/.../ja-JP.json). */
export const PLAYLIST_SLOT_TYPE = "PLAYLIST";

/** The `types` entry that teaches Alexa this library's playlist names, so it
 *  hears "ヒロト＆マーシー" instead of guessing kanji ("廣戸麻生"). Pasted into the
 *  skill's interaction model by hand; synonyms (a kana reading for an English
 *  name, say) are added there. Alexa rejects empty and over-long values and
 *  duplicates, so those are dropped here. */
export function playlistSlotType(names: string[]): { name: string; values: { name: { value: string } }[] } {
    const seen = new Set<string>();
    const values: { name: { value: string } }[] = [];
    for (const raw of names) {
        const value = raw.trim();
        if (!value || value.length > 140 || seen.has(value)) continue;
        seen.add(value);
        values.push({ name: { value } });
    }
    return { name: PLAYLIST_SLOT_TYPE, values };
}
