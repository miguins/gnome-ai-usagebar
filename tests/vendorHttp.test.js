import GLib from 'gi://GLib';

import {
    assertEqual,
    restoreEnvironment,
    test,
} from './harness.js';
import {UsageStatus} from '../lib/usageState.js';
import {Vendors} from '../lib/vendors.js';
import {
    createHttpSession,
    httpStatusError,
    resolveProxyUrl,
} from '../lib/vendorHttp.js';

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
