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
    VendorSettings,
    getConfiguredCredentialPath,
    getEnabledVendors,
    isVendor,
} from './vendors.js';
import {refreshVendorUsage} from './vendorUsage.js';
import {formatLocalTime} from './vendorFormat.js';

const DEFAULT_REFRESH_INTERVAL_SECONDS = 300;
const DEFAULT_DROPDOWN_OPACITY_PERCENT = 100;
const METRIC_CONTENT_SPACING = 4;
const METRIC_ROW_SPACING = 10;
const PROGRESS_TRACK_WIDTH = 300;
const RELATIVE_TIME_REFRESH_SECONDS = 60;
const REFRESH_CONTENT_SPACING = 8;
const BUILT_IN_THEME_STYLE_CLASS = 'ai-usagebar-built-in-theme';
const FOLLOW_SYSTEM_THEME_STYLE_CLASS = 'ai-usagebar-follow-system-theme';
const TAB_BUTTON_STYLE_CLASS = 'ai-usagebar-tab';
const TAB_BUTTON_SELECTED_STYLE_CLASS = `${TAB_BUTTON_STYLE_CLASS} ai-usagebar-tab-selected`;
const THEMED_TAB_BUTTON_STYLE_CLASS = `button ${TAB_BUTTON_STYLE_CLASS}`;
const THEMED_TAB_BUTTON_SELECTED_STYLE_CLASS =
    `${THEMED_TAB_BUTTON_STYLE_CLASS} ai-usagebar-tab-selected`;
const REFRESH_BUTTON_STYLE_CLASS = 'ai-usagebar-refresh-button';
const THEMED_REFRESH_BUTTON_STYLE_CLASS = `button ${REFRESH_BUTTON_STYLE_CLASS}`;
const RESET_MONTH_NAMES = Object.freeze([
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
]);

const VendorIconFiles = Object.freeze({
    [Vendors.ANTHROPIC]: 'assets/claude-symbolic.svg',
    [Vendors.OPENAI]: 'assets/codex-symbolic.svg',
});

