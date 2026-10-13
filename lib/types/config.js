/**
 * Deployment policy for the `/rename` command.
 *
 * Every tunable has a validated default so the bundle patch can stay minimal;
 * a profile overlay may override any field through the plugin row's `config`.
 * @module dsh-rename/config
 */
import z from '@deepseek-ai/schemastery';
import { deepFreeze } from '@deepseek-ai/dsh-util-values';
/** Loader schema with library-owned defaults; no field is required. */
export const ConfigSchema = z.object({
    targetWords: z.natural().min(1).max(20).default(6),
    targetCjkCharacters: z.natural().min(1).max(40).default(12),
    maxInputBytes: z.natural().min(512).max(262144).default(32768),
    maxOutputTokens: z.natural().min(8).max(512).default(64),
    maxTitleBytes: z.natural().min(1).max(256).default(80),
    timeoutMs: z.natural().min(1000).max(300000).default(60000),
    provider: z.string(),
    model: z.string(),
});
const CONFIG_KEYS = new Set([
    'targetWords',
    'targetCjkCharacters',
    'maxInputBytes',
    'maxOutputTokens',
    'maxTitleBytes',
    'timeoutMs',
    'provider',
    'model',
]);
const DEFAULTS = {
    targetWords: 6,
    targetCjkCharacters: 12,
    maxInputBytes: 32768,
    maxOutputTokens: 64,
    maxTitleBytes: 80,
    timeoutMs: 60000,
};
/** Reject a non-positive integer policy field. */
function assertPositiveInteger(key, value) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`dsh-rename: ${key} must be a positive integer`);
    }
}
/** Reject an explicitly supplied route field that is not a non-empty string. */
function assertNonEmptyString(key, value) {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`dsh-rename: ${key} must be a non-empty string when supplied`);
    }
}
/**
 * Validate and detach one plugin configuration into immutable policy.
 *
 * The Loader already applies the exported schema defaults before `apply`;
 * this pass still runs so a direct `ctx.plugin(dshRename, config)` call gets
 * identical behavior and cannot smuggle unknown keys past the public entry.
 * @param input - untrusted plugin configuration, possibly undefined.
 * @returns frozen resolved policy with every default materialized.
 */
export function resolveConfig(input) {
    if (input === undefined)
        return deepFreeze({ ...DEFAULTS });
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        throw new Error('dsh-rename: configuration must be a plain object when supplied');
    }
    const value = input;
    for (const key of Object.keys(value)) {
        if (!CONFIG_KEYS.has(key))
            throw new Error(`dsh-rename: unknown config key "${key}"`);
    }
    const hasProvider = value['provider'] !== undefined;
    const hasModel = value['model'] !== undefined;
    if (hasProvider !== hasModel) {
        throw new Error('dsh-rename: provider and model must be supplied together');
    }
    if (hasProvider) {
        assertNonEmptyString('provider', value['provider']);
        assertNonEmptyString('model', value['model']);
    }
    const resolved = { ...DEFAULTS };
    for (const key of Object.keys(DEFAULTS)) {
        const supplied = value[key];
        if (supplied === undefined)
            continue;
        assertPositiveInteger(key, supplied);
        resolved[key] = supplied;
    }
    if (hasProvider) {
        resolved['provider'] = value['provider'];
        resolved['model'] = value['model'];
    }
    return deepFreeze(resolved);
}
//# sourceMappingURL=config.js.map