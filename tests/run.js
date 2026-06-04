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
import {
    anthropicPlanLabel,
    buildAnthropicUsageDisplay,
    buildOpenAIUsageDisplay,
    decodeJwtPayload,
    openAIPlanHintFromToken,
    summarizeAnthropicUsage,
    summarizeOpenAIUsage,
} from '../vendorUsage.js';

const tests = [];

test('usage state validates status values', () => {
    assertThrows(() => createUsageState({status: 'unknown'}), 'Unsupported usage status');
});

test('usage state round trips through cache json', () => {
    const updatedAt = GLib.DateTime.new_from_iso8601('2026-06-04T12:00:00Z', null);
    const state = createUsageState({
        status: UsageStatus.READY,
        summary: '5h 10m remaining',
        plan: 'ChatGPT Plus',
        metrics: [
            {
                label: '5h session',
                value: '40%',
                detail: 'Resets in 2h',
                percent: 40,
            },
        ],
        updatedAt,
    });

    const restored = usageStateFromJson(usageStateToJson(state), UsageSources.CACHE);

    assertEqual(restored.status, UsageStatus.READY);
    assertEqual(restored.statusLabel, 'OK');
    assertEqual(restored.summary, '5h 10m remaining');
    assertEqual(restored.plan, 'ChatGPT Plus');
    assertEqual(restored.metrics.length, 1);
    assertEqual(restored.metrics[0].label, '5h session');
    assertEqual(restored.metrics[0].percent, 40);
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

test('anthropic usage summary includes plan windows and extra usage', () => {
    const summary = summarizeAnthropicUsage({
        five_hour: {utilization: 42.7},
        seven_day: {utilization: 27},
        seven_day_sonnet: {utilization: 4.2},
        extra_usage: {
            is_enabled: true,
            monthly_limit: 5000,
            used_credits: 250,
        },
    }, {
        subscriptionType: 'max',
        rateLimitTier: 'default_claude_max_5x',
    });

    assertEqual(summary, 'Max 5x: 43% 5h, 27% weekly, 4% Sonnet, extra $2.50 / $50.00');
});

test('anthropic usage display returns structured metrics', () => {
    const now = GLib.DateTime.new_from_iso8601('2026-06-04T12:00:00Z', null);
    const display = buildAnthropicUsageDisplay({
        five_hour: {
            utilization: 42.7,
            resets_at: '2026-06-04T14:30:00Z',
        },
        seven_day: {utilization: 27},
    }, {
        subscriptionType: 'max',
        rateLimitTier: 'default_claude_max_5x',
    }, {now});

    assertEqual(display.plan, 'Max 5x');
    assertEqual(display.metrics.length, 2);
    assertEqual(display.metrics[0].label, '5h session');
    assertEqual(display.metrics[0].value, '43%');
    assertEqual(display.metrics[0].percent, 43);
    assertEqual(display.metrics[0].detail, 'Resets in 2h 30m');
});

test('anthropic plan label handles max tier names', () => {
    assertEqual(anthropicPlanLabel({
        subscriptionType: 'max',
        rateLimitTier: 'default_claude_max_20x',
    }), 'Max 20x');
});

test('openai usage summary includes plan windows and credits', () => {
    const summary = summarizeOpenAIUsage({
        plan_type: 'plus',
        rate_limit: {
            primary_window: {used_percent: 1},
            secondary_window: {used_percent: 0},
        },
        code_review_rate_limit: {
            primary_window: {used_percent: 33},
        },
        credits: {
            balance: 1.5,
            unlimited: false,
        },
    });

    assertEqual(summary, 'ChatGPT Plus: 1% 5h, 0% weekly, 33% code review, credits $1.50');
});

test('openai usage display returns structured metrics', () => {
    const now = GLib.DateTime.new_from_iso8601('2026-06-04T12:00:00Z', null);
    const display = buildOpenAIUsageDisplay({
        plan_type: 'plus',
        rate_limit: {
            primary_window: {
                used_percent: 1,
                reset_after_seconds: 1800,
            },
            secondary_window: {used_percent: 0},
        },
        credits: {
            balance: '$2.50',
            unlimited: false,
            approx_local_messages: [100, 200],
        },
    }, {now});

    assertEqual(display.plan, 'ChatGPT Plus');
    assertEqual(display.metrics.length, 3);
    assertEqual(display.metrics[0].label, '5h session');
    assertEqual(display.metrics[0].detail, 'Resets in 30m');
    assertEqual(display.metrics[2].label, 'Credits');
    assertEqual(display.metrics[2].detail, '100-200 local');
});

test('openai plan hint is decoded from id token', () => {
    const token = fakeJwt({
        exp: 1780597324,
        'https://api.openai.com/auth': {
            chatgpt_plan_type: 'team',
        },
    });

    assertEqual(decodeJwtPayload(token).exp, 1780597324);
    assertEqual(openAIPlanHintFromToken(token), 'team');
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

function fakeJwt(claims) {
    return [
        base64UrlEncode('{"alg":"none","typ":"JWT"}'),
        base64UrlEncode(JSON.stringify(claims)),
        'sig',
    ].join('.');
}

function base64UrlEncode(text) {
    return GLib.base64_encode(new TextEncoder().encode(text))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
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
