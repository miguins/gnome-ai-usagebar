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
