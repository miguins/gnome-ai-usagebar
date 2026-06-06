import GLib from 'gi://GLib';

import {
    validateNotGroupOtherWritableDirectory,
    validateOwnerOnlyFile,
    writePrivateJsonFile,
} from './fileSecurity.js';
import {
    SecretCredentialError,
    SecretCredentialStore,
} from './credentialStore.js';
import {UsageStatus} from './usageState.js';
import {
    getDefaultCredentialPath,
    VendorLabels,
} from './vendors.js';
import {UsageFetchError} from './vendorErrors.js';

const REFRESH_BUFFER_SECONDS = 300;

export async function readCredentialSource({
    vendor,
    relativePath,
    configuredPath = null,
    missingSummary,
    unreadableSummary,
    credentialBaseDir,
    useEnvironmentDefaultPaths = true,
    secretCredentialStore,
}) {
    const path = configuredPath
        ? credentialPath(relativePath, credentialBaseDir, configuredPath)
        : getDefaultCredentialPath(vendor, {
            homeDir: credentialBaseDir,
            useEnvironment: useEnvironmentDefaultPaths,
        });
    if (GLib.file_test(path, GLib.FileTest.EXISTS)) {
        return {
            document: readCredentialDocument(path, missingSummary, unreadableSummary),
            write: document => writeCredentialDocument(path, document),
        };
    }

    const store = secretCredentialStore ?? new SecretCredentialStore();
    let document;
    try {
        document = await store.lookupVendorCredentialDocument(vendor);
    } catch (error) {
        throw secretCredentialUsageError(vendor, error);
    }

    if (document === null) {
        throw new UsageFetchError(
            UsageStatus.UNAUTHENTICATED,
            missingSummary
        );
    }

    return {
        document,
        write: async updatedDocument => {
            try {
                await store.storeVendorCredentialDocument(vendor, updatedDocument);
            } catch (error) {
                throw new UsageFetchError(
                    UsageStatus.UNAUTHENTICATED,
                    'Credential refresh succeeded, but updated credentials could not be saved safely.'
                );
            }
        },
    };
}

export function readCredentialDocument(path, missingSummary, unreadableSummary) {
    if (!GLib.file_test(path, GLib.FileTest.EXISTS)) {
        throw new UsageFetchError(
            UsageStatus.UNAUTHENTICATED,
            missingSummary
        );
    }

    const parentCheck = validateCredentialParentDirectory(path);
    if (!parentCheck.ok) {
        throw new UsageFetchError(
            UsageStatus.UNAUTHENTICATED,
            'Credential directory permissions are unsafe; refusing to read credentials.'
        );
    }

    const permissionCheck = validateOwnerOnlyFile(path, {label: 'credential'});
    if (!permissionCheck.ok) {
        throw new UsageFetchError(
            UsageStatus.UNAUTHENTICATED,
            'Credential file permissions are unsafe; refusing to read credentials.'
        );
    }

    try {
        const [success, bytes] = GLib.file_get_contents(path);
        if (!success)
            throw new Error('unable to read file');

        return JSON.parse(new TextDecoder().decode(bytes));
    } catch (error) {
        throw new UsageFetchError(
            UsageStatus.UNAUTHENTICATED,
            unreadableSummary
        );
    }
}

export function writeCredentialDocument(path, document) {
    const parentCheck = validateCredentialParentDirectory(path);
    if (!parentCheck.ok) {
        throw new UsageFetchError(
            UsageStatus.UNAUTHENTICATED,
            'Credential directory permissions are unsafe; refusing to update credentials.'
        );
    }

    const permissionCheck = validateOwnerOnlyFile(path, {label: 'credential'});
    if (!permissionCheck.ok) {
        throw new UsageFetchError(
            UsageStatus.UNAUTHENTICATED,
            'Credential file permissions are unsafe; refusing to update credentials.'
        );
    }

    try {
        writePrivateJsonFile(path, document);
    } catch (error) {
        throw new UsageFetchError(
            UsageStatus.UNAUTHENTICATED,
            'Credential refresh succeeded, but updated credentials could not be saved safely.'
        );
    }
}

export function validateCredentialParentDirectory(path) {
    const parentPath = GLib.path_get_dirname(path);
    return validateNotGroupOtherWritableDirectory(parentPath, {
        label: 'credential directory',
    });
}

export function credentialPath(
    relativePath,
    baseDir = GLib.get_home_dir(),
    configuredPath = null
) {
    const overridePath = expandCredentialPath(configuredPath);
    if (overridePath)
        return overridePath;

    return GLib.build_filenamev([
        baseDir,
        ...relativePath.split('/'),
    ]);
}

export function expandCredentialPath(path, homeDir = GLib.get_home_dir()) {
    const value = String(path ?? '').trim();
    if (value.length === 0)
        return null;

    if (!homeDir)
        return value;

    if (value === '~')
        return homeDir;

    if (value.startsWith('~/')) {
        return GLib.build_filenamev([
            homeDir,
            ...value.slice(2).split('/'),
        ]);
    }

    if (value.startsWith('/'))
        return value;

    return GLib.build_filenamev([
        homeDir,
        ...value.split('/'),
    ]);
}

export function requiredCredentialString(value, label) {
    if (typeof value === 'string' && value.length > 0)
        return value;

    throw new UsageFetchError(
        UsageStatus.UNAUTHENTICATED,
        `Saved credentials are missing a required ${label}. Sign in again.`
    );
}

export function requiredCredentialNumber(value, label) {
    const number = Number(value);
    if (Number.isFinite(number))
        return number;

    throw new UsageFetchError(
        UsageStatus.UNAUTHENTICATED,
        `Saved credentials have an invalid ${label}. Sign in again.`
    );
}

export function requiredResponseString(value, vendor, label) {
    if (typeof value === 'string' && value.length > 0)
        return value;

    throw new UsageFetchError(
        UsageStatus.MALFORMED_RESPONSE,
        `${VendorLabels[vendor]} returned a token refresh response without ${label}.`
    );
}

export function positiveResponseNumber(value, vendor, label) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0)
        return number;

    throw new UsageFetchError(
        UsageStatus.MALFORMED_RESPONSE,
        `${VendorLabels[vendor]} returned a token refresh response with invalid ${label}.`
    );
}

export function assertCredentialObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new UsageFetchError(
            UsageStatus.UNAUTHENTICATED,
            `${label} are malformed. Sign in again.`
        );
    }
}

export function needsRefresh(expiresAtSeconds, now) {
    return expiresAtSeconds < now.to_unix() + REFRESH_BUFFER_SECONDS;
}

function secretCredentialUsageError(vendor, error) {
    if (error instanceof SecretCredentialError) {
        return new UsageFetchError(
            UsageStatus.UNAUTHENTICATED,
            error.summary
        );
    }

    return new UsageFetchError(
        UsageStatus.UNAUTHENTICATED,
        `${VendorLabels[vendor]} credentials could not be loaded from GNOME Keyring.`
    );
}
