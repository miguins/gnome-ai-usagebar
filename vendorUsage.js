import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {
    UsageSources,
    UsageStatus,
    createUsageState,
} from './usageState.js';
import {
    Vendors,
    VendorLabels,
    isVendor,
} from './vendors.js';

const REFRESH_BUFFER_SECONDS = 300;
const HTTP_TIMEOUT_SECONDS = 10;
const OWNER_ONLY_FILE_MODE = 0o600;
const UNSAFE_PERMISSION_MASK = 0o077;

const Anthropic = Object.freeze({
    credentialsRelativePath: '.claude/.credentials.json',
    usageUrl: 'https://api.anthropic.com/api/oauth/usage',
    tokenUrl: 'https://platform.claude.com/v1/oauth/token',
    clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
    betaHeader: 'oauth-2025-04-20',
    userAgent: 'claude-cli/1.0',
});

const OpenAI = Object.freeze({
    credentialsRelativePath: '.codex/auth.json',
    usageUrl: 'https://chatgpt.com/backend-api/wham/usage',
    tokenUrl: 'https://auth.openai.com/oauth/token',
    clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
    scope: 'openid profile email',
    userAgent: 'codex-cli',
});

class UsageFetchError extends Error {
    constructor(status, summary) {
        super(summary);
        this.status = status;
        this.summary = summary;
    }
}

export async function refreshVendorUsage(vendor, {
    session = null,
    now = GLib.DateTime.new_now_utc(),
} = {}) {
    if (!isVendor(vendor)) {
        return _errorState(
            UsageStatus.UNSUPPORTED_ACCOUNT,
            'Unsupported vendor.',
            now
        );
    }

    const httpSession = session ?? _createHttpSession();

    try {
        switch (vendor) {
        case Vendors.ANTHROPIC:
            return await _refreshAnthropicUsage(httpSession, now);
        case Vendors.OPENAI:
            return await _refreshOpenAIUsage(httpSession, now);
        default:
            return _errorState(
                UsageStatus.UNSUPPORTED_ACCOUNT,
                `${VendorLabels[vendor] ?? 'This vendor'} is not supported yet.`,
                now
            );
        }
    } catch (error) {
        if (error instanceof UsageFetchError)
            return _errorState(error.status, error.summary, now);

        return _errorState(
            UsageStatus.MALFORMED_RESPONSE,
            `${VendorLabels[vendor] ?? 'Vendor'} usage refresh failed unexpectedly.`,
            now
        );
    }
}

export function summarizeAnthropicUsage(payload, oauth = {}) {
    return buildAnthropicUsageDisplay(payload, oauth).summary;
}

export function buildAnthropicUsageDisplay(
    payload,
    oauth = {},
    {now = GLib.DateTime.new_now_utc()} = {}
) {
    _assertObject(payload, 'Anthropic usage response');

    const plan = anthropicPlanLabel(oauth);
    const metrics = [
        _usageWindowMetric('5h session', payload.five_hour, 'utilization', now),
        _usageWindowMetric('Weekly', payload.seven_day, 'utilization', now),
    ];

    if (payload.seven_day_sonnet) {
        metrics.push(_usageWindowMetric(
            'Sonnet weekly',
            payload.seven_day_sonnet,
            'utilization',
            now
        ));
    }

    const extra = payload.extra_usage;
    if (extra?.is_enabled) {
        metrics.push({
            label: 'Extra usage',
            value: `${_formatCents(extra.used_credits)} / ${_formatCents(extra.monthly_limit)}`,
            percent: _usageRatioPercent(extra.used_credits, extra.monthly_limit),
        });
    }

    return _displayFromMetrics(plan, metrics);
}

export function summarizeOpenAIUsage(payload, {planHint = null} = {}) {
    return buildOpenAIUsageDisplay(payload, {planHint}).summary;
}

