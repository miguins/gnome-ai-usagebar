import GLib from 'gi://GLib';

export const UsageStatus = Object.freeze({
    NOT_CONFIGURED: 'not-configured',
    READY: 'ready',
    STALE: 'stale',
    UNAUTHENTICATED: 'unauthenticated',
    RATE_LIMITED: 'rate-limited',
    OFFLINE: 'offline',
    UNSUPPORTED_ACCOUNT: 'unsupported-account',
    MALFORMED_RESPONSE: 'malformed-response',
    CACHE_ERROR: 'cache-error',
});

export const UsageSources = Object.freeze({
    LIVE: 'live',
    CACHE: 'cache',
    PLACEHOLDER: 'placeholder',
});

const UsageStatuses = Object.freeze(Object.values(UsageStatus));
const UsageSourceValues = Object.freeze(Object.values(UsageSources));

const StatusLabels = Object.freeze({
    [UsageStatus.NOT_CONFIGURED]: 'Not configured',
    [UsageStatus.READY]: 'OK',
    [UsageStatus.STALE]: 'Stale',
    [UsageStatus.UNAUTHENTICATED]: 'Unauthenticated',
    [UsageStatus.RATE_LIMITED]: 'Rate limited',
    [UsageStatus.OFFLINE]: 'Offline',
    [UsageStatus.UNSUPPORTED_ACCOUNT]: 'Unsupported account',
    [UsageStatus.MALFORMED_RESPONSE]: 'Malformed response',
    [UsageStatus.CACHE_ERROR]: 'Cache error',
});

const DefaultSummaries = Object.freeze({
    [UsageStatus.NOT_CONFIGURED]: 'Credential lookup and usage fetching are not configured yet.',
    [UsageStatus.READY]: 'Usage data is available.',
    [UsageStatus.STALE]: 'Cached usage data is stale.',
    [UsageStatus.UNAUTHENTICATED]: 'Authentication is required before usage can be loaded.',
    [UsageStatus.RATE_LIMITED]: 'The vendor rate limit was reached. Try again later.',
    [UsageStatus.OFFLINE]: 'Network access is unavailable.',
    [UsageStatus.UNSUPPORTED_ACCOUNT]: 'This account type is not supported yet.',
    [UsageStatus.MALFORMED_RESPONSE]: 'The vendor returned usage data in an unexpected shape.',
    [UsageStatus.CACHE_ERROR]: 'Cached usage data could not be used safely.',
});

export function isUsageStatus(value) {
    return UsageStatuses.includes(value);
}

export function isUsageSource(value) {
    return UsageSourceValues.includes(value);
}

export function getUsageStatusLabel(status) {
    return StatusLabels[status] ?? 'Unknown';
}

export function createUsageState({
    status,
    summary = null,
    updatedAt = null,
    source = UsageSources.LIVE,
} = {}) {
    if (!isUsageStatus(status))
        throw new Error(`Unsupported usage status: ${status}`);

    if (!isUsageSource(source))
        throw new Error(`Unsupported usage source: ${source}`);

    return Object.freeze({
        status,
        statusLabel: getUsageStatusLabel(status),
        summary: _normalizeSummary(summary, status),
        updatedAt: normalizeDateTime(updatedAt),
        source,
    });
}

export function createNotConfiguredState(summary = null) {
    return createUsageState({
        status: UsageStatus.NOT_CONFIGURED,
        summary,
        source: UsageSources.PLACEHOLDER,
    });
}

export function createCacheErrorState(summary = null, updatedAt = null) {
    return createUsageState({
        status: UsageStatus.CACHE_ERROR,
        summary,
        updatedAt,
        source: UsageSources.CACHE,
    });
}

export function usageStateToJson(state) {
    if (!state || typeof state !== 'object')
        throw new Error('Usage state must be an object');

    if (!isUsageStatus(state.status))
        throw new Error(`Unsupported usage status: ${state.status}`);

    return {
        status: state.status,
        summary: _normalizeSummary(state.summary, state.status),
        updatedAt: dateTimeToIso8601(state.updatedAt),
    };
}

export function usageStateFromJson(value, source = UsageSources.CACHE) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Cached usage state must be an object');

    return createUsageState({
        status: value.status,
        summary: value.summary,
        updatedAt: value.updatedAt,
        source,
    });
}

export function normalizeDateTime(value) {
    if (!value)
        return null;

    if (typeof value.format_iso8601 === 'function')
        return value;

    if (typeof value !== 'string')
        throw new Error('Date value must be a GLib.DateTime or ISO-8601 string');

    const dateTime = GLib.DateTime.new_from_iso8601(value, null);
    if (!dateTime)
        throw new Error(`Invalid ISO-8601 date: ${value}`);

    return dateTime;
}

export function dateTimeToIso8601(value) {
    const dateTime = normalizeDateTime(value);
    return dateTime?.format_iso8601() ?? null;
}

function _normalizeSummary(summary, status) {
    if (typeof summary === 'string' && summary.trim().length > 0)
        return summary;

    return DefaultSummaries[status] ?? 'Usage state is unavailable.';
}
