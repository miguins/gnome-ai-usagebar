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
import {
    SecretCredentialErrorReason,
    SecretCredentialStore,
    secretCredentialAttributes,
} from '../credentialStore.js';
import {
    credentialPath,
    expandCredentialPath,
} from '../vendorCredentials.js';
import {
    Vendors,
    getDefaultCredentialPath,
    normalizeCredentialPathSetting,
} from '../vendors.js';
import {
    anthropicPlanLabel,
    buildAnthropicUsageDisplay,
    buildOpenAIUsageDisplay,
    decodeJwtPayload,
    openAIPlanHintFromToken,
    refreshVendorUsage,
    summarizeAnthropicUsage,
    summarizeOpenAIUsage,
} from '../vendorUsage.js';
import {
    createHttpSession,
    httpStatusError,
    resolveProxyUrl,
} from '../vendorHttp.js';
import {formatLocalTime} from '../vendorFormat.js';
import {
    UsageThresholdDefinitions,
    UsageThresholdIds,
    highestUsageThreshold,
    usageThresholdForPercent,
} from '../usageThresholds.js';

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
                kind: 'current-session',
                label: 'Current session (5h)',
                value: '40%',
                detail: 'Resets in 2h',
                percent: 40,
                resetIn: '2h',
                resetAt: '2026-06-04T14:00:00Z',
                resetAtLabel: 'resets 11:00',
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
    assertEqual(restored.metrics[0].kind, 'current-session');
    assertEqual(restored.metrics[0].label, 'Current session (5h)');
    assertEqual(restored.metrics[0].percent, 40);
    assertEqual(restored.metrics[0].resetIn, '2h');
    assertEqual(restored.metrics[0].resetAt, '2026-06-04T14:00:00Z');
    assertEqual(restored.metrics[0].resetAtLabel, 'resets 11:00');
    assertEqual(restored.source, UsageSources.CACHE);
    assertEqual(restored.updatedAt.to_unix(), updatedAt.to_unix());
});

test('local time formatter uses the system timezone offset', () => {
    const previousTimezone = GLib.getenv('TZ');
    GLib.setenv('TZ', 'Etc/GMT+3', true);

    try {
        const updatedAt = GLib.DateTime.new_from_iso8601('2026-06-05T02:50:00Z', null);

        assertEqual(updatedAt.format('%H:%M:%S'), '02:50:00');
        assertEqual(formatLocalTime(updatedAt), '23:50:00');
    } finally {
        if (previousTimezone === null)
            GLib.unsetenv('TZ');
        else
            GLib.setenv('TZ', previousTimezone, true);
    }
});

test('usage thresholds resolve the highest enabled matching threshold', () => {
    const thresholds = UsageThresholdDefinitions.map(definition => ({
        ...definition,
        enabled: definition.id !== UsageThresholdIds.ALERT,
        percent: definition.defaultPercent,
    }));

    assertEqual(usageThresholdForPercent(49, thresholds), null);
    assertEqual(usageThresholdForPercent(50, thresholds).id, UsageThresholdIds.WARNING);
    assertEqual(usageThresholdForPercent(80, thresholds).id, UsageThresholdIds.WARNING);
    assertEqual(usageThresholdForPercent(90, thresholds).id, UsageThresholdIds.CRITICAL);
    assertEqual(usageThresholdForPercent(95, thresholds).id, UsageThresholdIds.CRITICAL_HIGH);
    assertEqual(usageThresholdForPercent(100, thresholds).id, UsageThresholdIds.EXHAUSTED);
});

