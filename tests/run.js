import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

import {
    UsageSources,
    UsageStatus,
    createUsageState,
    usageStateFromJson,
    usageStateToJson,
} from '../usageState.js';
import {CacheReadStatus, UsageCache} from '../cache.js';
import {Vendors} from '../vendors.js';

const tests = [];

test('usage state validates status values', () => {
    assertThrows(() => createUsageState({status: 'unknown'}), 'Unsupported usage status');
});

test('usage state round trips through cache json', () => {
    const updatedAt = GLib.DateTime.new_from_iso8601('2026-06-04T12:00:00Z', null);
    const state = createUsageState({
        status: UsageStatus.READY,
        summary: '5h 10m remaining',
        updatedAt,
    });

    const restored = usageStateFromJson(usageStateToJson(state), UsageSources.CACHE);

    assertEqual(restored.status, UsageStatus.READY);
    assertEqual(restored.statusLabel, 'OK');
    assertEqual(restored.summary, '5h 10m remaining');
    assertEqual(restored.source, UsageSources.CACHE);
    assertEqual(restored.updatedAt.to_unix(), updatedAt.to_unix());
});

test('cache writes owner-only files and reads fresh entries', () => {
    const cacheDir = makeTempDir();
    const now = GLib.DateTime.new_from_iso8601('2026-06-04T12:00:00Z', null);

    try {
        const cache = new UsageCache({cacheDir, ttlSeconds: 300});
        const state = createUsageState({
            status: UsageStatus.READY,
            summary: '80% weekly limit remaining',
            updatedAt: now,
        });

        cache.write(Vendors.OPENAI, state, {now});
        const result = cache.read(Vendors.OPENAI, {now});

        assertEqual(result.status, CacheReadStatus.HIT);
        assertEqual(result.state.status, UsageStatus.READY);
        assertEqual(result.state.summary, '80% weekly limit remaining');
        assertEqual(getMode(cacheDir), 0o700);
        assertEqual(getMode(cache.getCachePath(Vendors.OPENAI)), 0o600);
    } finally {
        removeTree(cacheDir);
    }
});

test('cache returns stale when entry exceeds ttl', () => {
    const cacheDir = makeTempDir();
    const cachedAt = GLib.DateTime.new_from_iso8601('2026-06-04T12:00:00Z', null);
    const now = GLib.DateTime.new_from_iso8601('2026-06-04T12:10:01Z', null);

    try {
        const cache = new UsageCache({cacheDir, ttlSeconds: 300});
        cache.write(Vendors.ANTHROPIC, createUsageState({
            status: UsageStatus.READY,
            summary: '2h session remaining',
            updatedAt: cachedAt,
        }), {now: cachedAt});

        const result = cache.read(Vendors.ANTHROPIC, {now});

        assertEqual(result.status, CacheReadStatus.STALE);
        assertEqual(result.ageSeconds, 601);
    } finally {
        removeTree(cacheDir);
    }
});

test('cache refuses unsafe file permissions', () => {
    const cacheDir = makeTempDir();
    const now = GLib.DateTime.new_from_iso8601('2026-06-04T12:00:00Z', null);

    try {
        const cache = new UsageCache({cacheDir, ttlSeconds: 300});
        cache.write(Vendors.OPENAI, createUsageState({
            status: UsageStatus.READY,
            summary: 'Cached summary',
            updatedAt: now,
        }), {now});

        GLib.chmod(cache.getCachePath(Vendors.OPENAI), 0o644);

        const result = cache.read(Vendors.OPENAI, {now});

        assertEqual(result.status, CacheReadStatus.INVALID_PERMISSIONS);
        assertEqual(result.state, null);
    } finally {
        removeTree(cacheDir);
    }
});

