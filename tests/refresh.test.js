import GLib from 'gi://GLib';

import {
    assertEqual,
    fakeJwt,
    makeTempDir,
    removeTree,
    testAsync,
} from './harness.js';
import {UsageStatus} from '../lib/usageState.js';
import {Vendors} from '../lib/vendors.js';
import {refreshVendorUsage} from '../lib/vendorUsage.js';
import {httpStatusError} from '../lib/vendorHttp.js';

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
