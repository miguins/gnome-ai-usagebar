import GLib from 'gi://GLib';

import {
    UsageSources,
    UsageStatus,
    createUsageState,
} from './usageState.js';
import {Vendors} from './vendors.js';
import {
    assertCredentialObject,
    needsRefresh,
    readCredentialSource,
    requiredCredentialString,
    requiredResponseString,
} from './vendorCredentials.js';
import {
    CURRENT_SESSION_LABEL,
    assertObject,
    capitalize,
    displayFromMetrics,
    formatMoney,
    messageRangeDetail,
    usageWindowMetric,
} from './vendorFormat.js';

const OpenAI = Object.freeze({
    credentialsRelativePath: '.codex/auth.json',
    usageUrl: 'https://chatgpt.com/backend-api/wham/usage',
    tokenUrl: 'https://auth.openai.com/oauth/token',
    clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
    scope: 'openid profile email',
    userAgent: 'codex-cli',
});

export async function refreshOpenAIUsage({
    session,
    requestJson,
    now,
    credentialBaseDir,
    secretCredentialStore,
}) {
    const credentials = await readCredentialSource({
        vendor: Vendors.OPENAI,
        relativePath: OpenAI.credentialsRelativePath,
        missingSummary: 'Codex credentials are missing. Run `codex login` to sign in, or add a GNOME Keyring OAuth credential.',
        unreadableSummary: 'Codex credentials are unreadable. Run `codex login` to sign in again.',
        credentialBaseDir,
        secretCredentialStore,
    });
    const document = credentials.document;
    const tokens = openAITokensFromDocument(document);
    let planHint = openAIPlanHintFromToken(tokens.idToken);

    if (needsRefresh(openAITokenExpiry(tokens.idToken), now)) {
        const refresh = await requestJson(session, {
            method: 'POST',
            url: OpenAI.tokenUrl,
            vendor: Vendors.OPENAI,
            authFailureSummary: 'Codex token refresh failed. Run `codex login` to sign in again.',
            headers: {
                'Content-Type': 'application/json',
            },
            body: {
                client_id: OpenAI.clientId,
                grant_type: 'refresh_token',
                refresh_token: tokens.refreshToken,
                scope: OpenAI.scope,
            },
        });

        tokens.accessToken = requiredResponseString(
            refresh.access_token,
            Vendors.OPENAI,
            'access token'
        );
        tokens.refreshToken = typeof refresh.refresh_token === 'string'
            ? refresh.refresh_token
            : tokens.refreshToken;
        tokens.idToken = typeof refresh.id_token === 'string'
            ? refresh.id_token
            : tokens.idToken;
        document.tokens.access_token = tokens.accessToken;
        document.tokens.refresh_token = tokens.refreshToken;
        document.tokens.id_token = tokens.idToken;
        planHint = openAIPlanHintFromToken(tokens.idToken);
        await credentials.write(document);
    }

    const headers = {
        Authorization: `Bearer ${tokens.accessToken}`,
        'User-Agent': OpenAI.userAgent,
    };
    if (tokens.accountId)
        headers['ChatGPT-Account-Id'] = tokens.accountId;

    const payload = await requestJson(session, {
        method: 'GET',
        url: OpenAI.usageUrl,
        vendor: Vendors.OPENAI,
        headers,
    });

    const display = buildOpenAIUsageDisplay(payload, {planHint, now});

    return createUsageState({
        status: UsageStatus.READY,
        summary: display.summary,
        plan: display.plan,
        metrics: display.metrics,
        updatedAt: now,
        source: UsageSources.LIVE,
    });
}

export function summarizeOpenAIUsage(payload, {planHint = null} = {}) {
    return buildOpenAIUsageDisplay(payload, {planHint}).summary;
}

export function buildOpenAIUsageDisplay(
    payload,
    {planHint = null, now = GLib.DateTime.new_now_utc()} = {}
) {
    assertObject(payload, 'OpenAI usage response', Vendors.OPENAI);
    assertObject(payload.rate_limit, 'OpenAI rate limit', Vendors.OPENAI);

    const rateLimit = payload.rate_limit;
    const plan = openAIPlanLabel(payload.plan_type ?? planHint);
    const metrics = [
        usageWindowMetric(
            CURRENT_SESSION_LABEL,
            rateLimit.primary_window,
            'used_percent',
            now,
            {
                kind: 'current-session',
                vendor: Vendors.OPENAI,
            }
        ),
        usageWindowMetric('Weekly', rateLimit.secondary_window, 'used_percent', now, {
            vendor: Vendors.OPENAI,
        }),
    ];

    const reviewWindow = payload.code_review_rate_limit?.primary_window;
    if (reviewWindow) {
        metrics.push(usageWindowMetric('Code review', reviewWindow, 'used_percent', now, {
            vendor: Vendors.OPENAI,
        }));
    }

    const credits = payload.credits;
    if (credits) {
        assertObject(credits, 'OpenAI credits', Vendors.OPENAI);
        metrics.push({
            label: 'Credits',
            value: credits.unlimited
                ? 'Unlimited'
                : formatMoney(credits.balance, Vendors.OPENAI),
            detail: messageRangeDetail(credits),
        });
    }

    return displayFromMetrics(plan, metrics);
}

export function decodeJwtPayload(token) {
    if (typeof token !== 'string')
        return null;

    const parts = token.split('.');
    if (parts.length < 2)
        return null;

    try {
        const bytes = GLib.base64_decode(base64UrlToBase64(parts[1]));
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch (error) {
        return null;
    }
}

export function openAIPlanHintFromToken(token) {
    const claims = decodeJwtPayload(token);
    return claims?.['https://api.openai.com/auth']?.chatgpt_plan_type ?? null;
}

function openAITokensFromDocument(document) {
    const tokens = document?.tokens;
    assertCredentialObject(tokens, 'Codex OAuth credentials');

    return {
        accessToken: requiredCredentialString(tokens.access_token, 'access token'),
        refreshToken: requiredCredentialString(tokens.refresh_token, 'refresh token'),
        idToken: requiredCredentialString(tokens.id_token, 'ID token'),
        accountId: typeof tokens.account_id === 'string' ? tokens.account_id : null,
    };
}

function openAITokenExpiry(token) {
    const claims = decodeJwtPayload(token);
    const exp = Number(claims?.exp);
    return Number.isFinite(exp) ? Math.trunc(exp) : 0;
}

function openAIPlanLabel(planType) {
    const suffix = capitalize(String(planType ?? ''));
    return `ChatGPT ${suffix || 'Unknown'}`;
}

function base64UrlToBase64(value) {
    let text = value.replace(/-/g, '+').replace(/_/g, '/');
    while (text.length % 4 !== 0)
        text += '=';
    return text;
}