const AIUsageIndicator = GObject.registerClass(
class AIUsageIndicator extends PanelMenu.Button {
    _init(settings) {
        super._init(0.5, _('AI UsageBar'));

        this._settings = settings;
        this._settingsSignals = [];
        this._menuSignals = [];
        this._menuActorSignals = [];
        this._extensionDir = this._getExtensionDir();
        this._enabledVendors = this._getEnabledVendors();
        this._selectedVendor = this._resolveSelectedVendor(this._getSelectedVendorSetting());
        this._ignoreSelectedVendorSetting = false;
        this._applyingDropdownOpacity = false;
        this._refreshSourceId = 0;
        this._relativeTimeSourceId = 0;
        this._refreshRequestId = 0;
        this._destroyed = false;
        this._usageCache = new UsageCache({
            ttlSeconds: this._getRefreshIntervalSeconds(),
        });
        this._vendorState = Object.fromEntries(
            VendorIds.map(vendor => [vendor, this._createInitialVendorState()])
        );

        this._buildPanelButton();
        this._buildMenu();
        this._applyDropdownOpacity();
        this._applyThemePreference();
        this._bindSettings();
        this._selectVendor(this._selectedVendor, {persist: false});
        this._scheduleRefresh();
        this._scheduleRelativeTimeRefresh();
        this._refreshSelectedVendor();
    }

    _buildPanelButton() {
        this._panelBox = new St.BoxLayout({
            style_class: 'ai-usagebar-panel-box',
        });
        this._panelBox.layout_manager.spacing = 4;
        this._panelIcon = new St.Icon({
            icon_name: 'utilities-system-monitor-symbolic',
            style_class: 'system-status-icon ai-usagebar-panel-icon',
            icon_size: 16,
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
        this._tabBox.layout_manager.spacing = 6;

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

        this._menuSignals.push(
            this.menu.connect('open-state-changed', (_menu, isOpen) => {
                if (isOpen)
                    this._applyDropdownOpacity();
            })
        );
        this._menuActorSignals.push(
            this.menu.actor.connect('notify::opacity', () => {
                if (this.menu.isOpen)
                    this._applyDropdownOpacity();
            })
        );
        this._menuActorSignals.push(
            this.menu.actor.connect(
                'captured-event',
                this._handleMenuCapturedEvent.bind(this)
            )
        );
    }

    _rebuildTabs() {
        for (const child of this._tabBox.get_children())
            child.destroy();

        this._tabButtons.clear();

        if (this._enabledVendors.length === 0) {
            this._tabBox.add_child(new St.Label({
                text: _('No AI providers enabled'),
                style_class: 'ai-usagebar-tab-empty',
                x_expand: true,
            }));
            return;
        }

        for (const vendor of this._enabledVendors) {
            const button = new St.Button({
                style_class: this._getTabButtonStyleClass(vendor === this._selectedVendor),
                reactive: true,
                can_focus: true,
                track_hover: true,
                x_expand: true,
            });
            button.set_child(this._buildVendorLabel(vendor, 'ai-usagebar-tab-icon'));
            button.connect('clicked', () => this._selectVendor(vendor, {refresh: true}));
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
        box.layout_manager.spacing = 10;
        this._overviewIcon = new St.Icon({
            style_class: 'ai-usagebar-overview-icon',
            icon_size: 24,
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
            style_class: this._getRefreshButtonStyleClass(),
            reactive: true,
            can_focus: true,
            track_hover: true,
            x_expand: true,
        });
        this._refreshButton = button;

        const content = new St.BoxLayout({
            style_class: 'ai-usagebar-refresh-content',
            x_expand: true,
        });
        content.add_child(new St.Icon({
            icon_name: 'view-refresh-symbolic',
            style_class: 'ai-usagebar-action-icon',
            icon_size: 16,
        }));
        content.add_child(this._buildHorizontalSpacer(REFRESH_CONTENT_SPACING));
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

    _handleMenuCapturedEvent(_actor, event) {
        const eventType = event.type();
        if (eventType !== Clutter.EventType.BUTTON_RELEASE &&
            eventType !== Clutter.EventType.TOUCH_END)
            return Clutter.EVENT_PROPAGATE;

        const targetActor = global.stage.get_event_actor(event);
        if (!targetActor)
            return Clutter.EVENT_PROPAGATE;

        for (const [vendor, button] of this._tabButtons.entries()) {
            if (button.contains(targetActor)) {
                this._selectVendor(vendor, {refresh: true});
                return Clutter.EVENT_STOP;
            }
        }

        if (this._refreshButton?.contains(targetActor)) {
            this._refreshSelectedVendor({force: true});
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    _bindSettings() {
        this._settingsSignals.push(
            this._settings.connect('changed::selected-vendor', () => {
                if (this._ignoreSelectedVendorSetting)
                    return;

                this._selectVendor(this._getSelectedVendorSetting(), {
                    persist: true,
                    refresh: true,
                });
            })
        );

        this._settingsSignals.push(
            this._settings.connect('changed::refresh-interval-seconds', () => {
                this._scheduleRefresh();
            })
        );

        this._settingsSignals.push(
            this._settings.connect('changed::dropdown-opacity-percent', () => {
                this._applyDropdownOpacity();
            })
        );

        this._settingsSignals.push(
            this._settings.connect('changed::follow-system-theme', () => {
                this._applyThemePreference();
            })
        );

        for (const vendor of VendorIds) {
            this._settingsSignals.push(
                this._settings.connect(`changed::${VendorSettings[vendor].enabled}`, () => {
                    this._handleEnabledVendorsChanged();
                })
            );
            this._settingsSignals.push(
                this._settings.connect(
                    `changed::${VendorSettings[vendor].credentialPath}`,
                    () => this._handleCredentialPathChanged(vendor)
                )
            );
        }
    }

    _selectVendor(vendor, {
        persist = true,
        refresh = false,
    } = {}) {
        vendor = this._resolveSelectedVendor(vendor);

        this._selectedVendor = vendor;

        if (!vendor) {
            this._render();
            return;
        }

        if (persist && this._settings.get_string('selected-vendor') !== vendor) {
            this._ignoreSelectedVendorSetting = true;
            try {
                this._settings.set_string('selected-vendor', vendor);
            } finally {
                this._ignoreSelectedVendorSetting = false;
            }
        }

        for (const [tabVendor, button] of this._tabButtons.entries()) {
            button.set_style_class_name(this._getTabButtonStyleClass(tabVendor === vendor));
        }

        this._render();

        if (refresh)
            this._refreshSelectedVendor();
    }

    _buildVendorLabel(vendor, iconStyleClass) {
        const box = new St.BoxLayout({
            style_class: 'ai-usagebar-vendor-label',
            x_expand: true,
        });
        box.layout_manager.spacing = 6;
        box.add_child(new St.Icon({
            gicon: this._getVendorIcon(vendor),
            style_class: iconStyleClass,
            icon_size: 16,
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
        if (isVendor(vendor) && this._enabledVendors.includes(vendor))
            return vendor;

        return this._enabledVendors[0] ?? null;
    }

    _getSelectedVendorSetting() {
        const vendor = this._settings.get_string('selected-vendor');
        return isVendor(vendor) ? vendor : Vendors.ANTHROPIC;
    }

    _refreshSelectedVendor({force = false} = {}) {
        this._syncEnabledVendors();
        this._selectVendor(this._selectedVendor ?? this._getSelectedVendorSetting(), {
            persist: true,
        });

        if (!this._selectedVendor)
            return;

        if (!force && this._renderCachedSelectedVendor())
            return;

        this._refreshVendorUsage(this._selectedVendor);
    }

    async _refreshVendorUsage(vendor) {
        const requestId = ++this._refreshRequestId;
        const state = await refreshVendorUsage(vendor, {
            credentialPath: getConfiguredCredentialPath(this._settings, vendor),
        });

        if (this._destroyed || requestId !== this._refreshRequestId)
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

    _scheduleRelativeTimeRefresh() {
        if (this._relativeTimeSourceId) {
            GLib.source_remove(this._relativeTimeSourceId);
            this._relativeTimeSourceId = 0;
        }

        this._relativeTimeSourceId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            RELATIVE_TIME_REFRESH_SECONDS,
            () => {
                this._render();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _applyDropdownOpacity() {
        if (!this.menu?.box)
            return;

        const percent = this._getDropdownOpacityPercent();
        this.menu.box.opacity = Math.round((percent / 100) * 255);
    }

    _applyThemePreference() {
        const followSystemTheme = this._getFollowSystemTheme();
        this._setStyleClassPresence(this, BUILT_IN_THEME_STYLE_CLASS, !followSystemTheme);
        this._setStyleClassPresence(this, FOLLOW_SYSTEM_THEME_STYLE_CLASS, followSystemTheme);
        this._setStyleClassPresence(
            this.menu.actor,
            BUILT_IN_THEME_STYLE_CLASS,
            !followSystemTheme
        );
        this._setStyleClassPresence(
            this.menu.actor,
            FOLLOW_SYSTEM_THEME_STYLE_CLASS,
            followSystemTheme
        );

        for (const [vendor, button] of this._tabButtons.entries())
            button.set_style_class_name(
                this._getTabButtonStyleClass(vendor === this._selectedVendor)
            );

        if (this._refreshButton)
            this._refreshButton.set_style_class_name(this._getRefreshButtonStyleClass());
    }

    _setStyleClassPresence(actor, styleClass, enabled) {
        const hasStyleClass = actor.has_style_class_name(styleClass);

        if (enabled && !hasStyleClass)
            actor.add_style_class_name(styleClass);
        else if (!enabled && hasStyleClass)
            actor.remove_style_class_name(styleClass);
    }

    _getTabButtonStyleClass(selected) {
        if (this._getFollowSystemTheme())
            return selected
                ? THEMED_TAB_BUTTON_SELECTED_STYLE_CLASS
                : THEMED_TAB_BUTTON_STYLE_CLASS;

        return selected ? TAB_BUTTON_SELECTED_STYLE_CLASS : TAB_BUTTON_STYLE_CLASS;
    }

    _getRefreshButtonStyleClass() {
        return this._getFollowSystemTheme()
            ? THEMED_REFRESH_BUTTON_STYLE_CLASS
            : REFRESH_BUTTON_STYLE_CLASS;
    }

    _getFollowSystemTheme() {
        return this._settings.get_boolean('follow-system-theme');
    }

    _handleEnabledVendorsChanged() {
        const previousVendor = this._selectedVendor;
        this._syncEnabledVendors();
        this._selectVendor(previousVendor ?? this._getSelectedVendorSetting(), {
            persist: true,
        });

        if (this._selectedVendor && this._selectedVendor !== previousVendor)
            this._refreshSelectedVendor({force: true});
    }

    _handleCredentialPathChanged(vendor) {
        this._vendorState[vendor] = this._createInitialVendorState();

        try {
            this._usageCache.remove(vendor);
        } catch (error) {
            // Cache cleanup is best-effort; refresh will still avoid stale reads.
        }

        if (vendor === this._selectedVendor)
            this._refreshSelectedVendor({force: true});
    }

    _syncEnabledVendors() {
        const enabledVendors = this._getEnabledVendors();
        if (this._areVendorListsEqual(this._enabledVendors, enabledVendors))
            return;

        this._enabledVendors = enabledVendors;
        this._rebuildTabs();
    }

    _getEnabledVendors() {
        return getEnabledVendors(this._settings);
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
            this._overviewTitle.set_text(_('No AI providers enabled'));
            this._overviewSubtitle.set_text(_('Enable Claude or Codex in preferences.'));
            this._setStatusBadge(_('Disabled'), UsageStatus.NOT_CONFIGURED);
            this._setMetricRows([]);
            this._setMessage(_('Usage monitoring needs at least one enabled provider.'));
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
        const primaryMetric = state.metrics?.find(metric => metric.kind === 'current-session') ??
            state.metrics?.find(metric => metric.percent !== null);
        if ((state.status === UsageStatus.READY || state.status === UsageStatus.STALE) &&
            primaryMetric) {
            const resetIn = this._getMetricResetIn(primaryMetric);
            return resetIn ? `${primaryMetric.value} · ${resetIn}` : primaryMetric.value;
        }

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
        metrics.forEach((metric, index) => {
            if (index > 0)
                this._metricsBox.add_child(this._buildVerticalSpacer(METRIC_ROW_SPACING));

            this._metricsBox.add_child(this._buildMetricRow(metric));
        });
    }

    _buildVerticalSpacer(height) {
        return new St.Widget({
            height,
            x_expand: true,
        });
    }

    _buildHorizontalSpacer(width) {
        return new St.Widget({
            width,
        });
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
        top.layout_manager.spacing = 12;
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

        const detail = this._getMetricDetail(metric);
        if (detail) {
            row.add_child(this._buildVerticalSpacer(METRIC_CONTENT_SPACING));
            row.add_child(new St.Label({
                text: detail,
                style_class: 'ai-usagebar-metric-detail',
            }));
        }

        if (metric.percent !== null) {
            row.add_child(this._buildVerticalSpacer(METRIC_CONTENT_SPACING));
            row.add_child(this._buildProgressBar(metric.percent));
        }

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

    _getMetricDetail(metric) {
        const resetIn = this._getMetricResetIn(metric);
        const resetAtLabel = this._getMetricResetAtLabel(metric);

        if (resetIn && resetAtLabel)
            return `Resets in ${resetIn} (${resetAtLabel})`;

        return metric.detail ?? null;
    }

    _getMetricResetIn(metric) {
        const resetAt = this._getMetricResetAt(metric);
        if (!resetAt)
            return metric.resetIn ?? null;

        return this._formatResetDuration(Math.max(
            0,
            resetAt.to_unix() - GLib.DateTime.new_now_utc().to_unix()
        ));
    }

    _getMetricResetAtLabel(metric) {
        const resetAt = this._getMetricResetAt(metric);
        if (!resetAt)
            return metric.resetAtLabel ?? null;

        return this._formatResetAtLabel(resetAt);
    }

    _getMetricResetAt(metric) {
        if (!metric.resetAt)
            return null;

        return GLib.DateTime.new_from_iso8601(metric.resetAt, null);
    }

    _formatResetDuration(totalSeconds) {
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

    _formatResetAtLabel(resetAt) {
        const localResetAt = GLib.DateTime.new_from_unix_local(resetAt.to_unix());
        const localNow = GLib.DateTime.new_now_local();
        const time = localResetAt.format('%H:%M') ?? _('unknown');

        if (this._isSameLocalDate(localResetAt, localNow))
            return `resets ${time}`;

        const month = RESET_MONTH_NAMES[localResetAt.get_month() - 1] ?? '';
        return `resets ${time} on ${localResetAt.get_day_of_month()} ${month}`;
    }

    _isSameLocalDate(first, second) {
        return first.get_year() === second.get_year() &&
            first.get_month() === second.get_month() &&
            first.get_day_of_month() === second.get_day_of_month();
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

    _getDropdownOpacityPercent() {
        return this._settings.get_uint('dropdown-opacity-percent') ||
            DEFAULT_DROPDOWN_OPACITY_PERCENT;
    }

    _formatUpdatedAt(updatedAt) {
        if (!updatedAt)
            return _('Never');

        return formatLocalTime(updatedAt) ?? _('Unknown');
    }

    destroy() {
        this._destroyed = true;
        this._refreshRequestId += 1;

        for (const signalId of this._settingsSignals)
            this._settings.disconnect(signalId);
        this._settingsSignals = [];

        for (const signalId of this._menuSignals)
            this.menu.disconnect(signalId);
        this._menuSignals = [];

        for (const signalId of this._menuActorSignals)
            this.menu.actor.disconnect(signalId);
        this._menuActorSignals = [];

        if (this._refreshSourceId) {
            GLib.source_remove(this._refreshSourceId);
            this._refreshSourceId = 0;
        }

        if (this._relativeTimeSourceId) {
            GLib.source_remove(this._relativeTimeSourceId);
            this._relativeTimeSourceId = 0;
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
