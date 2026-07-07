import {
    FakeSecretBackend,
    assertDeepEqual,
    assertEqual,
    assertRejects,
    testAsync,
} from './harness.js';
import {
    SecretCredentialErrorReason,
    SecretCredentialStore,
    secretCredentialAttributes,
} from '../lib/credentialStore.js';
import {Vendors} from '../lib/vendors.js';

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