test('cache reports malformed json without throwing', () => {
    const cacheDir = makeTempDir();
    const cache = new UsageCache({cacheDir});

    try {
        GLib.mkdir_with_parents(cacheDir, 0o700);
        const path = cache.getCachePath(Vendors.OPENAI);
        GLib.file_set_contents(path, '{');
        GLib.chmod(path, 0o600);

        const result = cache.read(Vendors.OPENAI);

        assertEqual(result.status, CacheReadStatus.MALFORMED);
        assertEqual(result.state, null);
    } finally {
        removeTree(cacheDir);
    }
});

test('cache reports invalid payload shape as malformed', () => {
    const cacheDir = makeTempDir();
    const cache = new UsageCache({cacheDir});

    try {
        GLib.mkdir_with_parents(cacheDir, 0o700);
        const path = cache.getCachePath(Vendors.OPENAI);
        GLib.file_set_contents(path, JSON.stringify({
            schemaVersion: 999,
            vendor: Vendors.OPENAI,
            cachedAt: '2026-06-04T12:00:00Z',
            state: {
                status: UsageStatus.READY,
                summary: 'Cached summary',
                updatedAt: '2026-06-04T12:00:00Z',
            },
        }));
        GLib.chmod(path, 0o600);

        const result = cache.read(Vendors.OPENAI);

        assertEqual(result.status, CacheReadStatus.MALFORMED);
        assertEqual(result.state, null);
    } finally {
        removeTree(cacheDir);
    }
});

test('cache refuses unsafe directory permissions on write', () => {
    const cacheDir = makeTempDir();
    const now = GLib.DateTime.new_from_iso8601('2026-06-04T12:00:00Z', null);

    try {
        GLib.chmod(cacheDir, 0o755);

        const cache = new UsageCache({cacheDir});
        const state = createUsageState({
            status: UsageStatus.READY,
            summary: 'Cached summary',
            updatedAt: now,
        });

        assertThrows(
            () => cache.write(Vendors.OPENAI, state, {now}),
            'Unsafe cache permissions'
        );
    } finally {
        GLib.chmod(cacheDir, 0o700);
        removeTree(cacheDir);
    }
});

let failures = 0;

for (const {name, callback} of tests) {
    try {
        callback();
        print(`ok - ${name}`);
    } catch (error) {
        failures += 1;
        printerr(`not ok - ${name}`);
        printerr(error.stack ?? error.message);
    }
}

System.exit(failures === 0 ? 0 : 1);

function test(name, callback) {
    tests.push({name, callback});
}

function assertEqual(actual, expected) {
    if (actual !== expected)
        throw new Error(`Expected ${expected}, got ${actual}`);
}

function assertThrows(callback, expectedMessage) {
    try {
        callback();
    } catch (error) {
        if (!error.message.includes(expectedMessage)) {
            throw new Error(
                `Expected error containing "${expectedMessage}", got "${error.message}"`
            );
        }

        return;
    }

    throw new Error(`Expected error containing "${expectedMessage}"`);
}

function makeTempDir() {
    const path = GLib.build_filenamev([
        GLib.get_tmp_dir(),
        `gnome-ai-usagebar-test-${GLib.uuid_string_random()}`,
    ]);
    GLib.mkdir_with_parents(path, 0o700);
    return path;
}

function getMode(path) {
    const file = Gio.File.new_for_path(path);
    const info = file.query_info(
        'unix::mode',
        Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
        null
    );

    return info.get_attribute_uint32('unix::mode') & 0o777;
}

function removeTree(path) {
    const file = Gio.File.new_for_path(path);

    try {
        const info = file.query_info(
            'standard::type',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            null
        );

        if (info.get_file_type() === Gio.FileType.DIRECTORY) {
            const enumerator = file.enumerate_children(
                'standard::name',
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
                null
            );

            let childInfo;
            while ((childInfo = enumerator.next_file(null)) !== null) {
                removeTree(GLib.build_filenamev([
                    path,
                    childInfo.get_name(),
                ]));
            }

            enumerator.close(null);
        }

        file.delete(null);
    } catch (error) {
        if (!error.matches || !error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            throw error;
    }
}
