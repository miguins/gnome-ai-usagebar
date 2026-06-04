import {
    VendorLabels,
    isVendor,
} from './vendors.js';

export const SECRET_APPLICATION_ID = 'ai-usagebar@miguins.com';
export const SECRET_SCHEMA_NAME = 'com.miguins.ai_usagebar.Credentials';
export const SECRET_CREDENTIAL_KIND = 'oauth-document';

export const SecretCredentialErrorReason = Object.freeze({
    UNAVAILABLE: 'unavailable',
    LOOKUP_FAILED: 'lookup-failed',
    STORE_FAILED: 'store-failed',
    MALFORMED_SECRET: 'malformed-secret',
    INVALID_DOCUMENT: 'invalid-document',
});

let _secretModule = null;
let _secretSchema = null;

export class SecretCredentialError extends Error {
    constructor(reason, summary) {
        super(summary);
        this.reason = reason;
        this.summary = summary;
    }
}

export class SecretCredentialStore {
    constructor({
        applicationId = SECRET_APPLICATION_ID,
        backend = null,
    } = {}) {
        this._applicationId = applicationId;
        this._backend = backend ?? new LibsecretCredentialBackend();
    }

    async lookupVendorCredentialDocument(vendor) {
        this._assertVendor(vendor);

        let secret;
        try {
            secret = await this._backend.lookup(this._attributes(vendor));
        } catch (error) {
            if (error instanceof SecretCredentialError)
                throw error;

            throw new SecretCredentialError(
                SecretCredentialErrorReason.LOOKUP_FAILED,
                `${VendorLabels[vendor]} credentials could not be loaded from GNOME Keyring.`
            );
        }

        if (secret === null)
            return null;

        if (typeof secret !== 'string' || secret.trim().length === 0) {
            throw new SecretCredentialError(
                SecretCredentialErrorReason.MALFORMED_SECRET,
                `${VendorLabels[vendor]} GNOME Keyring credential is empty or invalid.`
            );
        }

        let document;
        try {
            document = JSON.parse(secret);
        } catch (error) {
            throw new SecretCredentialError(
                SecretCredentialErrorReason.MALFORMED_SECRET,
                `${VendorLabels[vendor]} GNOME Keyring credential is not valid JSON.`
            );
        }

        if (!document || typeof document !== 'object' || Array.isArray(document)) {
            throw new SecretCredentialError(
                SecretCredentialErrorReason.MALFORMED_SECRET,
                `${VendorLabels[vendor]} GNOME Keyring credential must be a JSON object.`
            );
        }

        return document;
    }

    async storeVendorCredentialDocument(vendor, document) {
        this._assertVendor(vendor);

        if (!document || typeof document !== 'object' || Array.isArray(document)) {
            throw new SecretCredentialError(
                SecretCredentialErrorReason.INVALID_DOCUMENT,
                `${VendorLabels[vendor]} credential document must be a JSON object.`
            );
        }

        const label = `${VendorLabels[vendor]} OAuth credentials for GNOME AI UsageBar`;
        const secret = `${JSON.stringify(document, null, 2)}\n`;

        try {
            const stored = await this._backend.store(
                this._attributes(vendor),
                label,
                secret
            );

            if (stored === false) {
                throw new SecretCredentialError(
                    SecretCredentialErrorReason.STORE_FAILED,
                    `${VendorLabels[vendor]} credentials could not be saved to GNOME Keyring.`
                );
            }
        } catch (error) {
            if (error instanceof SecretCredentialError)
                throw error;

            throw new SecretCredentialError(
                SecretCredentialErrorReason.STORE_FAILED,
                `${VendorLabels[vendor]} credentials could not be saved to GNOME Keyring.`
            );
        }
    }

    _attributes(vendor) {
        return secretCredentialAttributes(vendor, {
            applicationId: this._applicationId,
        });
    }

    _assertVendor(vendor) {
        if (!isVendor(vendor))
            throw new Error(`Unsupported vendor: ${vendor}`);
    }
}

export class LibsecretCredentialBackend {
    async lookup(attributes) {
        const Secret = await _loadSecret();
        const schema = _credentialSchema(Secret);

        return new Promise((resolve, reject) => {
            Secret.password_lookup(
                schema,
                attributes,
                null,
                (_source, result) => {
                    try {
                        resolve(Secret.password_lookup_finish(result));
                    } catch (error) {
                        reject(error);
                    }
                }
            );
        });
    }

    async store(attributes, label, secret) {
        const Secret = await _loadSecret();
        const schema = _credentialSchema(Secret);

        return new Promise((resolve, reject) => {
            Secret.password_store(
                schema,
                attributes,
                Secret.COLLECTION_DEFAULT,
                label,
                secret,
                null,
                (_source, result) => {
                    try {
                        resolve(Secret.password_store_finish(result));
                    } catch (error) {
                        reject(error);
                    }
                }
            );
        });
    }
}

export function secretCredentialAttributes(vendor, {
    applicationId = SECRET_APPLICATION_ID,
} = {}) {
    if (!isVendor(vendor))
        throw new Error(`Unsupported vendor: ${vendor}`);

    return {
        application: applicationId,
        vendor,
        kind: SECRET_CREDENTIAL_KIND,
    };
}

async function _loadSecret() {
    if (_secretModule !== null)
        return _secretModule;

    try {
        const module = await import('gi://Secret?version=1');
        _secretModule = module.default;
        return _secretModule;
    } catch (error) {
        throw new SecretCredentialError(
            SecretCredentialErrorReason.UNAVAILABLE,
            'GNOME Keyring support is unavailable on this system.'
        );
    }
}

function _credentialSchema(Secret) {
    if (_secretSchema !== null)
        return _secretSchema;

    _secretSchema = new Secret.Schema(
        SECRET_SCHEMA_NAME,
        Secret.SchemaFlags.DONT_MATCH_NAME,
        {
            application: Secret.SchemaAttributeType.STRING,
            vendor: Secret.SchemaAttributeType.STRING,
            kind: Secret.SchemaAttributeType.STRING,
        }
    );

    return _secretSchema;
}