export function buildOpenAIUsageDisplay(
    payload,
    {planHint = null, now = GLib.DateTime.new_now_utc()} = {}
) {
    _assertObject(payload, 'OpenAI usage response');

    const rateLimit = payload.rate_limit ?? {};
    const plan = _openAIPlanLabel(payload.plan_type ?? planHint);
    const metrics = [
        _usageWindowMetric('5h session', rateLimit.primary_window, 'used_percent', now),
        _usageWindowMetric('Weekly', rateLimit.secondary_window, 'used_percent', now),
    ];

    const reviewWindow = payload.code_review_rate_limit?.primary_window;
    if (reviewWindow)
        metrics.push(_usageWindowMetric('Code review', reviewWindow, 'used_percent', now));

    const credits = payload.credits;
    if (credits) {
        metrics.push({
            label: 'Credits',
            value: credits.unlimited ? 'Unlimited' : _formatMoney(credits.balance),
            detail: _messageRangeDetail(credits),
        });
    }

    return _displayFromMetrics(plan, metrics);
}

export function decodeJwtPayload(token) {
    if (typeof token !== 'string')
        return null;

    const parts = token.split('.');
    if (parts.length < 2)
        return null;

    try {
        const bytes = GLib.base64_decode(_base64UrlToBase64(parts[1]));
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch (error) {
        return null;
    }
}

export function anthropicPlanLabel(oauth = {}) {
    const subscriptionType = _capitalize(String(oauth.subscriptionType ?? ''));
    let label = subscriptionType || 'Unknown';
    const rateLimitTier = String(oauth.rateLimitTier ?? '');

    if (rateLimitTier.includes('5x'))
        label += ' 5x';
    else if (rateLimitTier.includes('20x'))
        label += ' 20x';

    return label;
}

export function openAIPlanHintFromToken(token) {
    const claims = decodeJwtPayload(token);
    return claims?.['https://api.openai.com/auth']?.chatgpt_plan_type ?? null;
}

async function _refreshAnthropicUsage(session, now) {
    const path = _credentialPath(Anthropic.credentialsRelativePath);
    const document = _readCredentialDocument(
        path,
        'Claude credentials are missing. Run `claude` to sign in.',
        'Claude credentials are unreadable. Run `claude` to sign in again.'
    );
    const oauth = _anthropicOauthFromDocument(document);

    if (_needsRefresh(Math.floor(oauth.expiresAt / 1000), now)) {
        const refresh = await _requestJson(session, {
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

        oauth.accessToken = _requiredResponseString(
            refresh.access_token,
            Vendors.ANTHROPIC,
            'access token'
        );
        oauth.refreshToken = typeof refresh.refresh_token === 'string'
            ? refresh.refresh_token
            : oauth.refreshToken;
        const expiresIn = _positiveResponseNumber(
            refresh.expires_in,
            Vendors.ANTHROPIC,
            'token expiry'
        );
        oauth.expiresAt = now.to_unix() * 1000 +
            Math.trunc(expiresIn * 1000);
        document.claudeAiOauth.accessToken = oauth.accessToken;
        document.claudeAiOauth.refreshToken = oauth.refreshToken;
        document.claudeAiOauth.expiresAt = oauth.expiresAt;
        _writeCredentialDocument(path, document);
    }

    const payload = await _requestJson(session, {
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

async function _refreshOpenAIUsage(session, now) {
    const path = _credentialPath(OpenAI.credentialsRelativePath);
    const document = _readCredentialDocument(
        path,
        'Codex credentials are missing. Run `codex login` to sign in.',
        'Codex credentials are unreadable. Run `codex login` to sign in again.'
    );
    const tokens = _openAITokensFromDocument(document);
    let planHint = openAIPlanHintFromToken(tokens.idToken);

    if (_needsRefresh(_openAITokenExpiry(tokens.idToken), now)) {
        const refresh = await _requestJson(session, {
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

        tokens.accessToken = _requiredResponseString(
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
        _writeCredentialDocument(path, document);
    }

    const headers = {
        Authorization: `Bearer ${tokens.accessToken}`,
        'User-Agent': OpenAI.userAgent,
    };
    if (tokens.accountId)
        headers['ChatGPT-Account-Id'] = tokens.accountId;

    const payload = await _requestJson(session, {
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

function _createHttpSession() {
    return new Soup.Session({
        timeout: HTTP_TIMEOUT_SECONDS,
    });
}

async function _requestJson(session, {
    method,
    url,
    vendor,
    authFailureSummary = null,
    headers = {},
    body = null,
}) {
    const message = Soup.Message.new(method, url);
    for (const [name, value] of Object.entries(headers))
        message.request_headers.append(name, value);

    if (body !== null) {
        const bytes = new GLib.Bytes(new TextEncoder().encode(JSON.stringify(body)));
        message.set_request_body_from_bytes('application/json', bytes);
    }

    let responseBytes;
    try {
        responseBytes = await _sendAndRead(session, message);
    } catch (error) {
        throw new UsageFetchError(
            UsageStatus.OFFLINE,
            `${VendorLabels[vendor]} usage service is unreachable.`
        );
    }

    const status = message.get_status();
    const text = new TextDecoder().decode(responseBytes.get_data());
    if (authFailureSummary && (status === 400 || status === 401 || status === 403)) {
        throw new UsageFetchError(
            UsageStatus.UNAUTHENTICATED,
            authFailureSummary
        );
    }

    if (status < 200 || status >= 300)
        throw _httpStatusError(vendor, status, text);

    try {
        return text.trim().length > 0 ? JSON.parse(text) : {};
    } catch (error) {
        throw new UsageFetchError(
            UsageStatus.MALFORMED_RESPONSE,
            `${VendorLabels[vendor]} returned usage data in an unexpected shape.`
        );
    }
}

function _sendAndRead(session, message) {
    return new Promise((resolve, reject) => {
        session.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            null,
            (source, result) => {
                try {
                    resolve(source.send_and_read_finish(result));
                } catch (error) {
                    reject(error);
                }
            }
        );
    });
}

function _httpStatusError(vendor, status, text) {
    const label = VendorLabels[vendor];
    if (status === 401 || status === 403) {
        return new UsageFetchError(
            UsageStatus.UNAUTHENTICATED,
            `${label} rejected the saved credentials. Sign in again with ${_loginCommand(vendor)}.`
        );
    }

    if (status === 429) {
        return new UsageFetchError(
            UsageStatus.RATE_LIMITED,
            `${label} rate limit was reached. Try again later.`
        );
    }

    if (status === 402 || status === 404) {
        return new UsageFetchError(
            UsageStatus.UNSUPPORTED_ACCOUNT,
            `${label} usage is not available for this account.`
        );
    }

    if (status >= 500) {
        return new UsageFetchError(
            UsageStatus.OFFLINE,
            `${label} usage service is temporarily unavailable.`
        );
    }

    return new UsageFetchError(
        UsageStatus.MALFORMED_RESPONSE,
        `${label} returned HTTP ${status} while loading usage.`
    );
}

function _loginCommand(vendor) {
    switch (vendor) {
    case Vendors.ANTHROPIC:
        return '`claude`';
    case Vendors.OPENAI:
        return '`codex login`';
    default:
        return 'the vendor CLI';
    }
}

function _readCredentialDocument(path, missingSummary, unreadableSummary) {
    if (!GLib.file_test(path, GLib.FileTest.EXISTS)) {
        throw new UsageFetchError(
            UsageStatus.UNAUTHENTICATED,
            missingSummary
        );
    }

    const permissionCheck = _validateOwnerOnlyFile(path);
    if (!permissionCheck.ok) {
        throw new UsageFetchError(
            UsageStatus.UNAUTHENTICATED,
            'Credential file permissions are unsafe; refusing to read credentials.'
        );
    }

    try {
        const [success, bytes] = GLib.file_get_contents(path);
        if (!success)
            throw new Error('unable to read file');

        return JSON.parse(new TextDecoder().decode(bytes));
    } catch (error) {
        throw new UsageFetchError(
            UsageStatus.UNAUTHENTICATED,
            unreadableSummary
        );
    }
}

function _writeCredentialDocument(path, document) {
    const permissionCheck = _validateOwnerOnlyFile(path);
    if (!permissionCheck.ok) {
        throw new UsageFetchError(
            UsageStatus.UNAUTHENTICATED,
            'Credential file permissions are unsafe; refusing to update credentials.'
        );
    }

    const tmpPath = `${path}.${GLib.uuid_string_random()}.tmp`;
    try {
        GLib.file_set_contents(tmpPath, `${JSON.stringify(document, null, 2)}\n`);
        GLib.chmod(tmpPath, OWNER_ONLY_FILE_MODE);

        if (GLib.rename(tmpPath, path) !== 0)
            throw new Error('unable to move credential file into place');

        GLib.chmod(path, OWNER_ONLY_FILE_MODE);
    } catch (error) {
        if (GLib.file_test(tmpPath, GLib.FileTest.EXISTS))
            GLib.unlink(tmpPath);

        throw new UsageFetchError(
            UsageStatus.UNAUTHENTICATED,
            'Credential refresh succeeded, but updated credentials could not be saved safely.'
        );
    }
}

function _validateOwnerOnlyFile(path) {
    const file = Gio.File.new_for_path(path);

    try {
        const info = file.query_info(
            'standard::type,unix::mode',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            null
        );

        if (info.get_file_type() !== Gio.FileType.REGULAR)
            return {ok: false};

        const permissionBits = info.get_attribute_uint32('unix::mode') & 0o777;
        return {ok: (permissionBits & UNSAFE_PERMISSION_MASK) === 0};
    } catch (error) {
        return {ok: false};
    }
}

function _credentialPath(relativePath) {
    return GLib.build_filenamev([
        GLib.get_home_dir(),
        ...relativePath.split('/'),
    ]);
}

function _anthropicOauthFromDocument(document) {
    const oauth = document?.claudeAiOauth;
    _assertCredentialObject(oauth, 'Claude OAuth credentials');

    return {
        accessToken: _requiredCredentialString(oauth.accessToken, 'access token'),
        refreshToken: _requiredCredentialString(oauth.refreshToken, 'refresh token'),
        expiresAt: _numberOrThrow(oauth.expiresAt, 'expiry'),
        subscriptionType: oauth.subscriptionType,
        rateLimitTier: oauth.rateLimitTier,
    };
}

function _openAITokensFromDocument(document) {
    const tokens = document?.tokens;
    _assertCredentialObject(tokens, 'Codex OAuth credentials');

    return {
        accessToken: _requiredCredentialString(tokens.access_token, 'access token'),
        refreshToken: _requiredCredentialString(tokens.refresh_token, 'refresh token'),
        idToken: _requiredCredentialString(tokens.id_token, 'ID token'),
        accountId: typeof tokens.account_id === 'string' ? tokens.account_id : null,
    };
}

function _requiredCredentialString(value, label) {
    if (typeof value === 'string' && value.length > 0)
        return value;

    throw new UsageFetchError(
        UsageStatus.UNAUTHENTICATED,
        `Saved credentials are missing a required ${label}. Sign in again.`
    );
}

function _requiredResponseString(value, vendor, label) {
    if (typeof value === 'string' && value.length > 0)
        return value;

    throw new UsageFetchError(
        UsageStatus.MALFORMED_RESPONSE,
        `${VendorLabels[vendor]} returned a token refresh response without ${label}.`
    );
}

function _positiveResponseNumber(value, vendor, label) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0)
        return number;

    throw new UsageFetchError(
        UsageStatus.MALFORMED_RESPONSE,
        `${VendorLabels[vendor]} returned a token refresh response with invalid ${label}.`
    );
}

function _assertObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new UsageFetchError(
            UsageStatus.MALFORMED_RESPONSE,
            `${label} is not a JSON object.`
        );
    }
}

function _assertCredentialObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new UsageFetchError(
            UsageStatus.UNAUTHENTICATED,
            `${label} are malformed. Sign in again.`
        );
    }
}

function _needsRefresh(expiresAtSeconds, now) {
    return expiresAtSeconds < now.to_unix() + REFRESH_BUFFER_SECONDS;
}

function _openAITokenExpiry(token) {
    const claims = decodeJwtPayload(token);
    const exp = Number(claims?.exp);
    return Number.isFinite(exp) ? Math.trunc(exp) : 0;
}

function _openAIPlanLabel(planType) {
    const suffix = _capitalize(String(planType ?? ''));
    return `ChatGPT ${suffix || 'Unknown'}`;
}

function _displayFromMetrics(plan, metrics) {
    const normalizedMetrics = metrics.filter(metric => metric !== null);
    const summaryMetrics = normalizedMetrics
        .map(metric => {
            if (metric.label === '5h session')
                return `${metric.value} 5h`;
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

function _usageWindowMetric(label, window, field, now) {
    const percent = _percent(window?.[field], {clamp: true});

    return {
        label,
        value: `${percent}%`,
        percent,
        detail: _windowResetDetail(window, now),
    };
}

function _windowResetDetail(window, now) {
    if (!window || typeof window !== 'object')
        return null;

    const resetAt = _resetTimestamp(window, now);
    if (resetAt === null)
        return null;

    return `Resets in ${_formatDuration(Math.max(0, resetAt - now.to_unix()))}`;
}

function _resetTimestamp(window, now) {
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

function _formatDuration(totalSeconds) {
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

function _usageRatioPercent(used, limit) {
    const usedNumber = _numberOrZero(used);
    const limitNumber = _numberOrZero(limit);
    if (limitNumber <= 0)
        return null;

    return Math.min(100, Math.max(0, Math.round((usedNumber / limitNumber) * 100)));
}

function _messageRangeDetail(credits) {
    const parts = [];
    const localRange = _formatRange(credits.approx_local_messages);
    const cloudRange = _formatRange(credits.approx_cloud_messages);

    if (localRange)
        parts.push(`${localRange} local`);
    if (cloudRange)
        parts.push(`${cloudRange} cloud`);

    return parts.length > 0 ? parts.join(', ') : null;
}

function _formatRange(value) {
    if (!Array.isArray(value) || value.length === 0)
        return null;

    const first = Number(value[0]);
    const second = Number(value.length > 1 ? value[1] : value[0]);
    if (!Number.isFinite(first) || !Number.isFinite(second))
        return null;

    return first === second ? `${first}` : `${first}-${second}`;
}

function _percent(value, {clamp = false} = {}) {
    const percent = Math.round(_numberOrZero(value));
    if (!clamp)
        return Math.max(0, percent);

    return Math.min(100, Math.max(0, percent));
}

function _formatCents(value) {
    const cents = Math.trunc(_numberOrZero(value));
    const sign = cents < 0 ? '-' : '';
    const absolute = Math.abs(cents);
    return `${sign}$${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`;
}

function _formatMoney(value) {
    if (typeof value === 'string' && value.trim().length > 0)
        return value;

    if (typeof value === 'number' && Number.isFinite(value))
        return `$${value.toFixed(2)}`;

    return '$0.00';
}

function _numberOrThrow(value, label) {
    const number = Number(value);
    if (Number.isFinite(number))
        return number;

    throw new UsageFetchError(
        UsageStatus.UNAUTHENTICATED,
        `Saved credentials have an invalid ${label}. Sign in again.`
    );
}

function _numberOrZero(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
}

function _capitalize(value) {
    const text = String(value ?? '');
    if (text.length === 0)
        return '';

    return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

function _base64UrlToBase64(value) {
    let text = value.replace(/-/g, '+').replace(/_/g, '/');
    while (text.length % 4 !== 0)
        text += '=';
    return text;
}

function _errorState(status, summary, now) {
    return createUsageState({
        status,
        summary,
        updatedAt: now,
        source: UsageSources.LIVE,
    });
}
