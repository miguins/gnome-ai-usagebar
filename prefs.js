import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {
    Vendors,
    VendorIds,
    VendorLabels,
    VendorSettings,
    detectInstalledVendors,
    getDefaultCredentialPath,
    getEnabledVendors,
    isVendorEnabled,
    isVendor,
    normalizeCredentialPathSetting,
} from './vendors.js';

const REFRESH_INTERVAL_MIN_SECONDS = 60;
const REFRESH_INTERVAL_MAX_SECONDS = 3600;
const REFRESH_INTERVAL_STEP_SECONDS = 60;
const DROPDOWN_OPACITY_MIN_PERCENT = 35;
const DROPDOWN_OPACITY_MAX_PERCENT = 100;
const DROPDOWN_OPACITY_STEP_PERCENT = 5;

export default class AIUsageBarPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            title: _('General'),
        });

        group.add(this._buildVendorRow(settings));
        group.add(this._buildRefreshIntervalRow(settings));
        group.add(this._buildDropdownOpacityRow(settings));
        group.add(this._buildFollowSystemThemeRow(settings));
        group.add(this._buildProxyUrlRow(settings));
        group.add(this._buildHttpsProxyEnvRow(settings));
        page.add(group);

        for (const vendor of VendorIds)
            page.add(this._buildProviderGroup(settings, vendor, window));

        window.add(page);
    }

    _buildVendorRow(settings) {
        const row = new Adw.ComboRow({
            title: _('Default Vendor'),
            subtitle: _('Choose the provider shown when the extension starts.'),
        });
        let vendorIds = [];
        let syncing = false;

        const syncSelection = () => {
            const previousSyncing = syncing;
            syncing = true;
            try {
                row.sensitive = vendorIds.length > 0;

                const selectedVendor = settings.get_string('selected-vendor');
                const selected = isVendor(selectedVendor) && vendorIds.includes(selectedVendor)
                    ? vendorIds.indexOf(selectedVendor)
                    : 0;

                if (row.selected !== selected)
                    row.selected = selected;
            } finally {
                syncing = previousSyncing;
            }
        };

        const syncModel = () => {
            syncing = true;
            try {
                vendorIds = getEnabledVendors(settings);
                const vendorLabels = vendorIds.length > 0
                    ? vendorIds.map(vendor => VendorLabels[vendor])
                    : [_('No providers enabled')];

                row.model = Gtk.StringList.new(vendorLabels);
                syncSelection();
            } finally {
                syncing = false;
            }
        };

        const handleSelectedChanged = () => {
            if (syncing || vendorIds.length === 0)
                return;

            const selected = row.selected;
            if (selected < 0 || selected >= vendorIds.length)
                return;

            const vendor = vendorIds[selected];
            if (settings.get_string('selected-vendor') !== vendor)
                settings.set_string('selected-vendor', vendor);
        };

        settings.connect('changed::selected-vendor', syncSelection);
        for (const vendor of VendorIds)
            settings.connect(`changed::${VendorSettings[vendor].enabled}`, syncModel);

        syncModel();
        row.connect('notify::selected', handleSelectedChanged);
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

    _buildDropdownOpacityRow(settings) {
        const row = new Adw.SpinRow({
            title: _('Dropdown Opacity'),
            subtitle: _('Lower values make the extension popup more transparent.'),
            adjustment: new Gtk.Adjustment({
                lower: DROPDOWN_OPACITY_MIN_PERCENT,
                upper: DROPDOWN_OPACITY_MAX_PERCENT,
                step_increment: DROPDOWN_OPACITY_STEP_PERCENT,
                page_increment: DROPDOWN_OPACITY_STEP_PERCENT,
                value: settings.get_uint('dropdown-opacity-percent'),
            }),
            climb_rate: 0,
            digits: 0,
            numeric: true,
            update_policy: Gtk.SpinButtonUpdatePolicy.IF_VALID,
        });

        row.connect('notify::value', () => {
            const value = Math.round(row.value);
            if (settings.get_uint('dropdown-opacity-percent') !== value)
                settings.set_uint('dropdown-opacity-percent', value);
        });

        settings.connect('changed::dropdown-opacity-percent', () => {
            const value = settings.get_uint('dropdown-opacity-percent');
            if (Math.round(row.value) !== value)
                row.value = value;
        });

        return row;
    }

    _buildFollowSystemThemeRow(settings) {
        const row = new Adw.SwitchRow({
            title: _('Follow System Theme'),
            subtitle: _('Use GNOME Shell theme colors for badges, progress, and controls.'),
            active: settings.get_boolean('follow-system-theme'),
        });

        row.connect('notify::active', () => {
            if (settings.get_boolean('follow-system-theme') !== row.active)
                settings.set_boolean('follow-system-theme', row.active);
        });

        settings.connect('changed::follow-system-theme', () => {
            const active = settings.get_boolean('follow-system-theme');
            if (row.active !== active)
                row.active = active;
        });

        return row;
    }

    _buildProxyUrlRow(settings) {
        const row = new Adw.EntryRow({
            title: _('Proxy URL'),
            text: settings.get_string('proxy-url'),
            show_apply_button: true,
        });

        row.connect('apply', () => {
            settings.set_string('proxy-url', row.text.trim());
        });

        settings.connect('changed::proxy-url', () => {
            const value = settings.get_string('proxy-url');
            if (row.text !== value)
                row.text = value;
        });

        return row;
    }

    _buildHttpsProxyEnvRow(settings) {
        const row = new Adw.SwitchRow({
            title: _('Use HTTPS_PROXY'),
            subtitle: _('Use the HTTPS_PROXY environment variable when Proxy URL is empty.'),
            active: settings.get_boolean('use-https-proxy-env'),
        });

        row.connect('notify::active', () => {
            if (settings.get_boolean('use-https-proxy-env') !== row.active)
                settings.set_boolean('use-https-proxy-env', row.active);
        });

        settings.connect('changed::use-https-proxy-env', () => {
            const active = settings.get_boolean('use-https-proxy-env');
            if (row.active !== active)
                row.active = active;
        });

        return row;
    }

    _buildProviderGroup(settings, vendor, window) {
        const group = new Adw.PreferencesGroup({
            title: VendorLabels[vendor],
            description: this._getProviderDescription(vendor),
        });

        group.add(this._buildProviderEnabledRow(settings, vendor));
        group.add(this._buildCredentialPathRow(settings, vendor, window));

        return group;
    }

    _buildProviderEnabledRow(settings, vendor) {
        const key = VendorSettings[vendor].enabled;
        const detectedVendors = detectInstalledVendors();
        const row = new Adw.SwitchRow({
            title: _('Show in Dropdown'),
            subtitle: detectedVendors.includes(vendor)
                ? _('Local CLI detected.')
                : _('Local CLI not detected; custom credentials or Keyring can still work.'),
            active: isVendorEnabled(settings, vendor),
        });

        row.connect('notify::active', () => {
            if (settings.get_boolean(key) !== row.active)
                settings.set_boolean(key, row.active);
        });

        settings.connect(`changed::${key}`, () => {
            const active = settings.get_boolean(key);
            if (row.active !== active)
                row.active = active;
        });

        return row;
    }

    _buildCredentialPathRow(settings, vendor, window) {
        const key = VendorSettings[vendor].credentialPath;
        const currentText = normalizeCredentialPathSetting(settings.get_string(key));
        if (settings.get_string(key) !== currentText)
            settings.set_string(key, currentText);

        const row = new Adw.EntryRow({
            title: this._getCredentialPathTitle(vendor),
            text: currentText,
        });

        row.connect('notify::text', () => {
            const value = normalizeCredentialPathSetting(row.text);
            if (settings.get_string(key) !== value)
                settings.set_string(key, value);
        });

        settings.connect(`changed::${key}`, () => {
            const value = settings.get_string(key);
            if (row.text !== value)
                row.text = value;
        });

        const browseButton = new Gtk.Button({
            icon_name: 'document-open-symbolic',
            tooltip_text: _('Choose credential file'),
            valign: Gtk.Align.CENTER,
        });
        browseButton.add_css_class('flat');
        browseButton.connect('clicked', () => {
            this._chooseCredentialPath(window, settings, key, row.title);
        });

        const clearButton = new Gtk.Button({
            icon_name: 'edit-clear-symbolic',
            tooltip_text: _('Use default path'),
            valign: Gtk.Align.CENTER,
        });
        clearButton.add_css_class('flat');
        clearButton.connect('clicked', () => {
            if (settings.get_string(key) !== '')
                settings.set_string(key, '');
        });

        row.add_suffix(browseButton);
        row.add_suffix(clearButton);

        return row;
    }

    _chooseCredentialPath(window, settings, key, title) {
        const dialog = new Gtk.FileChooserNative({
            title,
            action: Gtk.FileChooserAction.OPEN,
            transient_for: window,
            modal: true,
            accept_label: _('Select'),
            cancel_label: _('Cancel'),
        });

        dialog.connect('response', (_dialog, response) => {
            if (response === Gtk.ResponseType.ACCEPT) {
                const file = dialog.get_file();
                const path = file?.get_path();
                if (path)
                    settings.set_string(key, normalizeCredentialPathSetting(path));
            }

            dialog.destroy();
        });

        dialog.show();
    }

    _getProviderDescription(vendor) {
        const homeDir = GLib.get_home_dir();
        const path = getDefaultCredentialPath(vendor);
        const defaultPath = homeDir
            ? path.replace(homeDir, '~')
            : path;
        return _('Leave the credential path blank to use ') + defaultPath + '.';
    }

    _getCredentialPathTitle(vendor) {
        switch (vendor) {
        case Vendors.ANTHROPIC:
            return _('Credentials Path');
        case Vendors.OPENAI:
            return _('Codex Auth Path');
        default:
            return _('Credential Path');
        }
    }
}
