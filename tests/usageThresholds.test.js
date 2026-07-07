import {
    assertEqual,
    test,
} from './harness.js';
import {
    UsageThresholdDefinitions,
    UsageThresholdIds,
    highestUsageThreshold,
    usageThresholdForPercent,
} from '../lib/usageThresholds.js';

test('usage thresholds resolve the highest enabled matching threshold', () => {
    const thresholds = UsageThresholdDefinitions.map(definition => ({
        ...definition,
        enabled: definition.id !== UsageThresholdIds.ALERT,
        percent: definition.defaultPercent,
    }));

    assertEqual(usageThresholdForPercent(49, thresholds), null);
    assertEqual(usageThresholdForPercent(50, thresholds).id, UsageThresholdIds.WARNING);
    assertEqual(usageThresholdForPercent(80, thresholds).id, UsageThresholdIds.WARNING);
    assertEqual(usageThresholdForPercent(90, thresholds).id, UsageThresholdIds.CRITICAL);
    assertEqual(usageThresholdForPercent(95, thresholds).id, UsageThresholdIds.CRITICAL_HIGH);
    assertEqual(usageThresholdForPercent(100, thresholds).id, UsageThresholdIds.EXHAUSTED);
});

test('usage thresholds choose the highest metric severity', () => {
    const thresholds = UsageThresholdDefinitions.map(definition => ({
        ...definition,
        enabled: true,
        percent: definition.defaultPercent,
    }));
    const selected = highestUsageThreshold([
        {label: 'Current session (5h)', percent: 52},
        {label: 'Weekly', percent: 91},
        {label: 'Code review', percent: 79},
    ], thresholds);

    assertEqual(selected.id, UsageThresholdIds.CRITICAL);
});
