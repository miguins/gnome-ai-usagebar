import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {CacheReadStatus, UsageCache} from './cache.js';
import {
    UsageSources,
    UsageStatus,
    createCacheErrorState,
    createNotConfiguredState,
    createUsageState,
} from './usageState.js';
import {
    Vendors,
    VendorIds,
    VendorLabels,
    detectInstalledVendors,
    isVendor,
} from './vendors.js';
import {refreshVendorUsage} from './vendorUsage.js';

const DEFAULT_REFRESH_INTERVAL_SECONDS = 300;
const PROGRESS_TRACK_WIDTH = 300;

const VendorIconFiles = Object.freeze({
    [Vendors.ANTHROPIC]: 'assets/claude-symbolic.svg',
    [Vendors.OPENAI]: 'assets/codex-symbolic.svg',
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
        this._refreshRequestId = 0;
        this._usageCache = new UsageCache({
            ttlSeconds: this._getRefreshIntervalSeconds(),
        });
        this._vendorState = Object.fromEntries(
            VendorIds.map(vendor => [vendor, this._createInitialVendorState()])
        );

        this._buildPanelButton();
        this._buildMenu();
        this._bindSettings();
        this._selectVendor(this._selectedVendor, false);
        this._scheduleRefresh();
        this._refreshSelectedVendor();
    }

    _buildPanelButton() {
        this._panelBox = new St.BoxLayout({
            style_class: 'ai-usagebar-panel-box',
        });
        this._panelIcon = new St.Icon({
            icon_name: 'utilities-system-monitor-symbolic',
            style_class: 'system-status-icon ai-usagebar-panel-icon',
        });

        this._panelLabel = new St.Label({
            style_class: 'ai-usagebar-panel-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._panelBox.add_child(this._panelIcon);
        this._panelBox.add_child(this._panelLabel);
        this.add_child(this._panelBox);
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

        this._buildOverview();
        this._buildMetrics();
        this._buildMessage();
        this._buildFooter();

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._buildRefreshRow();
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

    _buildOverview() {
        const item = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        const box = new St.BoxLayout({
            style_class: 'ai-usagebar-overview',
            x_expand: true,
        });
        this._overviewIcon = new St.Icon({
            style_class: 'ai-usagebar-overview-icon',
        });
        const textBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
        });
        this._overviewTitle = new St.Label({
            style_class: 'ai-usagebar-overview-title',
            x_expand: true,
        });
        this._overviewSubtitle = new St.Label({
            style_class: 'ai-usagebar-overview-subtitle',
            x_expand: true,
        });
        this._statusBadge = new St.Label({
            style_class: 'ai-usagebar-status-badge',
            y_align: Clutter.ActorAlign.CENTER,
        });

        textBox.add_child(this._overviewTitle);
        textBox.add_child(this._overviewSubtitle);
        box.add_child(this._overviewIcon);
        box.add_child(textBox);
        box.add_child(this._statusBadge);
        item.add_child(box);
        this.menu.addMenuItem(item);
    }

    _buildMetrics() {
        this._metricsItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        this._metricsBox = new St.BoxLayout({
            vertical: true,
            style_class: 'ai-usagebar-metrics',
            x_expand: true,
        });
        this._metricsItem.add_child(this._metricsBox);
        this.menu.addMenuItem(this._metricsItem);
    }

    _buildMessage() {
        this._messageItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        this._messageLabel = new St.Label({
            style_class: 'ai-usagebar-message',
            x_expand: true,
        });
        this._messageLabel.clutter_text.line_wrap = true;
        this._messageLabel.clutter_text.ellipsize = 0;
        this._messageItem.add_child(this._messageLabel);
        this.menu.addMenuItem(this._messageItem);
    }

    _buildFooter() {
        const item = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        this._footerLabel = new St.Label({
            style_class: 'ai-usagebar-footer',
            x_expand: true,
        });
        item.add_child(this._footerLabel);
        this.menu.addMenuItem(item);
    }

    _buildRefreshRow() {
        const item = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        const box = new St.BoxLayout({
            style_class: 'ai-usagebar-actions',
            x_expand: true,
        });
        const button = new St.Button({
            style_class: 'ai-usagebar-refresh-button',
            can_focus: true,
            track_hover: true,
            x_expand: true,
        });
        const content = new St.BoxLayout({
            style_class: 'ai-usagebar-refresh-content',
            x_expand: true,
        });
        content.add_child(new St.Icon({
            icon_name: 'view-refresh-symbolic',
            style_class: 'ai-usagebar-action-icon',
        }));
        content.add_child(new St.Label({
            text: _('Refresh'),
            y_align: Clutter.ActorAlign.CENTER,
        }));
        button.set_child(content);
        button.connect('clicked', () => this._refreshSelectedVendor({force: true}));

        box.add_child(button);
        item.add_child(box);
        this.menu.addMenuItem(item);
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

    _refreshSelectedVendor({force = false} = {}) {
        this._detectInstalledVendors();
        this._selectVendor(this._selectedVendor ?? this._getSelectedVendorSetting(), false);

        if (!this._selectedVendor)
            return;

        if (!force && this._renderCachedSelectedVendor())
            return;

        this._refreshVendorUsage(this._selectedVendor);
    }

    async _refreshVendorUsage(vendor) {
        const requestId = ++this._refreshRequestId;
        const state = await refreshVendorUsage(vendor);

        if (requestId !== this._refreshRequestId)
            return;

        this._vendorState[vendor] = state;
        if (state.status === UsageStatus.READY)
            this._writeUsageCache(vendor, state);

        this._render();
    }

    _scheduleRefresh() {
        if (this._refreshSourceId) {
            GLib.source_remove(this._refreshSourceId);
            this._refreshSourceId = 0;
        }

        const intervalSeconds = this._getRefreshIntervalSeconds();
        this._usageCache.ttlSeconds = intervalSeconds;

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
            this._panelIcon.gicon = Gio.ThemedIcon.new('utilities-system-monitor-symbolic');
            this._panelLabel.set_text(_('AI'));
            this._overviewIcon.gicon = Gio.ThemedIcon.new('utilities-system-monitor-symbolic');
            this._overviewTitle.set_text(_('No supported tools detected'));
            this._overviewSubtitle.set_text(_('Install Claude Code or Codex CLI.'));
            this._setStatusBadge(_('Not detected'), UsageStatus.NOT_CONFIGURED);
            this._setMetricRows([]);
            this._setMessage(_('Usage monitoring needs a supported local CLI.'));
            this._footerLabel.set_text(_('Last refresh: Never'));
            return;
        }

        const label = VendorLabels[this._selectedVendor];
        const state = this._vendorState[this._selectedVendor];
        const statusLabel = this._getUsageStatusLabel(state);

        this._panelIcon.gicon = this._getVendorIcon(this._selectedVendor);
        this._panelLabel.set_text(this._getPanelText(label, state, statusLabel));
        this._overviewIcon.gicon = this._getVendorIcon(this._selectedVendor);
        this._overviewTitle.set_text(state.plan ?? label);
        this._overviewSubtitle.set_text(this._getOverviewSubtitle(label, state));
        this._setStatusBadge(statusLabel, state.status);
        this._setMetricRows(state.metrics);
        this._setMessage(this._getMessageText(state));
        this._footerLabel.set_text(this._getFooterText(state));
    }

    _getPanelText(label, state, statusLabel) {
        const primaryMetric = state.metrics?.find(metric => metric.label === '5h session') ??
            state.metrics?.find(metric => metric.percent !== null);
        if ((state.status === UsageStatus.READY || state.status === UsageStatus.STALE) &&
            primaryMetric)
            return primaryMetric.value;

        return `${label}: ${statusLabel}`;
    }

    _getOverviewSubtitle(label, state) {
        if (state.status === UsageStatus.READY)
            return label;

        if (state.status === UsageStatus.STALE)
            return `${label} · ${_('cached data')}`;

        return label;
    }

    _getMessageText(state) {
        if (state.metrics.length > 0 &&
            (state.status === UsageStatus.READY || state.status === UsageStatus.STALE))
            return null;

        return state.summary;
    }

    _getFooterText(state) {
        const source = this._getSourceLabel(state.source);
        const updated = this._formatUpdatedAt(state.updatedAt);
        return _('Last refresh: ') + updated + ' · ' + source;
    }

    _getSourceLabel(source) {
        switch (source) {
        case UsageSources.LIVE:
            return _('Live');
        case UsageSources.CACHE:
            return _('Cached');
        case UsageSources.PLACEHOLDER:
            return _('Waiting');
        default:
            return _('Unknown');
        }
    }

    _setStatusBadge(text, status) {
        this._statusBadge.set_text(text);
        this._statusBadge.set_style_class_name(
            `ai-usagebar-status-badge ${this._getStatusStyleClass(status)}`
        );
    }

    _getStatusStyleClass(status) {
        switch (status) {
        case UsageStatus.READY:
            return 'ai-usagebar-status-ready';
        case UsageStatus.STALE:
            return 'ai-usagebar-status-stale';
        case UsageStatus.RATE_LIMITED:
        case UsageStatus.OFFLINE:
            return 'ai-usagebar-status-warning';
        case UsageStatus.UNAUTHENTICATED:
        case UsageStatus.UNSUPPORTED_ACCOUNT:
        case UsageStatus.MALFORMED_RESPONSE:
        case UsageStatus.CACHE_ERROR:
            return 'ai-usagebar-status-error';
        default:
            return 'ai-usagebar-status-neutral';
        }
    }

    _setMetricRows(metrics) {
        for (const child of this._metricsBox.get_children())
            child.destroy();

        if (!metrics || metrics.length === 0) {
            this._metricsItem.hide();
            return;
        }

        this._metricsItem.show();
        for (const metric of metrics)
            this._metricsBox.add_child(this._buildMetricRow(metric));
    }

    _buildMetricRow(metric) {
        const row = new St.BoxLayout({
            vertical: true,
            style_class: 'ai-usagebar-metric-row',
            x_expand: true,
        });
        const top = new St.BoxLayout({
            style_class: 'ai-usagebar-metric-top',
            x_expand: true,
        });
        top.add_child(new St.Label({
            text: metric.label,
            style_class: 'ai-usagebar-metric-label',
            x_expand: true,
        }));
        top.add_child(new St.Label({
            text: metric.value,
            style_class: 'ai-usagebar-metric-value',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        row.add_child(top);

        if (metric.detail) {
            row.add_child(new St.Label({
                text: metric.detail,
                style_class: 'ai-usagebar-metric-detail',
            }));
        }

        if (metric.percent !== null)
            row.add_child(this._buildProgressBar(metric.percent));

        return row;
    }

    _buildProgressBar(percent) {
        const fillWidth = percent <= 0
            ? 0
            : Math.max(3, Math.round((PROGRESS_TRACK_WIDTH * percent) / 100));
        const track = new St.BoxLayout({
            style_class: 'ai-usagebar-progress-track',
            width: PROGRESS_TRACK_WIDTH,
            height: 6,
        });
        track.add_child(new St.Widget({
            style_class: `ai-usagebar-progress-fill ${this._getProgressStyleClass(percent)}`,
            width: fillWidth,
            height: 6,
        }));

        return track;
    }

    _getProgressStyleClass(percent) {
        if (percent >= 85)
            return 'ai-usagebar-progress-critical';
        if (percent >= 60)
            return 'ai-usagebar-progress-warning';

        return 'ai-usagebar-progress-ok';
    }

    _setMessage(text) {
        if (!text) {
            this._messageItem.hide();
            return;
        }

        this._messageLabel.set_text(text);
        this._messageItem.show();
    }

    _renderCachedSelectedVendor() {
        const vendor = this._selectedVendor;
        const result = this._usageCache.read(vendor);

        switch (result.status) {
        case CacheReadStatus.HIT:
            this._vendorState[vendor] = result.state;
            this._render();
            return result.state.metrics.length > 0;
        case CacheReadStatus.STALE:
            this._vendorState[vendor] = createUsageState({
                status: UsageStatus.STALE,
                summary: result.state.summary,
                plan: result.state.plan,
                metrics: result.state.metrics,
                updatedAt: result.state.updatedAt,
                source: UsageSources.CACHE,
            });
            this._render();
            return false;
        case CacheReadStatus.INVALID_PERMISSIONS:
            this._vendorState[vendor] = createCacheErrorState(
                _('Cache file permissions are unsafe; refusing to read cached usage data.'),
                GLib.DateTime.new_now_local()
            );
            this._render();
            return true;
        case CacheReadStatus.MALFORMED:
            this._vendorState[vendor] = createUsageState({
                status: UsageStatus.MALFORMED_RESPONSE,
                summary: _('Cached usage data is malformed; refresh cannot safely use it.'),
                updatedAt: GLib.DateTime.new_now_local(),
                source: UsageSources.CACHE,
            });
            this._render();
            return true;
        case CacheReadStatus.ERROR:
            this._vendorState[vendor] = createCacheErrorState(
                _('Cached usage data could not be read safely.'),
                GLib.DateTime.new_now_local()
            );
            this._render();
            return true;
        case CacheReadStatus.MISS:
        default:
            return false;
        }
    }

    _createInitialVendorState() {
        return createNotConfiguredState(
            _('Usage will load from vendor-managed credentials on refresh.')
        );
    }

    _writeUsageCache(vendor, state) {
        try {
            this._usageCache.write(vendor, state);
        } catch (error) {
            this._vendorState[vendor] = createCacheErrorState(
                _('Usage loaded, but the cache could not be updated safely.'),
                GLib.DateTime.new_now_local()
            );
        }
    }

    _getUsageStatusLabel(state) {
        switch (state.status) {
        case UsageStatus.NOT_CONFIGURED:
            return _('Not configured');
        case UsageStatus.READY:
            return _('OK');
        case UsageStatus.STALE:
            return _('Stale');
        case UsageStatus.UNAUTHENTICATED:
            return _('Unauthenticated');
        case UsageStatus.RATE_LIMITED:
            return _('Rate limited');
        case UsageStatus.OFFLINE:
            return _('Offline');
        case UsageStatus.UNSUPPORTED_ACCOUNT:
            return _('Unsupported account');
        case UsageStatus.MALFORMED_RESPONSE:
            return _('Malformed response');
        case UsageStatus.CACHE_ERROR:
            return _('Cache error');
        default:
            return state.statusLabel ?? _('Unknown');
        }
    }

    _getRefreshIntervalSeconds() {
        return this._settings.get_uint('refresh-interval-seconds') ||
            DEFAULT_REFRESH_INTERVAL_SECONDS;
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
