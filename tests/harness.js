import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

const tests = [];

export function test(name, callback) {
    tests.push({name, callback});
}

export function testAsync(name, callback) {
    tests.push({name, callback});
}

export function assertEqual(actual, expected) {
    if (actual !== expected)
        throw new Error(`Expected ${expected}, got ${actual}`);
}

export function assertDeepEqual(actual, expected) {
    const actualJson = JSON.stringify(actual);
    const expectedJson = JSON.stringify(expected);

    if (actualJson !== expectedJson)
        throw new Error(`Expected ${expectedJson}, got ${actualJson}`);
}

export function assertThrows(callback, expectedMessage) {
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

export async function assertRejects(callback, expectedReason) {
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

export function expectedResetAtLabel(resetAt, now) {
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

export function formatDurationForTest(totalSeconds) {
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

export function restoreEnvironment(name, previousValue) {
    if (previousValue === null)
        GLib.unsetenv(name);
    else
        GLib.setenv(name, previousValue, true);
}

export class FakeSecretBackend {
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

export function fakeJwt(claims) {
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

export function makeTempDir() {
    const path = GLib.build_filenamev([
        GLib.get_tmp_dir(),
        `gnome-ai-usagebar-test-${GLib.uuid_string_random()}`,
    ]);
    GLib.mkdir_with_parents(path, 0o700);
    return path;
}

export function getMode(path) {
    const file = Gio.File.new_for_path(path);
    const info = file.query_info(
        'unix::mode',
        Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
        null
    );

    return info.get_attribute_uint32('unix::mode') & 0o777;
}

export function removeTree(path) {
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

export async function runTests() {
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
}
