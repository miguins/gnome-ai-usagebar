import GLib from 'gi://GLib';

import {
    assertEqual,
    assertThrows,
    getMode,
    makeTempDir,
    removeTree,
    test,
} from './harness.js';
import {CacheReadStatus, UsageCache} from '../lib/cache.js';
import {UsageStatus, createUsageState} from '../lib/usageState.js';
import {Vendors} from '../lib/vendors.js';

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
