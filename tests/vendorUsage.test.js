import GLib from 'gi://GLib';

import {
    assertEqual,
    assertThrows,
    expectedResetAtLabel,
    fakeJwt,
    formatDurationForTest,
    test,
} from './harness.js';
import {
    anthropicPlanLabel,
    buildAnthropicUsageDisplay,
    buildOpenAIUsageDisplay,
    decodeJwtPayload,
    openAIPlanHintFromToken,
    summarizeAnthropicUsage,
    summarizeOpenAIUsage,
} from '../lib/vendorUsage.js';

test('anthropic usage summary includes plan windows, model windows, and extra usage', () => {
    const summary = summarizeAnthropicUsage({
        five_hour: {utilization: 42.7},
        seven_day: {utilization: 27},
        seven_day_sonnet: null,
        seven_day_fable: null,
        seven_day_opus: null,
        limits: [
            {kind: 'session', group: 'session', percent: 43},
            {kind: 'weekly_all', group: 'weekly', percent: 27},
            {
                kind: 'weekly_scoped',
                group: 'weekly',
                percent: 4.2,
                scope: {model: {id: null, display_name: 'Sonnet'}},
            },
            {
                kind: 'weekly_scoped',
                group: 'weekly',
                percent: 12.6,
                scope: {model: {id: null, display_name: 'Fable'}},
            },
        ],
        extra_usage: {
            is_enabled: true,
            monthly_limit: 5000,
            used_credits: 250,
        },
    }, {
        subscriptionType: 'max',
        rateLimitTier: 'default_claude_max_5x',
    });

    assertEqual(
        summary,
        'Max 5x: 43% 5h, 27% weekly, 4% Sonnet, 13% Fable, extra $2.50 / $50.00'
    );
});

test('anthropic usage display returns structured metrics', () => {
    const now = GLib.DateTime.new_from_iso8601('2026-06-04T12:00:00Z', null);
    const display = buildAnthropicUsageDisplay({
        five_hour: {
            utilization: 42.7,
            resets_at: '2026-06-04T14:30:00Z',
        },
        seven_day: {utilization: 27},
    }, {
        subscriptionType: 'max',
        rateLimitTier: 'default_claude_max_5x',
    }, {now});

    assertEqual(display.plan, 'Max 5x');
    assertEqual(display.metrics.length, 2);
    assertEqual(display.metrics[0].kind, 'current-session');
    assertEqual(display.metrics[0].label, 'Current session (5h)');
    assertEqual(display.metrics[0].value, '43%');
    assertEqual(display.metrics[0].percent, 43);
    assertEqual(display.metrics[0].resetIn, '2h 30m');
    assertEqual(
        display.metrics[0].detail,
        `Resets in 2h 30m (${expectedResetAtLabel(display.metrics[0].resetAt, now)})`
    );
});

test('anthropic usage display returns dynamic model weekly metrics', () => {
    const now = GLib.DateTime.new_from_iso8601('2026-06-04T12:00:00Z', null);
    const display = buildAnthropicUsageDisplay({
        five_hour: {utilization: 10},
        seven_day: {utilization: 20},
        seven_day_fable: null,
        seven_day_opus: null,
        limits: [
            {kind: 'session', group: 'session', percent: 10},
            {kind: 'weekly_all', group: 'weekly', percent: 20},
            {
                kind: 'weekly_scoped',
                group: 'weekly',
                percent: 33.3,
                resets_at: '2026-06-05T12:00:00Z',
                scope: {model: {id: null, display_name: 'Fable'}},
            },
            {
                kind: 'weekly_scoped',
                group: 'weekly',
                percent: 44.4,
                scope: {model: {id: null, display_name: 'Mythos Long Context'}},
            },
            {label: 'not a usage window'},
            {
                kind: 'weekly_scoped',
                group: 'weekly',
                percent: 1,
                scope: {model: null},
            },
            null,
        ],
    }, {}, {now});

    assertEqual(
        display.summary,
        'Unknown: 10% 5h, 20% weekly, 33% Fable, 44% Mythos Long Context'
    );
    assertEqual(display.metrics.length, 4);
    assertEqual(display.metrics[2].kind, 'model-weekly');
    assertEqual(display.metrics[2].label, 'Fable weekly');
    assertEqual(display.metrics[2].value, '33%');
    assertEqual(display.metrics[2].percent, 33);
    assertEqual(display.metrics[2].resetIn, '1d');
    assertEqual(display.metrics[3].label, 'Mythos Long Context weekly');
});

