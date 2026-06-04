import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {
    VendorLabels,
    detectInstalledVendors,
    isVendor,
} from './vendors.js';

const REFRESH_INTERVAL_MIN_SECONDS = 60;
const REFRESH_INTERVAL_MAX_SECONDS = 3600;
const REFRESH_INTERVAL_STEP_SECONDS = 60;

export default class AIUsageBarPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            title: _('General'),
        });

        group.add(this._buildVendorRow(settings));
        group.add(this._buildRefreshIntervalRow(settings));
        page.add(group);
        window.add(page);
    }

    _buildVendorRow(settings) {
        const vendorIds = detectInstalledVendors();
        const vendorLabels = vendorIds.length > 0
            ? vendorIds.map(vendor => VendorLabels[vendor])
            : [_('No supported tools detected')];
        const row = new Adw.ComboRow({
            title: _('Default Vendor'),
            subtitle: _('Choose the detected tool shown when the extension starts.'),
            model: Gtk.StringList.new(vendorLabels),
            sensitive: vendorIds.length > 0,
        });

        if (vendorIds.length === 0)
            return row;

        const selectedVendor = settings.get_string('selected-vendor');
        row.selected = Math.max(0, vendorIds.indexOf(selectedVendor));

        row.connect('notify::selected', () => {
            const vendor = vendorIds[row.selected] ?? vendorIds[0];
            if (settings.get_string('selected-vendor') !== vendor)
                settings.set_string('selected-vendor', vendor);
        });

        settings.connect('changed::selected-vendor', () => {
            const vendor = settings.get_string('selected-vendor');
            const selected = isVendor(vendor) && vendorIds.includes(vendor)
                ? vendorIds.indexOf(vendor)
                : 0;

            if (row.selected !== selected)
                row.selected = selected;
        });

        return row;
    }

    _buildRefreshIntervalRow(settings) {
        const row = new Adw.SpinRow({
            title: _('Refresh Interval'),
            subtitle: _('Background refresh interval in seconds.'),
            adjustment: new Gtk.Adjustment({
                lower: REFRESH_INTERVAL_MIN_SECONDS,
                upper: REFRESH_INTERVAL_MAX_SECONDS,
                step_increment: REFRESH_INTERVAL_STEP_SECONDS,
                page_increment: REFRESH_INTERVAL_STEP_SECONDS,
                value: settings.get_uint('refresh-interval-seconds'),
            }),
            climb_rate: 0,
            digits: 0,
            numeric: true,
            update_policy: Gtk.SpinButtonUpdatePolicy.IF_VALID,
        });

        row.connect('notify::value', () => {
            const value = Math.round(row.value);
            if (settings.get_uint('refresh-interval-seconds') !== value)
                settings.set_uint('refresh-interval-seconds', value);
        });

        settings.connect('changed::refresh-interval-seconds', () => {
            const value = settings.get_uint('refresh-interval-seconds');
            if (Math.round(row.value) !== value)
                row.value = value;
        });

        return row;
    }
}
