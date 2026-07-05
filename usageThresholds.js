export const UsageThresholdIds = Object.freeze({
    WARNING: 'warning',
    ALERT: 'alert',
    CRITICAL: 'critical',
    CRITICAL_HIGH: 'critical-high',
    EXHAUSTED: 'exhausted',
});

export const UsageThresholdDefinitions = Object.freeze([
    Object.freeze({
        id: UsageThresholdIds.WARNING,
        enabledKey: 'warning-threshold-enabled',
        percentKey: 'warning-threshold-percent',
        defaultPercent: 50,
        priority: 10,
        style: 'warning',
    }),
    Object.freeze({
        id: UsageThresholdIds.ALERT,
        enabledKey: 'alert-threshold-enabled',
        percentKey: 'alert-threshold-percent',
        defaultPercent: 80,
        priority: 20,
        style: 'alert',
    }),
    Object.freeze({
        id: UsageThresholdIds.CRITICAL,
        enabledKey: 'critical-threshold-enabled',
        percentKey: 'critical-threshold-percent',
        defaultPercent: 90,
        priority: 30,
        style: 'critical',
    }),
    Object.freeze({
        id: UsageThresholdIds.CRITICAL_HIGH,
        enabledKey: 'critical-high-threshold-enabled',
        percentKey: 'critical-high-threshold-percent',
        defaultPercent: 95,
        priority: 40,
        style: 'critical',
    }),
    Object.freeze({
        id: UsageThresholdIds.EXHAUSTED,
        enabledKey: 'exhausted-threshold-enabled',
        percentKey: 'exhausted-threshold-percent',
        defaultPercent: 100,
        priority: 50,
        style: 'critical',
    }),
]);

export function usageThresholdsFromSettings(settings) {
    return normalizeUsageThresholds(UsageThresholdDefinitions.map(definition => ({
        ...definition,
        enabled: settings.get_boolean(definition.enabledKey),
        percent: settings.get_uint(definition.percentKey),
    })));
}

export function normalizeUsageThresholds(thresholds) {
    if (!Array.isArray(thresholds))
        return [];

    return thresholds
        .map(_normalizeUsageThreshold)
        .filter(threshold => threshold !== null)
        .sort(compareUsageThresholds);
}

export function usageThresholdForPercent(percent, thresholds) {
    const value = Number(percent);
    if (!Number.isFinite(value))
        return null;

    let selected = null;
    for (const threshold of normalizeUsageThresholds(thresholds)) {
        if (value >= threshold.percent &&
            (!selected || compareUsageThresholds(threshold, selected) > 0)) {
            selected = threshold;
        }
    }

    return selected;
}

export function metricUsageThreshold(metric, thresholds) {
    if (!metric || typeof metric !== 'object')
        return null;

    return usageThresholdForPercent(metric.percent, thresholds);
}

export function highestUsageThreshold(metrics, thresholds) {
    if (!Array.isArray(metrics))
        return null;

    let selected = null;
    for (const metric of metrics) {
        const threshold = metricUsageThreshold(metric, thresholds);
        if (threshold && (!selected || compareUsageThresholds(threshold, selected) > 0))
            selected = threshold;
    }

    return selected;
}

export function compareUsageThresholds(first, second) {
    if (!first && !second)
        return 0;
    if (!first)
        return -1;
    if (!second)
        return 1;

    if (first.percent !== second.percent)
        return first.percent - second.percent;

    return first.priority - second.priority;
}

function _normalizeUsageThreshold(threshold) {
    if (!threshold || threshold.enabled === false)
        return null;

    const definition = UsageThresholdDefinitions.find(item => item.id === threshold.id);
    if (!definition)
        return null;

    const percent = _normalizePercent(threshold.percent ?? definition.defaultPercent);
    if (percent === null)
        return null;

    return Object.freeze({
        ...definition,
        percent,
    });
}

function _normalizePercent(value) {
    const percent = Number(value);
    if (!Number.isFinite(percent))
        return null;

    return Math.min(100, Math.max(0, Math.round(percent)));
}
