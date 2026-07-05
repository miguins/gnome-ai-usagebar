import GLib from 'gi://GLib';

import {
    UsageSources,
    UsageStatus,
    createUsageState,
} from './usageState.js';
import {
    VendorCredentialDefaults,
    Vendors,
} from './vendors.js';
import {
    assertCredentialObject,
    needsRefresh,
    positiveResponseNumber,
    readCredentialSource,
    requiredCredentialNumber,
    requiredCredentialString,
    requiredResponseString,
} from './vendorCredentials.js';
import {
    CURRENT_SESSION_LABEL,
    assertObject,
    capitalize,
    displayFromMetrics,
    formatCents,
    usageRatioPercent,
    usageWindowMetric,
} from './vendorFormat.js';

const Anthropic = Object.freeze({
    usageUrl: 'https://api.anthropic.com/api/oauth/usage',
    tokenUrl: 'https://platform.claude.com/v1/oauth/token',
    clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
    betaHeader: 'oauth-2025-04-20',
    userAgent: 'claude-cli/1.0',
});
const ANTHROPIC_WEEKLY_LIMIT_GROUP = 'weekly';

export async function refreshAnthropicUsage({
    session,
    requestJson,
    now,
    credentialBaseDir,
    credentialPath = null,
    useEnvironmentDefaultPaths = true,
    secretCredentialStore,
}) {
    const credentials = await readCredentialSource({
        vendor: Vendors.ANTHROPIC,
        relativePath: VendorCredentialDefaults[Vendors.ANTHROPIC],
        configuredPath: credentialPath,
        missingSummary: 'Claude credentials are missing. Run `claude` to sign in, or add a GNOME Keyring OAuth credential.',
        unreadableSummary: 'Claude credentials are unreadable. Run `claude` to sign in again.',
        credentialBaseDir,
        useEnvironmentDefaultPaths,
        secretCredentialStore,
    });
    const document = credentials.document;
    const oauth = anthropicOauthFromDocument(document);

    if (needsRefresh(Math.floor(oauth.expiresAt / 1000), now)) {
        const refresh = await requestJson(session, {
            method: 'POST',
            url: Anthropic.tokenUrl,
            vendor: Vendors.ANTHROPIC,
            authFailureSummary: 'Claude token refresh failed. Run `claude` to sign in again.',
            headers: {
                'Content-Type': 'application/json',
                'anthropic-beta': Anthropic.betaHeader,
                'User-Agent': Anthropic.userAgent,
            },
            body: {
                grant_type: 'refresh_token',
                client_id: Anthropic.clientId,
                refresh_token: oauth.refreshToken,
            },
        });

        oauth.accessToken = requiredResponseString(
            refresh.access_token,
            Vendors.ANTHROPIC,
            'access token'
        );
        oauth.refreshToken = typeof refresh.refresh_token === 'string'
            ? refresh.refresh_token
            : oauth.refreshToken;
        const expiresIn = positiveResponseNumber(
            refresh.expires_in,
            Vendors.ANTHROPIC,
            'token expiry'
        );
        oauth.expiresAt = now.to_unix() * 1000 +
            Math.trunc(expiresIn * 1000);
        document.claudeAiOauth.accessToken = oauth.accessToken;
        document.claudeAiOauth.refreshToken = oauth.refreshToken;
        document.claudeAiOauth.expiresAt = oauth.expiresAt;
        await credentials.write(document);
    }

    const payload = await requestJson(session, {
        method: 'GET',
        url: Anthropic.usageUrl,
        vendor: Vendors.ANTHROPIC,
        headers: {
            Authorization: `Bearer ${oauth.accessToken}`,
            'anthropic-beta': Anthropic.betaHeader,
        },
    });

    const display = buildAnthropicUsageDisplay(payload, oauth, {now});

    return createUsageState({
        status: UsageStatus.READY,
        summary: display.summary,
        plan: display.plan,
        metrics: display.metrics,
        updatedAt: now,
        source: UsageSources.LIVE,
    });
}

export function summarizeAnthropicUsage(payload, oauth = {}) {
    return buildAnthropicUsageDisplay(payload, oauth).summary;
}

export function buildAnthropicUsageDisplay(
    payload,
    oauth = {},
    {now = null} = {}
) {
    const timestamp = now ?? GLib.DateTime.new_now_utc();
    assertObject(payload, 'Anthropic usage response', Vendors.ANTHROPIC);

    const plan = anthropicPlanLabel(oauth);
    const metrics = [
        usageWindowMetric(
            CURRENT_SESSION_LABEL,
            payload.five_hour,
            'utilization',
            timestamp,
            {
                kind: 'current-session',
                vendor: Vendors.ANTHROPIC,
            }
        ),
        usageWindowMetric('Weekly', payload.seven_day, 'utilization', timestamp, {
            vendor: Vendors.ANTHROPIC,
        }),
    ];

    metrics.push(...anthropicModelWeeklyMetrics(payload, timestamp));

    const extra = payload.extra_usage;
    if (extra?.is_enabled) {
        assertObject(extra, 'Anthropic extra usage', Vendors.ANTHROPIC);
        metrics.push({
            label: 'Extra usage',
            value: `${formatCents(extra.used_credits, Vendors.ANTHROPIC)} / ${formatCents(extra.monthly_limit, Vendors.ANTHROPIC)}`,
            percent: usageRatioPercent(
                extra.used_credits,
                extra.monthly_limit,
                Vendors.ANTHROPIC
            ),
        });
    }

    return displayFromMetrics(plan, metrics);
}

export function anthropicPlanLabel(oauth = {}) {
    const subscriptionType = capitalize(String(oauth.subscriptionType ?? ''));
    let label = subscriptionType || 'Unknown';
    const rateLimitTier = String(oauth.rateLimitTier ?? '');

    if (rateLimitTier.includes('5x'))
        label += ' 5x';
    else if (rateLimitTier.includes('20x'))
        label += ' 20x';

    return label;
}

function anthropicModelWeeklyMetrics(payload, timestamp) {
    const limits = Array.isArray(payload.limits) ? payload.limits : [];

    return limits
        .filter(limit => isAnthropicModelWeeklyLimit(limit))
        .map(limit => {
            const modelLabel = limit.scope.model.display_name.trim();

            return {
                ...usageWindowMetric(
                    `${modelLabel} weekly`,
                    limit,
                    'percent',
                    timestamp,
                    {
                        kind: 'model-weekly',
                        vendor: Vendors.ANTHROPIC,
                    }
                ),
                modelLabel,
            };
        });
}

function isAnthropicModelWeeklyLimit(limit) {
    return limit &&
        typeof limit === 'object' &&
        !Array.isArray(limit) &&
        limit.group === ANTHROPIC_WEEKLY_LIMIT_GROUP &&
        typeof limit.scope?.model?.display_name === 'string' &&
        limit.scope.model.display_name.trim().length > 0;
}

function anthropicOauthFromDocument(document) {
    const oauth = document?.claudeAiOauth;
    assertCredentialObject(oauth, 'Claude OAuth credentials');

    return {
        accessToken: requiredCredentialString(oauth.accessToken, 'access token'),
        refreshToken: requiredCredentialString(oauth.refreshToken, 'refresh token'),
        expiresAt: requiredCredentialNumber(oauth.expiresAt, 'expiry'),
        subscriptionType: oauth.subscriptionType,
        rateLimitTier: oauth.rateLimitTier,
    };
}
