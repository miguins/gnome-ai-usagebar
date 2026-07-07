import GLib from 'gi://GLib';

import {
    assertEqual,
    test,
} from './harness.js';
import {formatLocalTime} from '../lib/vendorFormat.js';

test('local time formatter uses the system timezone offset', () => {
    const previousTimezone = GLib.getenv('TZ');
    GLib.setenv('TZ', 'Etc/GMT+3', true);

    try {
        const updatedAt = GLib.DateTime.new_from_iso8601('2026-06-05T02:50:00Z', null);

        assertEqual(updatedAt.format('%H:%M:%S'), '02:50:00');
        assertEqual(formatLocalTime(updatedAt), '23:50:00');
    } finally {
        if (previousTimezone === null)
            GLib.unsetenv('TZ');
        else
            GLib.setenv('TZ', previousTimezone, true);
    }
});
