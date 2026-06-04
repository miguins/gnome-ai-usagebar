import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const OWNER_ONLY_FILE_MODE = 0o600;
export const OWNER_ONLY_DIR_MODE = 0o700;
export const UNSAFE_PERMISSION_MASK = 0o077;

export function validateOwnerOnlyFile(path, {
    label = 'file',
    missingMessage = null,
} = {}) {
    const file = Gio.File.new_for_path(path);

    try {
        const info = file.query_info(
            'standard::type,unix::mode',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            null
        );

        if (info.get_file_type() !== Gio.FileType.REGULAR) {
            return {
                ok: false,
                message: `${_capitalize(label)} path is not a regular file`,
            };
        }

        return validateOwnerOnlyMode(path, info.get_attribute_uint32('unix::mode'), {label});
    } catch (error) {
        return {
            ok: false,
            message: missingMessage ?? error.message,
        };
    }
}

export function validateOwnerOnlyDirectory(path, {
    label = 'directory',
    missingMessage = null,
} = {}) {
    const file = Gio.File.new_for_path(path);

    try {
        const info = file.query_info(
            'standard::type,unix::mode',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            null
        );

        if (info.get_file_type() !== Gio.FileType.DIRECTORY) {
            return {
                ok: false,
                message: `${_capitalize(label)} path is not a directory`,
            };
        }

        return validateOwnerOnlyMode(path, info.get_attribute_uint32('unix::mode'), {label});
    } catch (error) {
        return {
            ok: false,
            message: missingMessage ?? error.message,
        };
    }
}

export function validateNotGroupOtherWritableDirectory(path, {
    label = 'directory',
    missingMessage = null,
} = {}) {
    const file = Gio.File.new_for_path(path);

    try {
        const info = file.query_info(
            'standard::type,unix::mode',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            null
        );

        if (info.get_file_type() !== Gio.FileType.DIRECTORY) {
            return {
                ok: false,
                message: `${_capitalize(label)} path is not a directory`,
            };
        }

        const permissionBits = info.get_attribute_uint32('unix::mode') & 0o777;
        if ((permissionBits & 0o022) !== 0) {
            return {
                ok: false,
                message: `Unsafe ${label} permissions for ${path}: ${permissionBits.toString(8)}`,
            };
        }

        return {ok: true};
    } catch (error) {
        return {
            ok: false,
            message: missingMessage ?? error.message,
        };
    }
}

export function validateOwnerOnlyMode(path, mode, {label = 'file'} = {}) {
    const permissionBits = mode & 0o777;
    if ((permissionBits & UNSAFE_PERMISSION_MASK) !== 0) {
        return {
            ok: false,
            message: `Unsafe ${label} permissions for ${path}: ${permissionBits.toString(8)}`,
        };
    }

    return {ok: true};
}

export function writePrivateJsonFile(path, payload) {
    writePrivateTextFile(path, `${JSON.stringify(payload, null, 2)}\n`);
}

export function writePrivateTextFile(path, text) {
    const tmpPath = `${path}.${GLib.uuid_string_random()}.tmp`;

    try {
        _writePrivateTextFile(tmpPath, text);

        if (GLib.rename(tmpPath, path) !== 0)
            throw new Error(`Failed to move temporary file into place: ${path}`);

        GLib.chmod(path, OWNER_ONLY_FILE_MODE);
    } catch (error) {
        if (GLib.file_test(tmpPath, GLib.FileTest.EXISTS))
            GLib.unlink(tmpPath);

        throw error;
    }
}

function _writePrivateTextFile(path, text) {
    const file = Gio.File.new_for_path(path);
    let stream = null;

    try {
        stream = file.replace(
            null,
            false,
            Gio.FileCreateFlags.PRIVATE,
            null
        );

        const bytes = new TextEncoder().encode(text);
        const [success] = stream.write_all(bytes, null);
        if (!success)
            throw new Error(`Unable to write file: ${path}`);
    } finally {
        if (stream !== null)
            stream.close(null);
    }
}

function _capitalize(value) {
    const text = String(value ?? '');
    if (text.length === 0)
        return '';

    return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}