test('anthropic plan label handles max tier names', () => {
    assertEqual(anthropicPlanLabel({
        subscriptionType: 'max',
        rateLimitTier: 'default_claude_max_20x',
    }), 'Max 20x');
});

test('anthropic usage display rejects missing required windows', () => {
    assertThrows(
        () => buildAnthropicUsageDisplay({
            seven_day: {utilization: 10},
        }),
        'Claude returned usage data in an unexpected shape'
    );
});

test('openai usage summary includes plan windows and credits', () => {
    const summary = summarizeOpenAIUsage({
        plan_type: 'plus',
        rate_limit: {
            primary_window: {used_percent: 1},
            secondary_window: {used_percent: 0},
        },
        code_review_rate_limit: {
            primary_window: {used_percent: 33},
        },
        credits: {
            balance: 1.5,
            unlimited: false,
        },
    });

    assertEqual(summary, 'ChatGPT Plus: 1% 5h, 0% weekly, 33% code review, credits $1.50');
});

test('openai usage display returns structured metrics', () => {
    const now = GLib.DateTime.new_from_iso8601('2026-06-04T12:00:00Z', null);
    const weeklyResetAt = GLib.DateTime.new(
        GLib.TimeZone.new_local(),
        2026,
        6,
        11,
        10,
        51,
        0
    );
    const display = buildOpenAIUsageDisplay({
        plan_type: 'plus',
        rate_limit: {
            primary_window: {
                used_percent: 1,
                reset_after_seconds: 1800,
            },
            secondary_window: {
                used_percent: 0,
                reset_at: weeklyResetAt.to_unix(),
            },
        },
        credits: {
            balance: '$2.50',
            unlimited: false,
            approx_local_messages: [100, 200],
        },
    }, {now});

    assertEqual(display.plan, 'ChatGPT Plus');
    assertEqual(display.metrics.length, 3);
    assertEqual(display.metrics[0].kind, 'current-session');
    assertEqual(display.metrics[0].label, 'Current session (5h)');
    assertEqual(
        display.metrics[0].detail,
        `Resets in 30m (${expectedResetAtLabel(display.metrics[0].resetAt, now)})`
    );
    assertEqual(
        display.metrics[1].detail,
        `Resets in ${formatDurationForTest(weeklyResetAt.to_unix() - now.to_unix())} (resets 10:51 on 11 Jun)`
    );
    assertEqual(display.metrics[2].label, 'Credits');
    assertEqual(display.metrics[2].detail, '100-200 local');
});

test('openai plan hint is decoded from id token', () => {
    const token = fakeJwt({
        exp: 1780597324,
        'https://api.openai.com/auth': {
            chatgpt_plan_type: 'team',
        },
    });

    assertEqual(decodeJwtPayload(token).exp, 1780597324);
    assertEqual(openAIPlanHintFromToken(token), 'team');
});

test('openai usage display accepts a null secondary window', () => {
    const display = buildOpenAIUsageDisplay({
        plan_type: 'plus',
        rate_limit: {
            primary_window: {used_percent: 10},
            secondary_window: null,
        },
    });

    assertEqual(display.summary, 'ChatGPT Plus: 10% 5h');
    assertEqual(display.metrics.length, 1);
    assertEqual(display.metrics[0].kind, 'current-session');
});

test('openai usage display accepts a missing primary window', () => {
    const display = buildOpenAIUsageDisplay({
        plan_type: 'plus',
        rate_limit: {
            secondary_window: {used_percent: 20},
        },
    });

    assertEqual(display.summary, 'ChatGPT Plus: 20% weekly');
    assertEqual(display.metrics.length, 1);
    assertEqual(display.metrics[0].label, 'Weekly');
});

test('openai usage display rejects malformed available windows', () => {
    assertThrows(
        () => buildOpenAIUsageDisplay({
            plan_type: 'plus',
            rate_limit: {
                primary_window: {used_percent: 10},
                secondary_window: 'invalid',
            },
        }),
        'Codex returned usage data in an unexpected shape'
    );
});
