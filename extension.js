import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {
    Vendors,
    VendorIds,
    VendorLabels,
    detectInstalledVendors,
    isVendor,
} from './vendors.js';

const DEFAULT_REFRESH_INTERVAL_SECONDS = 300;

const VendorIconFiles = Object.freeze({
    [Vendors.ANTHROPIC]: 'assets/claude-symbolic.svg',
    [Vendors.OPENAI]: 'assets/codex-symbolic.svg',
});

const InitialVendorState = Object.freeze({
    status: 'Not configured',
    summary: 'Credential lookup and usage fetching are planned for the next implementation step.',
    updatedAt: null,
});

const AIUsageIndicator = GObject.registerClass(
class AIUsageIndicator extends PanelMenu.Button {
    _init(settings) {
        super._init(0.0, _('AI UsageBar'));

        this._settings = settings;
        this._settingsSignals = [];
        this._extensionDir = this._getExtensionDir();
        this._installedVendors = detectInstalledVendors();
        this._selectedVendor = this._resolveSelectedVendor(this._getSelectedVendorSetting());
        this._refreshSourceId = 0;
        this._vendorState = Object.fromEntries(
            VendorIds.map(vendor => [vendor, {...InitialVendorState}])
        );

        this._buildPanelButton();
        this._buildMenu();
        this._bindSettings();
        this._selectVendor(this._selectedVendor, false);
        this._scheduleRefresh();
    }

    _buildPanelButton() {
        this._panelIcon = new St.Icon({
            icon_name: 'utilities-system-monitor-symbolic',
            style_class: 'system-status-icon',
        });
        this.add_child(this._panelIcon);

        this._panelLabel = new St.Label({
            style_class: 'ai-usagebar-panel-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._panelLabel);
    }

    _buildMenu() {
        const tabItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        this._tabBox = new St.BoxLayout({
            style_class: 'ai-usagebar-tabs',
            x_expand: true,
        });

        this._tabButtons = new Map();
        this._rebuildTabs();

        tabItem.add_child(this._tabBox);
        this.menu.addMenuItem(tabItem);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._statusLabel = this._addReadOnlyRow(_('Status'));
        this._summaryLabel = this._addReadOnlyRow(_('Usage'));
        this._updatedAtLabel = this._addReadOnlyRow(_('Last Refresh'));

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const refreshItem = new PopupMenu.PopupMenuItem(_('Refresh'));
        refreshItem.connect('activate', () => this._refreshSelectedVendor());
        this.menu.addMenuItem(refreshItem);
    }

    _rebuildTabs() {
        for (const child of this._tabBox.get_children())
            child.destroy();

        this._tabButtons.clear();

        if (this._installedVendors.length === 0) {
            this._tabBox.add_child(new St.Label({
                text: _('No supported tools detected'),
                style_class: 'ai-usagebar-tab-empty',
                x_expand: true,
            }));
            return;
        }

        for (const vendor of this._installedVendors) {
            const button = new St.Button({
                style_class: 'ai-usagebar-tab',
                can_focus: true,
                x_expand: true,
            });
            button.set_child(this._buildVendorLabel(vendor, 'ai-usagebar-tab-icon'));
            button.connect('clicked', () => this._selectVendor(vendor));
            this._tabButtons.set(vendor, button);
            this._tabBox.add_child(button);
        }
    }

    _addReadOnlyRow(title) {
        const item = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        const box = new St.BoxLayout({
            vertical: true,
            style_class: 'ai-usagebar-row',
            x_expand: true,
        });
        const titleLabel = new St.Label({
            text: title,
            style_class: 'ai-usagebar-row-title',
        });
        const valueLabel = new St.Label({
            style_class: 'ai-usagebar-row-value',
            x_expand: true,
        });
        valueLabel.clutter_text.line_wrap = true;
        valueLabel.clutter_text.ellipsize = 0;

        box.add_child(titleLabel);
        box.add_child(valueLabel);
        item.add_child(box);
        this.menu.addMenuItem(item);

        return valueLabel;
    }

    _bindSettings() {
        this._settingsSignals.push(
            this._settings.connect('changed::selected-vendor', () => {
                this._selectVendor(this._getSelectedVendorSetting(), false);
            })
        );

        this._settingsSignals.push(
            this._settings.connect('changed::refresh-interval-seconds', () => {
                this._scheduleRefresh();
            })
        );
    }

    _selectVendor(vendor, persist = true) {
        vendor = this._resolveSelectedVendor(vendor);

        this._selectedVendor = vendor;

        if (!vendor) {
            this._render();
            return;
        }

        if (persist && this._settings.get_string('selected-vendor') !== vendor)
            this._settings.set_string('selected-vendor', vendor);

        for (const [tabVendor, button] of this._tabButtons.entries()) {
            button.set_style_class_name(tabVendor === vendor
                ? 'ai-usagebar-tab ai-usagebar-tab-selected'
                : 'ai-usagebar-tab');
        }

        this._render();
    }

    _buildVendorLabel(vendor, iconStyleClass) {
        const box = new St.BoxLayout({
            style_class: 'ai-usagebar-vendor-label',
            x_expand: true,
        });
        box.add_child(new St.Icon({
            gicon: this._getVendorIcon(vendor),
            style_class: iconStyleClass,
        }));
        box.add_child(new St.Label({
            text: VendorLabels[vendor],
            y_align: Clutter.ActorAlign.CENTER,
        }));

        return box;
    }

    _getVendorIcon(vendor) {
        const iconFile = VendorIconFiles[vendor];
        if (!iconFile)
            return Gio.ThemedIcon.new('utilities-system-monitor-symbolic');

        return new Gio.FileIcon({
            file: Gio.File.new_for_path(this._resolveExtensionAsset(iconFile)),
        });
    }

    _resolveExtensionAsset(relativePath) {
        const sourcePath = this._buildExtensionPath(relativePath);
        if (GLib.file_test(sourcePath, GLib.FileTest.EXISTS))
            return sourcePath;

        return this._buildExtensionPath(GLib.path_get_basename(relativePath));
    }

    _buildExtensionPath(relativePath) {
        return GLib.build_filenamev([
            this._extensionDir,
            ...relativePath.split('/'),
        ]);
    }

    _getExtensionDir() {
        const [filename] = GLib.filename_from_uri(import.meta.url);
        return GLib.path_get_dirname(filename);
    }

    _resolveSelectedVendor(vendor) {
        if (isVendor(vendor) && this._installedVendors.includes(vendor))
            return vendor;

        return this._installedVendors[0] ?? null;
    }

    _getSelectedVendorSetting() {
        const vendor = this._settings.get_string('selected-vendor');
        return isVendor(vendor) ? vendor : Vendors.ANTHROPIC;
    }

    _refreshSelectedVendor() {
        this._detectInstalledVendors();
        this._selectVendor(this._selectedVendor ?? this._getSelectedVendorSetting(), false);

        if (!this._selectedVendor)
            return;

        const state = this._vendorState[this._selectedVendor];
        state.status = _('Not configured');
        state.summary = _('Credential lookup and usage fetching are not implemented yet.');
        state.updatedAt = GLib.DateTime.new_now_local();

        this._render();
    }

    _scheduleRefresh() {
        if (this._refreshSourceId) {
            GLib.source_remove(this._refreshSourceId);
            this._refreshSourceId = 0;
        }

        const intervalSeconds = this._settings.get_uint('refresh-interval-seconds') ||
            DEFAULT_REFRESH_INTERVAL_SECONDS;

        this._refreshSourceId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            intervalSeconds,
            () => {
                this._refreshSelectedVendor();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _detectInstalledVendors() {
        const installedVendors = detectInstalledVendors();
        if (this._areVendorListsEqual(this._installedVendors, installedVendors))
            return;

        this._installedVendors = installedVendors;
        this._rebuildTabs();
    }

    _areVendorListsEqual(first, second) {
        return first.length === second.length &&
            first.every((vendor, index) => vendor === second[index]);
    }

    _render() {
        if (!this._selectedVendor) {
            this._panelLabel.set_text(_('AI: Not detected'));
            this._statusLabel.set_text(_('No supported tools detected'));
            this._summaryLabel.set_text(_('Install Claude Code or Codex CLI to enable usage monitoring.'));
            this._updatedAtLabel.set_text(_('Never'));
            return;
        }

        const label = VendorLabels[this._selectedVendor];
        const state = this._vendorState[this._selectedVendor];

        this._panelIcon.gicon = this._getVendorIcon(this._selectedVendor);
        this._panelLabel.set_text(`${label}: ${state.status}`);
        this._statusLabel.set_text(state.status);
        this._summaryLabel.set_text(state.summary);
        this._updatedAtLabel.set_text(this._formatUpdatedAt(state.updatedAt));
    }

    _formatUpdatedAt(updatedAt) {
        if (!updatedAt)
            return _('Never');

        return updatedAt.format('%H:%M:%S') ?? _('Unknown');
    }

    destroy() {
        for (const signalId of this._settingsSignals)
            this._settings.disconnect(signalId);
        this._settingsSignals = [];

        if (this._refreshSourceId) {
            GLib.source_remove(this._refreshSourceId);
            this._refreshSourceId = 0;
        }

        super.destroy();
    }
});

export default class AIUsageBarExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._indicator = new AIUsageIndicator(this._settings);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
    }
}
