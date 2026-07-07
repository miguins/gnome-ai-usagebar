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
import {
    UsageThresholdDefinitions,
    UsageThresholdIds,
} from './usageThresholds.js';

const REFRESH_INTERVAL_MIN_SECONDS = 60;
const REFRESH_INTERVAL_MAX_SECONDS = 3600;
const REFRESH_INTERVAL_STEP_SECONDS = 60;
const DROPDOWN_OPACITY_MIN_PERCENT = 35;
const DROPDOWN_OPACITY_MAX_PERCENT = 100;
const DROPDOWN_OPACITY_STEP_PERCENT = 5;
const THRESHOLD_MIN_PERCENT = 0;
const THRESHOLD_MAX_PERCENT = 100;
const THRESHOLD_STEP_PERCENT = 1;
const THRESHOLD_SETTINGS_KEYS = UsageThresholdDefinitions.reduce((keys, definition) => {
    keys.push(definition.enabledKey, definition.percentKey);
    return keys;
}, []);
const SETTINGS_KEYS = Object.freeze([
    'selected-vendor',
    'refresh-interval-seconds',
    'dropdown-opacity-percent',
    'follow-system-theme',
    'display-metric',
    'metric-display-mode',
    'panel-icon-style',
    'show-panel-percentage',
    'show-panel-reset',
    'color-panel-text-by-usage',
    ...THRESHOLD_SETTINGS_KEYS,
    'proxy-url',
    'use-https-proxy-env',
    'anthropic-enabled',
    'anthropic-credentials-path',
    'openai-enabled',
    'openai-codex-auth-path',
]);

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

        page.add(this._buildDisplayGroup(settings));
        page.add(this._buildUsageAlertsGroup(settings));

        for (const vendor of VendorIds)
            page.add(this._buildProviderGroup(settings, vendor, window));

        page.add(this._buildResetGroup(settings, window));

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

    _buildDisplayGroup(settings) {
        const group = new Adw.PreferencesGroup({
            title: _('Display'),
            description: _('Control how usage is shown in the panel and dropdown.'),
        });

        group.add(this._buildChoiceRow(settings, 'display-metric', {
            title: _('Usage Metric'),
            subtitle: _('Show the consumed or remaining share of each window.'),
            choices: [
                {value: 'used', label: _('Used')},
                {value: 'remaining', label: _('Remaining')},
            ],
        }));
        group.add(this._buildChoiceRow(settings, 'metric-display-mode', {
            title: _('Metric Style'),
            subtitle: _('Render dropdown usage windows as text, a bar, or both.'),
            choices: [
                {value: 'both', label: _('Text and bar')},
                {value: 'text', label: _('Text only')},
                {value: 'bar', label: _('Bar only')},
            ],
        }));
        group.add(this._buildChoiceRow(settings, 'panel-icon-style', {
            title: _('Panel Icon'),
            subtitle: _('Choose the top-bar icon style.'),
            choices: [
                {value: 'vendor', label: _('Provider logo')},
                {value: 'generic', label: _('Generic icon')},
                {value: 'hidden', label: _('Hidden')},
            ],
        }));
        group.add(this._buildSwitchRow(settings, 'show-panel-percentage', {
            title: _('Show Percentage In Panel'),
            subtitle: _('Display the usage percentage text in the top bar.'),
        }));
        group.add(this._buildSwitchRow(settings, 'show-panel-reset', {
            title: _('Show Reset Countdown In Panel'),
            subtitle: _('Append the reset countdown after the panel percentage.'),
        }));
        group.add(this._buildSwitchRow(settings, 'color-panel-text-by-usage', {
            title: _('Color Panel Text By Usage'),
            subtitle: _('Use threshold colors for current session usage, even when following the system theme.'),
        }));

        return group;
    }

    _buildUsageAlertsGroup(settings) {
        const group = new Adw.PreferencesGroup({
            title: _('Usage Alerts'),
            description: _('Notify when a usage window reaches a configured threshold. The top-bar color follows current session usage.'),
        });

        for (const definition of UsageThresholdDefinitions)
            group.add(this._buildThresholdRow(settings, definition));

        return group;
    }

    _buildThresholdRow(settings, definition) {
        const row = new Adw.ActionRow({
            title: this._getThresholdTitle(definition.id),
            subtitle: this._getThresholdSubtitle(definition.id),
        });
        const adjustment = new Gtk.Adjustment({
            lower: THRESHOLD_MIN_PERCENT,
            upper: THRESHOLD_MAX_PERCENT,
            step_increment: THRESHOLD_STEP_PERCENT,
            page_increment: 5,
            value: settings.get_uint(definition.percentKey),
        });
        const spin = new Gtk.SpinButton({
            adjustment,
            climb_rate: 0,
            digits: 0,
            numeric: true,
            update_policy: Gtk.SpinButtonUpdatePolicy.IF_VALID,
            valign: Gtk.Align.CENTER,
            width_chars: 3,
        });
        const percentLabel = new Gtk.Label({
            label: '%',
            valign: Gtk.Align.CENTER,
        });
        const toggle = new Gtk.Switch({
            active: settings.get_boolean(definition.enabledKey),
            valign: Gtk.Align.CENTER,
        });

        const syncSensitive = () => {
            spin.sensitive = toggle.active;
            percentLabel.sensitive = toggle.active;
        };

        spin.connect('notify::value', () => {
            const value = Math.round(spin.value);
            if (settings.get_uint(definition.percentKey) !== value)
                settings.set_uint(definition.percentKey, value);
        });

        toggle.connect('notify::active', () => {
            if (settings.get_boolean(definition.enabledKey) !== toggle.active)
                settings.set_boolean(definition.enabledKey, toggle.active);
            syncSensitive();
        });

        settings.connect(`changed::${definition.percentKey}`, () => {
            const value = settings.get_uint(definition.percentKey);
            if (Math.round(spin.value) !== value)
                spin.value = value;
        });

        settings.connect(`changed::${definition.enabledKey}`, () => {
            const active = settings.get_boolean(definition.enabledKey);
            if (toggle.active !== active)
                toggle.active = active;
            syncSensitive();
        });

        syncSensitive();
        row.add_suffix(spin);
        row.add_suffix(percentLabel);
        row.add_suffix(toggle);
        row.activatable_widget = toggle;

        return row;
    }

    _buildChoiceRow(settings, key, {title, subtitle, choices}) {
        const values = choices.map(choice => choice.value);
        const row = new Adw.ComboRow({
            title,
            subtitle,
            model: Gtk.StringList.new(choices.map(choice => choice.label)),
        });

        let syncing = false;
        const syncSelection = () => {
            syncing = true;
            try {
                const index = values.indexOf(settings.get_string(key));
                row.selected = index >= 0 ? index : 0;
            } finally {
                syncing = false;
            }
        };

        row.connect('notify::selected', () => {
            if (syncing)
                return;

            const value = values[row.selected];
            if (value && settings.get_string(key) !== value)
                settings.set_string(key, value);
        });

        settings.connect(`changed::${key}`, syncSelection);
        syncSelection();

        return row;
    }

    _buildSwitchRow(settings, key, {title, subtitle}) {
        const row = new Adw.SwitchRow({
            title,
            subtitle,
            active: settings.get_boolean(key),
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

    _buildResetGroup(settings, window) {
        const group = new Adw.PreferencesGroup({
            title: _('Reset'),
        });
        const row = new Adw.ActionRow({
            title: _('Reset Settings'),
            subtitle: _('Restore all extension preferences to their default values.'),
        });
        const button = new Gtk.Button({
            label: _('Reset'),
            valign: Gtk.Align.CENTER,
        });
        button.add_css_class('destructive-action');
        button.connect('clicked', () => this._confirmResetSettings(settings, window));

        row.add_suffix(button);
        row.activatable_widget = button;
        group.add(row);

        return group;
    }

    _confirmResetSettings(settings, window) {
        const dialog = new Adw.MessageDialog({
            heading: _('Reset Settings?'),
            body: _('This will restore all AI UsageBar preferences to their default values. Credentials stored in vendor files or GNOME Keyring will not be deleted.'),
            transient_for: window,
            modal: true,
        });

        dialog.add_response('cancel', _('Cancel'));
        dialog.add_response('reset', _('Reset'));
        dialog.set_response_appearance('reset', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.set_default_response('cancel');
        dialog.set_close_response('cancel');
        dialog.connect('response', (_dialog, response) => {
            if (response === 'reset')
                this._resetSettings(settings);
        });
        dialog.present();
    }

    _resetSettings(settings) {
        for (const key of SETTINGS_KEYS)
            settings.reset(key);
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

    _getThresholdTitle(id) {
        switch (id) {
        case UsageThresholdIds.WARNING:
            return _('Warning');
        case UsageThresholdIds.ALERT:
            return _('Alert');
        case UsageThresholdIds.CRITICAL:
            return _('Critical');
        case UsageThresholdIds.CRITICAL_HIGH:
            return _('Critical Reminder');
        case UsageThresholdIds.EXHAUSTED:
            return _('Exhausted');
        default:
            return _('Usage Threshold');
        }
    }

    _getThresholdSubtitle(id) {
        switch (id) {
        case UsageThresholdIds.WARNING:
            return _('Yellow panel text and progress bars.');
        case UsageThresholdIds.ALERT:
            return _('Orange panel text and progress bars.');
        case UsageThresholdIds.CRITICAL:
        case UsageThresholdIds.CRITICAL_HIGH:
            return _('Red panel text and progress bars.');
        case UsageThresholdIds.EXHAUSTED:
            return _('Red panel text when usage is depleted.');
        default:
            return _('Usage threshold notification.');
        }
    }
}
