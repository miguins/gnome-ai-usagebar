import GLib from 'gi://GLib';

export const Vendors = Object.freeze({
    ANTHROPIC: 'anthropic',
    OPENAI: 'openai',
});

export const VendorLabels = Object.freeze({
    [Vendors.ANTHROPIC]: 'Claude',
    [Vendors.OPENAI]: 'Codex',
});

export const VendorIds = Object.freeze(Object.values(Vendors));

export const VendorCredentialDefaults = Object.freeze({
    [Vendors.ANTHROPIC]: '.claude/.credentials.json',
    [Vendors.OPENAI]: '.codex/auth.json',
});

export const VendorSettings = Object.freeze({
    [Vendors.ANTHROPIC]: Object.freeze({
        enabled: 'anthropic-enabled',
        credentialPath: 'anthropic-credentials-path',
    }),
    [Vendors.OPENAI]: Object.freeze({
        enabled: 'openai-enabled',
        credentialPath: 'openai-codex-auth-path',
    }),
});

export const VendorCommands = Object.freeze({
    [Vendors.ANTHROPIC]: ['claude'],
    [Vendors.OPENAI]: ['codex'],
});

const UserExecutableDirs = Object.freeze([
    '.local/bin',
    '.npm-global/bin',
    '.config/yarn/global/node_modules/.bin',
    '.bun/bin',
    '.cargo/bin',
]);

export function isVendor(value) {
    return VendorIds.includes(value);
}

export function getEnabledVendors(settings) {
    return VendorIds.filter(vendor => isVendorEnabled(settings, vendor));
}

export function isVendorEnabled(settings, vendor) {
    if (!isVendor(vendor))
        return false;

    return settings.get_boolean(VendorSettings[vendor].enabled);
}

export function getConfiguredCredentialPath(settings, vendor) {
    if (!isVendor(vendor))
        return null;

    const value = settings.get_string(VendorSettings[vendor].credentialPath).trim();
    return value.length > 0 ? value : null;
}

export function getDefaultCredentialPath(vendor) {
    if (!isVendor(vendor))
        return null;

    return GLib.build_filenamev([
        GLib.get_home_dir(),
        ...VendorCredentialDefaults[vendor].split('/'),
    ]);
}

export function detectInstalledVendors() {
    return VendorIds.filter(vendor => VendorCommands[vendor].some(_isCommandInstalled));
}

function _isCommandInstalled(command) {
    if (GLib.find_program_in_path(command) !== null)
        return true;

    const homeDir = GLib.get_home_dir();
    if (!homeDir)
        return false;

    return UserExecutableDirs.some(relativeDir => {
        const path = GLib.build_filenamev([
            homeDir,
            ...relativeDir.split('/'),
            command,
        ]);

        return GLib.file_test(path, GLib.FileTest.IS_EXECUTABLE);
    });
}
