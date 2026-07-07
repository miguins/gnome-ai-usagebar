import GLib from 'gi://GLib';

import {
    assertEqual,
    assertThrows,
    test,
} from './harness.js';
import {
    UsageSources,
    UsageStatus,
    createUsageState,
    getCurrentSessionUsageMetric,
    getPrimaryUsageMetric,
    usageStateFromJson,
    usageStateToJson,
} from '../lib/usageState.js';
import {
    UsageThresholdDefinitions,
    UsageThresholdIds,
    highestUsageThreshold,
    usageThresholdForPercent,
} from '../lib/usageThresholds.js';

test('usage state validates status values', () => {
    assertThrows(() => createUsageState({status: 'unknown'}), 'Unsupported usage status');
});

test('usage state round trips through cache json', () => {
    const updatedAt = GLib.DateTime.new_from_iso8601('2026-06-04T12:00:00Z', null);
    const state = createUsageState({
        status: UsageStatus.READY,
        summary: '5h 10m remaining',
        plan: 'ChatGPT Plus',
        metrics: [
            {
                kind: 'current-session',
                label: 'Current session (5h)',
                value: '40%',
                detail: 'Resets in 2h',
                percent: 40,
                resetIn: '2h',
                resetAt: '2026-06-04T14:00:00Z',
                resetAtLabel: 'resets 11:00',
            },
        ],
        updatedAt,
    });

    const restored = usageStateFromJson(usageStateToJson(state), UsageSources.CACHE);

    assertEqual(restored.status, UsageStatus.READY);
    assertEqual(restored.statusLabel, 'OK');
    assertEqual(restored.summary, '5h 10m remaining');
    assertEqual(restored.plan, 'ChatGPT Plus');
    assertEqual(restored.metrics.length, 1);
    assertEqual(restored.metrics[0].kind, 'current-session');
    assertEqual(restored.metrics[0].label, 'Current session (5h)');
    assertEqual(restored.metrics[0].percent, 40);
    assertEqual(restored.metrics[0].resetIn, '2h');
    assertEqual(restored.metrics[0].resetAt, '2026-06-04T14:00:00Z');
    assertEqual(restored.metrics[0].resetAtLabel, 'resets 11:00');
    assertEqual(restored.source, UsageSources.CACHE);
    assertEqual(restored.updatedAt.to_unix(), updatedAt.to_unix());
});

test('primary usage metric prefers the current session over higher Claude weekly usage', () => {
    const thresholds = UsageThresholdDefinitions.map(definition => ({
        ...definition,
        enabled: true,
        percent: definition.defaultPercent,
    }));
    const metrics = [
        {label: 'Weekly', percent: 91},
        {kind: 'current-session', label: 'Current session (5h)', percent: 0},
        {kind: 'model-weekly', label: 'Fable weekly', percent: 96},
    ];
    const primary = getPrimaryUsageMetric(metrics);
    const currentSession = getCurrentSessionUsageMetric(metrics);

    assertEqual(primary.label, 'Current session (5h)');
    assertEqual(currentSession.label, 'Current session (5h)');
    assertEqual(usageThresholdForPercent(currentSession.percent, thresholds), null);
    assertEqual(
        highestUsageThreshold(metrics, thresholds).id,
        UsageThresholdIds.CRITICAL_HIGH
    );
});

test('current session metric ignores higher Codex weekly and code review usage', () => {
    const thresholds = UsageThresholdDefinitions.map(definition => ({
        ...definition,
        enabled: true,
        percent: definition.defaultPercent,
    }));
    const metrics = [
        {kind: 'current-session', label: 'Current session (5h)', percent: 0},
        {label: 'Weekly', percent: 94},
        {label: 'Code review', percent: 100},
    ];
    const currentSession = getCurrentSessionUsageMetric(metrics);

    assertEqual(currentSession.label, 'Current session (5h)');
    assertEqual(usageThresholdForPercent(currentSession.percent, thresholds), null);
    assertEqual(
        highestUsageThreshold(metrics, thresholds).id,
        UsageThresholdIds.EXHAUSTED
    );
});
