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

export const VendorCredentialEnvironment = Object.freeze({
    [Vendors.ANTHROPIC]: 'CLAUDE_CONFIG_DIR',
    [Vendors.OPENAI]: 'CODEX_HOME',
});

const VendorCredentialFileNames = Object.freeze({
    [Vendors.ANTHROPIC]: '.credentials.json',
    [Vendors.OPENAI]: 'auth.json',
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

export function normalizeCredentialPathSetting(path, homeDir = GLib.get_home_dir()) {
    const value = String(path ?? '').trim();
    if (value.length === 0)
        return '';

    if (!homeDir || value === '~' || value.startsWith('~/'))
        return value;

    const normalizedHomeDir = _stripTrailingSlashes(homeDir);
    if (normalizedHomeDir.length === 0)
        return value;

    if (value === normalizedHomeDir)
        return '~';

    const homePrefix = `${normalizedHomeDir}/`;
    if (value.startsWith(homePrefix))
        return `~/${value.slice(homePrefix.length)}`;

    return value;
}

export function normalizeCredentialPathSettings(settings) {
    for (const vendor of VendorIds) {
        const key = VendorSettings[vendor].credentialPath;
        const value = settings.get_string(key);
        const normalized = normalizeCredentialPathSetting(value);
        if (value !== normalized)
            settings.set_string(key, normalized);
    }
}

export function getDefaultCredentialPath(vendor, {
    homeDir = GLib.get_home_dir(),
    useEnvironment = true,
} = {}) {
    if (!isVendor(vendor))
        return null;

    const environmentDir = useEnvironment
        ? _credentialDirectoryFromEnvironment(vendor, homeDir)
        : null;
    if (environmentDir) {
        return GLib.build_filenamev([
            environmentDir,
            VendorCredentialFileNames[vendor],
        ]);
    }

    return GLib.build_filenamev([
        homeDir,
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

function _credentialDirectoryFromEnvironment(vendor, homeDir) {
    const variable = VendorCredentialEnvironment[vendor];
    if (!variable)
        return null;

    const value = String(GLib.getenv(variable) ?? '').trim();
    if (value.length === 0)
        return null;

    return _expandDirectoryPath(value, homeDir);
}

function _expandDirectoryPath(path, homeDir) {
    const value = String(path ?? '').trim();
    if (value.length === 0)
        return null;

    if (!homeDir || value.startsWith('/'))
        return value;

    if (value === '~')
        return homeDir;

    if (value.startsWith('~/')) {
        return GLib.build_filenamev([
            homeDir,
            ...value.slice(2).split('/'),
        ]);
    }

    return GLib.build_filenamev([
        homeDir,
        ...value.split('/'),
    ]);
}

function _stripTrailingSlashes(path) {
    let value = String(path);
    while (value.length > 1 && value.endsWith('/'))
        value = value.slice(0, -1);

    return value;
}
