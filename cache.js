import GLib from 'gi://GLib';

import {
    OWNER_ONLY_DIR_MODE,
    validateOwnerOnlyDirectory,
    validateOwnerOnlyFile,
    writePrivateJsonFile,
} from './fileSecurity.js';
import {isVendor} from './vendors.js';
import {
    UsageSources,
    dateTimeToIso8601,
    normalizeDateTime,
    usageStateFromJson,
    usageStateToJson,
} from './usageState.js';

export const CACHE_SCHEMA_VERSION = 1;
export const DEFAULT_CACHE_TTL_SECONDS = 300;

export const CacheReadStatus = Object.freeze({
    HIT: 'hit',
    MISS: 'miss',
    STALE: 'stale',
    INVALID_PERMISSIONS: 'invalid-permissions',
    MALFORMED: 'malformed',
    ERROR: 'error',
});

const CACHE_DIR_NAME = 'gnome-ai-usagebar';

export class UsageCache {
    constructor({
        cacheDir = null,
        ttlSeconds = DEFAULT_CACHE_TTL_SECONDS,
    } = {}) {
        this._cacheDir = cacheDir ?? GLib.build_filenamev([
            GLib.get_user_cache_dir(),
            CACHE_DIR_NAME,
        ]);
        this.ttlSeconds = ttlSeconds;
    }

    get cacheDir() {
        return this._cacheDir;
    }

    get ttlSeconds() {
        return this._ttlSeconds;
    }

    set ttlSeconds(value) {
        const ttlSeconds = Number(value);
        this._ttlSeconds = Number.isFinite(ttlSeconds) && ttlSeconds > 0
            ? Math.round(ttlSeconds)
            : DEFAULT_CACHE_TTL_SECONDS;
    }

    getCachePath(vendor) {
        this._assertVendor(vendor);

        return GLib.build_filenamev([
            this._cacheDir,
            `${vendor}.json`,
        ]);
    }

    read(vendor, {now = GLib.DateTime.new_now_utc()} = {}) {
        this._assertVendor(vendor);

        const path = this.getCachePath(vendor);
        if (!GLib.file_test(path, GLib.FileTest.EXISTS)) {
            return {
                status: CacheReadStatus.MISS,
                path,
                state: null,
            };
        }

        const permissionCheck = _validateOwnerOnlyFile(path);
        if (!permissionCheck.ok) {
            return {
                status: CacheReadStatus.INVALID_PERMISSIONS,
                path,
                state: null,
                message: permissionCheck.message,
            };
        }

        let payload;
        try {
            payload = _readJsonFile(path);
        } catch (error) {
            return {
                status: error instanceof SyntaxError
                    ? CacheReadStatus.MALFORMED
                    : CacheReadStatus.ERROR,
                path,
                state: null,
                message: error.message,
            };
        }

        let entry;
        try {
            entry = this._parsePayload(vendor, payload);
        } catch (error) {
            return {
                status: CacheReadStatus.MALFORMED,
                path,
                state: null,
                message: error.message,
            };
        }

        const ageSeconds = _ageSeconds(entry.cachedAt, now);

        return {
            status: ageSeconds <= this._ttlSeconds
                ? CacheReadStatus.HIT
                : CacheReadStatus.STALE,
            path,
            state: entry.state,
            cachedAt: entry.cachedAt,
            ageSeconds,
        };
    }

    write(vendor, state, {now = GLib.DateTime.new_now_utc()} = {}) {
        this._assertVendor(vendor);
        this._prepareCacheDir();

        const path = this.getCachePath(vendor);
        const payload = {
            schemaVersion: CACHE_SCHEMA_VERSION,
            vendor,
            cachedAt: dateTimeToIso8601(now),
            state: usageStateToJson(state),
        };

        writePrivateJsonFile(path, payload);

        return {path};
    }

    _parsePayload(vendor, payload) {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload))
            throw new Error('Cache payload must be an object');

        if (payload.schemaVersion !== CACHE_SCHEMA_VERSION)
            throw new Error(`Unsupported cache schema version: ${payload.schemaVersion}`);

        if (payload.vendor !== vendor)
            throw new Error(`Cache vendor mismatch: ${payload.vendor}`);

        return {
            cachedAt: normalizeDateTime(payload.cachedAt),
            state: usageStateFromJson(payload.state, UsageSources.CACHE),
        };
    }

    _prepareCacheDir() {
        if (!GLib.file_test(this._cacheDir, GLib.FileTest.EXISTS))
            GLib.mkdir_with_parents(this._cacheDir, OWNER_ONLY_DIR_MODE);

        const permissionCheck = _validateOwnerOnlyDirectory(this._cacheDir);
        if (!permissionCheck.ok)
            throw new Error(permissionCheck.message);
    }

    _assertVendor(vendor) {
        if (!isVendor(vendor))
            throw new Error(`Unsupported vendor: ${vendor}`);
    }
}

function _readJsonFile(path) {
    const [success, bytes] = GLib.file_get_contents(path);
    if (!success)
        throw new Error(`Unable to read cache file: ${path}`);

    return JSON.parse(new TextDecoder().decode(bytes));
}

function _validateOwnerOnlyFile(path) {
    return validateOwnerOnlyFile(path, {label: 'cache'});
}

function _validateOwnerOnlyDirectory(path) {
    return validateOwnerOnlyDirectory(path, {label: 'cache'});
}

function _ageSeconds(cachedAt, now) {
    const nowDateTime = normalizeDateTime(now);
    return Math.max(0, nowDateTime.to_unix() - cachedAt.to_unix());
}
