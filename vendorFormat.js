import GLib from 'gi://GLib';

import {UsageStatus} from './usageState.js';
import {
    VendorLabels,
} from './vendors.js';
import {UsageFetchError} from './vendorErrors.js';

export const CURRENT_SESSION_LABEL = 'Current session (5h)';

const MONTH_NAMES = Object.freeze([
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

export function formatLocalTime(dateTime, format = '%H:%M:%S') {
    if (!dateTime || typeof dateTime.to_unix !== 'function')
        return null;

    const localDateTime = GLib.DateTime.new_from_unix_local(dateTime.to_unix());
    return localDateTime?.format(format) ?? null;
}

export function assertObject(value, _label, vendor = null) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throwMalformed(vendor);
}

export function displayFromMetrics(plan, metrics) {
    const normalizedMetrics = metrics.filter(metric => metric !== null);
    const summaryMetrics = normalizedMetrics
        .map(metric => {
            if (metric.kind === 'current-session')
                return `${metric.value} 5h`;
            if (metric.kind === 'model-weekly')
                return `${metric.value} ${weeklyModelLabel(metric)}`;
            if (metric.label === 'Sonnet weekly')
                return `${metric.value} Sonnet`;
            if (metric.label === 'Code review')
                return `${metric.value} code review`;
            if (metric.label === 'Extra usage')
                return `extra ${metric.value}`;
            if (metric.label === 'Credits')
                return `credits ${metric.value.toLowerCase()}`;

            return `${metric.value} ${metric.label.toLowerCase()}`;
        })
        .join(', ');

    return {
        plan,
        summary: `${plan}: ${summaryMetrics}`,
        metrics: normalizedMetrics,
    };
}

function weeklyModelLabel(metric) {
    if (typeof metric.modelLabel === 'string' && metric.modelLabel.trim().length > 0)
        return metric.modelLabel.trim();

    return metric.label.replace(/\s+weekly$/i, '');
}

export function usageWindowMetric(label, window, field, now, {
    kind = null,
    vendor = null,
} = {}) {
    assertObject(window, `${label} usage window`, vendor);

    const percent = percentFromValue(window[field], {
        clamp: true,
        vendor,
    });
    const reset = windowResetInfo(window, now);

    return {
        kind,
        label,
        value: `${percent}%`,
        percent,
        detail: reset?.detail ?? null,
        resetIn: reset?.resetIn ?? null,
        resetAt: reset?.resetAt ?? null,
        resetAtLabel: reset?.resetAtLabel ?? null,
    };
}

export function windowResetInfo(window, now) {
    if (!window || typeof window !== 'object')
        return null;

    const resetAt = resetTimestamp(window, now);
    if (resetAt === null)
        return null;

    const resetIn = formatDuration(Math.max(0, resetAt - now.to_unix()));
    const resetAtLabel = formatResetAtLabel(resetAt, now);
    const resetAtDateTime = GLib.DateTime.new_from_unix_utc(resetAt);

    return {
        detail: `Resets in ${resetIn} (${resetAtLabel})`,
        resetIn,
        resetAt: resetAtDateTime?.format_iso8601() ?? null,
        resetAtLabel,
    };
}

export function usageRatioPercent(used, limit, vendor = null) {
    const usedNumber = requiredFiniteNumber(used, {vendor});
    const limitNumber = requiredFiniteNumber(limit, {vendor});
    if (limitNumber <= 0)
        return null;

    return Math.min(100, Math.max(0, Math.round((usedNumber / limitNumber) * 100)));
}

export function messageRangeDetail(credits) {
    const parts = [];
    const localRange = formatRange(credits.approx_local_messages);
    const cloudRange = formatRange(credits.approx_cloud_messages);

    if (localRange)
        parts.push(`${localRange} local`);
    if (cloudRange)
        parts.push(`${cloudRange} cloud`);

    return parts.length > 0 ? parts.join(', ') : null;
}

export function percentFromValue(value, {
    clamp = false,
    vendor = null,
} = {}) {
    const percent = Math.round(requiredFiniteNumber(value, {vendor}));
    if (!clamp)
        return Math.max(0, percent);

    return Math.min(100, Math.max(0, percent));
}

export function formatCents(value, vendor = null) {
    const cents = Math.trunc(requiredFiniteNumber(value, {vendor}));
    const sign = cents < 0 ? '-' : '';
    const absolute = Math.abs(cents);
    return `${sign}$${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`;
}

export function formatMoney(value, vendor = null) {
    if (typeof value === 'string' && value.trim().length > 0)
        return value;

    if (typeof value === 'number' && Number.isFinite(value))
        return `$${value.toFixed(2)}`;

    throwMalformed(vendor);
}

export function requiredFiniteNumber(value, {vendor = null} = {}) {
    const number = Number(value);
    if (Number.isFinite(number))
        return number;

    throwMalformed(vendor);
}

export function throwMalformed(vendor) {
    const label = vendor ? VendorLabels[vendor] : 'Vendor';

    throw new UsageFetchError(
        UsageStatus.MALFORMED_RESPONSE,
        `${label} returned usage data in an unexpected shape.`
    );
}

export function capitalize(value) {
    const text = String(value ?? '');
    if (text.length === 0)
        return '';

    return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

function resetTimestamp(window, now) {
    if (typeof window.resets_at === 'string') {
        const dateTime = GLib.DateTime.new_from_iso8601(window.resets_at, null);
        return dateTime ? dateTime.to_unix() : null;
    }

    const resetAt = Number(window.reset_at);
    if (Number.isFinite(resetAt) && resetAt > 0)
        return Math.trunc(resetAt);

    const resetAfter = Number(window.reset_after_seconds);
    if (Number.isFinite(resetAfter) && resetAfter >= 0)
        return now.to_unix() + Math.trunc(resetAfter);

    return null;
}

function formatDuration(totalSeconds) {
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

function formatResetAtLabel(resetAtSeconds, now) {
    const resetAt = GLib.DateTime.new_from_unix_local(resetAtSeconds);
    const localNow = GLib.DateTime.new_from_unix_local(now.to_unix());
    const time = resetAt.format('%H:%M') ?? 'unknown';

    if (isSameLocalDate(resetAt, localNow))
        return `resets ${time}`;

    const month = MONTH_NAMES[resetAt.get_month() - 1] ?? '';
    return `resets ${time} on ${resetAt.get_day_of_month()} ${month}`;
}

function isSameLocalDate(first, second) {
    return first.get_year() === second.get_year() &&
        first.get_month() === second.get_month() &&
        first.get_day_of_month() === second.get_day_of_month();
}

function formatRange(value) {
    if (!Array.isArray(value) || value.length === 0)
        return null;

    const first = Number(value[0]);
    const second = Number(value.length > 1 ? value[1] : value[0]);
    if (!Number.isFinite(first) || !Number.isFinite(second))
        return null;

    return first === second ? `${first}` : `${first}-${second}`;
}