test('usage thresholds choose the highest metric severity', () => {
    const thresholds = UsageThresholdDefinitions.map(definition => ({
        ...definition,
        enabled: true,
        percent: definition.defaultPercent,
    }));
    const selected = highestUsageThreshold([
        {label: 'Current session (5h)', percent: 52},
        {label: 'Weekly', percent: 91},
        {label: 'Code review', percent: 79},
    ], thresholds);

    assertEqual(selected.id, UsageThresholdIds.CRITICAL);
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

test('anthropic usage summary includes plan windows, model windows, and extra usage', () => {
    const summary = summarizeAnthropicUsage({
        five_hour: {utilization: 42.7},
        seven_day: {utilization: 27},
        seven_day_sonnet: null,
        seven_day_fable: null,
        seven_day_opus: null,
        limits: [
            {kind: 'session', group: 'session', percent: 43},
            {kind: 'weekly_all', group: 'weekly', percent: 27},
            {
                kind: 'weekly_scoped',
                group: 'weekly',
                percent: 4.2,
                scope: {model: {id: null, display_name: 'Sonnet'}},
            },
            {
                kind: 'weekly_scoped',
                group: 'weekly',
                percent: 12.6,
                scope: {model: {id: null, display_name: 'Fable'}},
            },
        ],
        extra_usage: {
            is_enabled: true,
            monthly_limit: 5000,
            used_credits: 250,
        },
    }, {
        subscriptionType: 'max',
        rateLimitTier: 'default_claude_max_5x',
    });

    assertEqual(
        summary,
        'Max 5x: 43% 5h, 27% weekly, 4% Sonnet, 13% Fable, extra $2.50 / $50.00'
    );
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
    assertEqual(display.metrics[0].kind, 'current-session');
    assertEqual(display.metrics[0].label, 'Current session (5h)');
    assertEqual(display.metrics[0].value, '43%');
    assertEqual(display.metrics[0].percent, 43);
    assertEqual(display.metrics[0].resetIn, '2h 30m');
    assertEqual(
        display.metrics[0].detail,
        `Resets in 2h 30m (${expectedResetAtLabel(display.metrics[0].resetAt, now)})`
    );
});

test('anthropic usage display returns dynamic model weekly metrics', () => {
    const now = GLib.DateTime.new_from_iso8601('2026-06-04T12:00:00Z', null);
    const display = buildAnthropicUsageDisplay({
        five_hour: {utilization: 10},
        seven_day: {utilization: 20},
        seven_day_fable: null,
        seven_day_opus: null,
        limits: [
            {kind: 'session', group: 'session', percent: 10},
            {kind: 'weekly_all', group: 'weekly', percent: 20},
            {
                kind: 'weekly_scoped',
                group: 'weekly',
                percent: 33.3,
                resets_at: '2026-06-05T12:00:00Z',
                scope: {model: {id: null, display_name: 'Fable'}},
            },
            {
                kind: 'weekly_scoped',
                group: 'weekly',
                percent: 44.4,
                scope: {model: {id: null, display_name: 'Mythos Long Context'}},
            },
            {label: 'not a usage window'},
            {
                kind: 'weekly_scoped',
                group: 'weekly',
                percent: 1,
                scope: {model: null},
            },
            null,
        ],
    }, {}, {now});

    assertEqual(
        display.summary,
        'Unknown: 10% 5h, 20% weekly, 33% Fable, 44% Mythos Long Context'
    );
    assertEqual(display.metrics.length, 4);
    assertEqual(display.metrics[2].kind, 'model-weekly');
    assertEqual(display.metrics[2].label, 'Fable weekly');
    assertEqual(display.metrics[2].value, '33%');
    assertEqual(display.metrics[2].percent, 33);
    assertEqual(display.metrics[2].resetIn, '1d');
    assertEqual(display.metrics[3].label, 'Mythos Long Context weekly');
});

test('anthropic plan label handles max tier names', () => {
    assertEqual(anthropicPlanLabel({
        subscriptionType: 'max',
        rateLimitTier: 'default_claude_max_20x',
    }), 'Max 20x');
});

test('anthropic usage display rejects missing required windows', () => {
    assertThrows(
        () => buildAnthropicUsageDisplay({
            seven_day: {utilization: 10},
        }),
        'Claude returned usage data in an unexpected shape'
    );
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
    const weeklyResetAt = GLib.DateTime.new(
        GLib.TimeZone.new_local(),
        2026,
        6,
        11,
        10,
        51,
        0
    );
    const display = buildOpenAIUsageDisplay({
        plan_type: 'plus',
        rate_limit: {
            primary_window: {
                used_percent: 1,
                reset_after_seconds: 1800,
            },
            secondary_window: {
                used_percent: 0,
                reset_at: weeklyResetAt.to_unix(),
            },
        },
        credits: {
            balance: '$2.50',
            unlimited: false,
            approx_local_messages: [100, 200],
        },
    }, {now});

    assertEqual(display.plan, 'ChatGPT Plus');
    assertEqual(display.metrics.length, 3);
    assertEqual(display.metrics[0].kind, 'current-session');
    assertEqual(display.metrics[0].label, 'Current session (5h)');
    assertEqual(
        display.metrics[0].detail,
        `Resets in 30m (${expectedResetAtLabel(display.metrics[0].resetAt, now)})`
    );
    assertEqual(
        display.metrics[1].detail,
        `Resets in ${formatDurationForTest(weeklyResetAt.to_unix() - now.to_unix())} (resets 10:51 on 11 Jun)`
    );
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

test('openai usage display rejects missing required windows', () => {
    assertThrows(
        () => buildOpenAIUsageDisplay({
            plan_type: 'plus',
            rate_limit: {
                primary_window: {used_percent: 10},
            },
        }),
        'Codex returned usage data in an unexpected shape'
    );
});

test('http status mapping returns clear usage states', () => {
    const cases = [
        [401, UsageStatus.UNAUTHENTICATED],
        [403, UsageStatus.UNAUTHENTICATED],
        [429, UsageStatus.RATE_LIMITED],
        [404, UsageStatus.UNSUPPORTED_ACCOUNT],
        [500, UsageStatus.OFFLINE],
        [418, UsageStatus.MALFORMED_RESPONSE],
    ];

    for (const [status, expected] of cases)
        assertEqual(httpStatusError(Vendors.OPENAI, status).status, expected);
});

test('http session can use a configured proxy resolver', () => {
    const session = createHttpSession({
        proxyUrl: ' http://localhost:8080 ',
    });

    try {
        assertEqual(session.get_proxy_resolver() !== null, true);
    } finally {
        session.abort();
    }
});

test('proxy resolution can opt into HTTPS_PROXY', () => {
    const previousHttpsProxy = GLib.getenv('HTTPS_PROXY');

    try {
        GLib.setenv('HTTPS_PROXY', ' http://localhost:8080 ', true);

        assertEqual(
            resolveProxyUrl({useEnvironmentProxy: true}),
            'http://localhost:8080'
        );
        assertEqual(
            resolveProxyUrl({
                proxyUrl: 'http://configured-proxy:8080',
                useEnvironmentProxy: true,
            }),
            'http://configured-proxy:8080'
        );
        assertEqual(resolveProxyUrl({useEnvironmentProxy: false}), null);
    } finally {
        restoreEnvironment('HTTPS_PROXY', previousHttpsProxy);
    }
});

test('http session can use HTTPS_PROXY when enabled', () => {
    const previousHttpsProxy = GLib.getenv('HTTPS_PROXY');

    try {
        GLib.setenv('HTTPS_PROXY', 'http://localhost:8080', true);
        const session = createHttpSession({useEnvironmentProxy: true});

        try {
            assertEqual(session.get_proxy_resolver() !== null, true);
        } finally {
            session.abort();
        }
    } finally {
        restoreEnvironment('HTTPS_PROXY', previousHttpsProxy);
    }
});

testAsync('secret credential store returns null for missing keyring item', async () => {
    const backend = new FakeSecretBackend();
    const store = new SecretCredentialStore({backend});

    const document = await store.lookupVendorCredentialDocument(Vendors.OPENAI);

    assertEqual(document, null);
    assertDeepEqual(backend.lookups[0], {
        application: 'ai-usagebar@miguins.com',
        vendor: Vendors.OPENAI,
        kind: 'oauth-document',
    });
});

testAsync('secret credential store parses and stores vendor documents', async () => {
    const backend = new FakeSecretBackend();
    const attributes = secretCredentialAttributes(Vendors.ANTHROPIC);
    backend.set(attributes, JSON.stringify({
        claudeAiOauth: {
            accessToken: 'redacted-access',
            refreshToken: 'redacted-refresh',
            expiresAt: 1780597324000,
        },
    }));

    const store = new SecretCredentialStore({backend});
    const document = await store.lookupVendorCredentialDocument(Vendors.ANTHROPIC);
    document.claudeAiOauth.accessToken = 'redacted-updated-access';
    await store.storeVendorCredentialDocument(Vendors.ANTHROPIC, document);

    assertEqual(document.claudeAiOauth.refreshToken, 'redacted-refresh');
    assertEqual(backend.stores.length, 1);
    assertEqual(
        backend.stores[0].label,
        'Claude OAuth credentials for GNOME AI UsageBar'
    );
    assertDeepEqual(JSON.parse(backend.stores[0].secret), document);
});

testAsync('secret credential store rejects malformed keyring documents', async () => {
    const backend = new FakeSecretBackend();
    backend.set(secretCredentialAttributes(Vendors.OPENAI), '{');

    const store = new SecretCredentialStore({backend});

    await assertRejects(
        () => store.lookupVendorCredentialDocument(Vendors.OPENAI),
        SecretCredentialErrorReason.MALFORMED_SECRET
    );
});

test('credential paths support default, absolute, and home-relative locations', () => {
    const homeDir = makeTempDir();

    try {
        assertEqual(
            credentialPath('.codex/auth.json', homeDir),
            GLib.build_filenamev([homeDir, '.codex', 'auth.json'])
        );
        assertEqual(
            credentialPath(
                '.codex/auth.json',
                homeDir,
                GLib.build_filenamev([homeDir, 'custom', 'auth.json'])
            ),
            GLib.build_filenamev([homeDir, 'custom', 'auth.json'])
        );
        assertEqual(
            expandCredentialPath('~/custom/auth.json', homeDir),
            GLib.build_filenamev([homeDir, 'custom', 'auth.json'])
        );
        assertEqual(
            expandCredentialPath('custom/auth.json', homeDir),
            GLib.build_filenamev([homeDir, 'custom', 'auth.json'])
        );
        assertEqual(
            expandCredentialPath('/tmp/codex-auth.json', homeDir),
            '/tmp/codex-auth.json'
        );
        assertEqual(
            normalizeCredentialPathSetting(
                GLib.build_filenamev([homeDir, 'custom', 'auth.json']),
                homeDir
            ),
            '~/custom/auth.json'
        );
        assertEqual(
            normalizeCredentialPathSetting('~/custom/auth.json', homeDir),
            '~/custom/auth.json'
        );
        assertEqual(
            normalizeCredentialPathSetting('/tmp/codex-auth.json', homeDir),
            '/tmp/codex-auth.json'
        );
        assertEqual(
            normalizeCredentialPathSetting(' custom/auth.json ', homeDir),
            'custom/auth.json'
        );
    } finally {
        removeTree(homeDir);
    }
});

test('vendor default credential paths honor config directory environment variables', () => {
    const homeDir = makeTempDir();
    const previousCodexHome = GLib.getenv('CODEX_HOME');
    const previousClaudeConfigDir = GLib.getenv('CLAUDE_CONFIG_DIR');

    try {
        GLib.setenv('CODEX_HOME', GLib.build_filenamev([homeDir, 'codex-home']), true);
        GLib.setenv('CLAUDE_CONFIG_DIR', '~/claude-config', true);

        assertEqual(
            getDefaultCredentialPath(Vendors.OPENAI, {homeDir}),
            GLib.build_filenamev([homeDir, 'codex-home', 'auth.json'])
        );
        assertEqual(
            getDefaultCredentialPath(Vendors.ANTHROPIC, {homeDir}),
            GLib.build_filenamev([homeDir, 'claude-config', '.credentials.json'])
        );
        assertEqual(
            getDefaultCredentialPath(Vendors.OPENAI, {
                homeDir,
                useEnvironment: false,
            }),
            GLib.build_filenamev([homeDir, '.codex', 'auth.json'])
        );
    } finally {
        restoreEnvironment('CODEX_HOME', previousCodexHome);
        restoreEnvironment('CLAUDE_CONFIG_DIR', previousClaudeConfigDir);
        removeTree(homeDir);
    }
});

testAsync('refresh looks up keyring when vendor credential file is missing', async () => {
    const credentialBaseDir = makeTempDir();
    const lookups = [];
    const store = {
        lookupVendorCredentialDocument: async vendor => {
            lookups.push(vendor);
            return null;
        },
    };

    try {
        const state = await refreshVendorUsage(Vendors.OPENAI, {
            credentialBaseDir,
            secretCredentialStore: store,
            session: {},
        });

        assertEqual(state.status, UsageStatus.UNAUTHENTICATED);
        assertEqual(lookups.length, 1);
        assertEqual(lookups[0], Vendors.OPENAI);
        assertEqual(
            state.summary,
            'Codex credentials are missing. Run `codex login` to sign in, or add a GNOME Keyring OAuth credential.'
        );
    } finally {
        removeTree(credentialBaseDir);
    }
});

testAsync('refresh loads openai usage from configured credential path', async () => {
    const credentialBaseDir = makeTempDir();
    const credentialDir = makeTempDir();
    const configuredPath = GLib.build_filenamev([credentialDir, 'codex-auth.json']);
    const now = GLib.DateTime.new_from_iso8601('2026-06-04T12:00:00Z', null);
    let lookupCount = 0;
    const store = {
        lookupVendorCredentialDocument: async () => {
            lookupCount += 1;
            return null;
        },
    };

    try {
        GLib.file_set_contents(configuredPath, JSON.stringify({
            tokens: {
                access_token: 'redacted-access',
                refresh_token: 'redacted-refresh',
                id_token: fakeJwt({exp: 1780597324}),
            },
        }));
        GLib.chmod(configuredPath, 0o600);

        const state = await refreshVendorUsage(Vendors.OPENAI, {
            credentialBaseDir,
            credentialPath: configuredPath,
            secretCredentialStore: store,
            session: {},
            now,
            requestJson: async () => ({
                rate_limit: {
                    primary_window: {used_percent: 2},
                    secondary_window: {used_percent: 11},
                },
            }),
        });

        assertEqual(state.status, UsageStatus.READY);
        assertEqual(state.plan, 'ChatGPT Unknown');
        assertEqual(lookupCount, 0);
    } finally {
        removeTree(credentialDir);
        removeTree(credentialBaseDir);
    }
});

testAsync('refresh refuses unsafe vendor credential files before keyring fallback', async () => {
    const credentialBaseDir = makeTempDir();
    const credentialDir = GLib.build_filenamev([credentialBaseDir, '.codex']);
    const credentialPath = GLib.build_filenamev([credentialDir, 'auth.json']);
    let lookupCount = 0;
    const store = {
        lookupVendorCredentialDocument: async () => {
            lookupCount += 1;
            return null;
        },
    };

    try {
        GLib.mkdir_with_parents(credentialDir, 0o700);
        GLib.file_set_contents(credentialPath, '{}\n');
        GLib.chmod(credentialPath, 0o644);

        const state = await refreshVendorUsage(Vendors.OPENAI, {
            credentialBaseDir,
            secretCredentialStore: store,
            session: {},
        });

        assertEqual(state.status, UsageStatus.UNAUTHENTICATED);
        assertEqual(lookupCount, 0);
        assertEqual(
            state.summary,
            'Credential file permissions are unsafe; refusing to read credentials.'
        );
    } finally {
        removeTree(credentialBaseDir);
    }
});

testAsync('refresh accepts non-writable shared vendor credential directories', async () => {
    const credentialBaseDir = makeTempDir();
    const credentialDir = GLib.build_filenamev([credentialBaseDir, '.codex']);
    const credentialPath = GLib.build_filenamev([credentialDir, 'auth.json']);
    const now = GLib.DateTime.new_from_iso8601('2026-06-04T12:00:00Z', null);

    try {
        GLib.mkdir_with_parents(credentialDir, 0o700);
        GLib.file_set_contents(credentialPath, JSON.stringify({
            tokens: {
                access_token: 'redacted-access',
                refresh_token: 'redacted-refresh',
                id_token: fakeJwt({exp: 1780597324}),
            },
        }));
        GLib.chmod(credentialPath, 0o600);
        GLib.chmod(credentialDir, 0o755);

        const state = await refreshVendorUsage(Vendors.OPENAI, {
            credentialBaseDir,
            session: {},
            now,
            requestJson: async () => ({
                rate_limit: {
                    primary_window: {used_percent: 2},
                    secondary_window: {used_percent: 11},
                },
            }),
        });

        assertEqual(state.status, UsageStatus.READY);
        assertEqual(state.plan, 'ChatGPT Unknown');
    } finally {
        GLib.chmod(credentialDir, 0o700);
        removeTree(credentialBaseDir);
    }
});

testAsync('refresh refuses writable vendor credential directories before reading', async () => {
    const credentialBaseDir = makeTempDir();
    const credentialDir = GLib.build_filenamev([credentialBaseDir, '.codex']);
    const credentialPath = GLib.build_filenamev([credentialDir, 'auth.json']);

    try {
        GLib.mkdir_with_parents(credentialDir, 0o700);
        GLib.file_set_contents(credentialPath, JSON.stringify({
            tokens: {
                access_token: 'redacted-access',
                refresh_token: 'redacted-refresh',
                id_token: fakeJwt({exp: 1780597324}),
            },
        }));
        GLib.chmod(credentialPath, 0o600);
        GLib.chmod(credentialDir, 0o777);

        const state = await refreshVendorUsage(Vendors.OPENAI, {
            credentialBaseDir,
            session: {},
        });

        assertEqual(state.status, UsageStatus.UNAUTHENTICATED);
        assertEqual(
            state.summary,
            'Credential directory permissions are unsafe; refusing to read credentials.'
        );
    } finally {
        GLib.chmod(credentialDir, 0o700);
        removeTree(credentialBaseDir);
    }
});

testAsync('refresh loads anthropic usage from keyring credentials without token refresh', async () => {
    const credentialBaseDir = makeTempDir();
    const now = GLib.DateTime.new_from_iso8601('2026-06-04T12:00:00Z', null);
    const requests = [];
    const store = {
        lookupVendorCredentialDocument: async vendor => {
            assertEqual(vendor, Vendors.ANTHROPIC);
            return {
                claudeAiOauth: {
                    accessToken: 'redacted-access',
                    refreshToken: 'redacted-refresh',
                    expiresAt: 1780597324000,
                    subscriptionType: 'max',
                    rateLimitTier: 'default_claude_max_5x',
                },
            };
        },
    };

    try {
        const state = await refreshVendorUsage(Vendors.ANTHROPIC, {
            credentialBaseDir,
            secretCredentialStore: store,
            session: {},
            now,
            requestJson: async (_session, request) => {
                requests.push(request);
                return {
                    five_hour: {utilization: 42},
                    seven_day: {utilization: 8},
                };
            },
        });

        assertEqual(state.status, UsageStatus.READY);
        assertEqual(state.plan, 'Max 5x');
        assertEqual(requests.length, 1);
        assertEqual(requests[0].method, 'GET');
        assertEqual(requests[0].headers.Authorization, 'Bearer redacted-access');
    } finally {
        removeTree(credentialBaseDir);
    }
});

testAsync('refresh writes back refreshed openai tokens and loads usage', async () => {
    const credentialBaseDir = makeTempDir();
    const now = GLib.DateTime.new_from_iso8601('2026-06-04T12:00:00Z', null);
    const requests = [];
    const stores = [];
    let document = {
        tokens: {
            access_token: 'redacted-old-access',
            refresh_token: 'redacted-old-refresh',
            id_token: fakeJwt({exp: 1}),
            account_id: 'redacted-account',
        },
    };
    const store = {
        lookupVendorCredentialDocument: async vendor => {
            assertEqual(vendor, Vendors.OPENAI);
            return document;
        },
        storeVendorCredentialDocument: async (vendor, updatedDocument) => {
            assertEqual(vendor, Vendors.OPENAI);
            document = updatedDocument;
            stores.push(JSON.parse(JSON.stringify(updatedDocument)));
        },
    };

    try {
        const state = await refreshVendorUsage(Vendors.OPENAI, {
            credentialBaseDir,
            secretCredentialStore: store,
            session: {},
            now,
            requestJson: async (_session, request) => {
                requests.push(request);
                if (request.method === 'POST') {
                    assertEqual(request.body.refresh_token, 'redacted-old-refresh');
                    return {
                        access_token: 'redacted-new-access',
                        refresh_token: 'redacted-new-refresh',
                        id_token: fakeJwt({
                            exp: 1780597324,
                            'https://api.openai.com/auth': {
                                chatgpt_plan_type: 'team',
                            },
                        }),
                    };
                }

                return {
                    rate_limit: {
                        primary_window: {used_percent: 2},
                        secondary_window: {used_percent: 11},
                    },
                };
            },
        });

        assertEqual(state.status, UsageStatus.READY);
        assertEqual(state.plan, 'ChatGPT Team');
        assertEqual(requests.length, 2);
        assertEqual(requests[0].method, 'POST');
        assertEqual(requests[1].method, 'GET');
        assertEqual(requests[1].headers.Authorization, 'Bearer redacted-new-access');
        assertEqual(requests[1].headers['ChatGPT-Account-Id'], 'redacted-account');
        assertEqual(stores.length, 1);
        assertEqual(stores[0].tokens.access_token, 'redacted-new-access');
        assertEqual(stores[0].tokens.refresh_token, 'redacted-new-refresh');
    } finally {
        removeTree(credentialBaseDir);
    }
});

testAsync('refresh maps mocked rate limits to usage state', async () => {
    const credentialBaseDir = makeTempDir();
    const store = {
        lookupVendorCredentialDocument: async () => ({
            tokens: {
                access_token: 'redacted-access',
                refresh_token: 'redacted-refresh',
                id_token: fakeJwt({exp: 1780597324}),
            },
        }),
    };

    try {
        const state = await refreshVendorUsage(Vendors.OPENAI, {
            credentialBaseDir,
            secretCredentialStore: store,
            session: {},
            requestJson: async () => {
                throw httpStatusError(Vendors.OPENAI, 429);
            },
        });

        assertEqual(state.status, UsageStatus.RATE_LIMITED);
        assertEqual(state.summary, 'Codex rate limit was reached. Try again later.');
    } finally {
        removeTree(credentialBaseDir);
    }
});

function test(name, callback) {
    tests.push({name, callback});
}

function testAsync(name, callback) {
    tests.push({name, callback});
}

function assertEqual(actual, expected) {
    if (actual !== expected)
        throw new Error(`Expected ${expected}, got ${actual}`);
}

function assertDeepEqual(actual, expected) {
    const actualJson = JSON.stringify(actual);
    const expectedJson = JSON.stringify(expected);

    if (actualJson !== expectedJson)
        throw new Error(`Expected ${expectedJson}, got ${actualJson}`);
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

async function assertRejects(callback, expectedReason) {
    try {
        await callback();
    } catch (error) {
        if (error.reason !== expectedReason) {
            throw new Error(
                `Expected rejection reason "${expectedReason}", got "${error.reason}"`
            );
        }

        return;
    }

    throw new Error(`Expected rejection reason "${expectedReason}"`);
}

function expectedResetAtLabel(resetAt, now) {
    const dateTime = GLib.DateTime.new_from_iso8601(resetAt, null);
    const localDateTime = GLib.DateTime.new_from_unix_local(dateTime.to_unix());
    const localNow = GLib.DateTime.new_from_unix_local(now.to_unix());
    const time = localDateTime.format('%H:%M');
    const monthNames = [
        'Jan',
        'Feb',
        'Mar',
        'Apr',
        'May',
        'Jun',
        'Jul',
        'Aug',
        'Sep',
        'Oct',
        'Nov',
        'Dec',
    ];

    if (sameLocalDate(localDateTime, localNow))
        return `resets ${time}`;

    return `resets ${time} on ${localDateTime.get_day_of_month()} ${monthNames[localDateTime.get_month() - 1]}`;
}

function sameLocalDate(first, second) {
    return first.get_year() === second.get_year() &&
        first.get_month() === second.get_month() &&
        first.get_day_of_month() === second.get_day_of_month();
}

function formatDurationForTest(totalSeconds) {
    const minutes = Math.max(0, Math.round(totalSeconds / 60));
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    const remainingMinutes = minutes % 60;

    if (days > 0)
        return hours > 0 ? `${days}d ${hours}h` : `${days}d`;

    if (hours > 0)
        return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;

    return `${remainingMinutes}m`;
}

function restoreEnvironment(name, previousValue) {
    if (previousValue === null)
        GLib.unsetenv(name);
    else
        GLib.setenv(name, previousValue, true);
}

class FakeSecretBackend {
    constructor() {
        this._secrets = new Map();
        this.lookups = [];
        this.stores = [];
    }

    set(attributes, secret) {
        this._secrets.set(this._key(attributes), secret);
    }

    async lookup(attributes) {
        this.lookups.push({...attributes});
        return this._secrets.get(this._key(attributes)) ?? null;
    }

    async store(attributes, label, secret) {
        this.stores.push({
            attributes: {...attributes},
            label,
            secret,
        });
        this._secrets.set(this._key(attributes), secret);
        return true;
    }

    _key(attributes) {
        return [
            attributes.application,
            attributes.vendor,
            attributes.kind,
        ].join('\n');
    }
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

let failures = 0;

for (const {name, callback} of tests) {
    try {
        const result = callback();
        if (result && typeof result.then === 'function')
            await result;
        print(`ok - ${name}`);
    } catch (error) {
        failures += 1;
        printerr(`not ok - ${name}`);
        printerr(error.stack ?? error.message);
    }
}

System.exit(failures === 0 ? 0 : 1);
