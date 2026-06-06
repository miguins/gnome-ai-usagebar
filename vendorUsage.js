import GLib from 'gi://GLib';

import {UsageStatus} from './usageState.js';
import {
    Vendors,
    VendorLabels,
    isVendor,
} from './vendors.js';
import {refreshAnthropicUsage} from './anthropicUsage.js';
import {refreshOpenAIUsage} from './openAIUsage.js';
import {
    UsageFetchError,
    errorState,
} from './vendorErrors.js';
import {
    createHttpSession,
    requestJson as defaultRequestJson,
} from './vendorHttp.js';

export {
    anthropicPlanLabel,
    buildAnthropicUsageDisplay,
    summarizeAnthropicUsage,
} from './anthropicUsage.js';
export {
    buildOpenAIUsageDisplay,
    decodeJwtPayload,
    openAIPlanHintFromToken,
    summarizeOpenAIUsage,
} from './openAIUsage.js';

export async function refreshVendorUsage(vendor, {
    credentialBaseDir = GLib.get_home_dir(),
    credentialPath = null,
    proxyUrl = null,
    useEnvironmentProxy = false,
    secretCredentialStore = null,
    session = null,
    requestJson = defaultRequestJson,
    now = GLib.DateTime.new_now_utc(),
} = {}) {
    if (!isVendor(vendor)) {
        return errorState(
            UsageStatus.UNSUPPORTED_ACCOUNT,
            'Unsupported vendor.',
            now
        );
    }

    const httpSession = session ?? createHttpSession({
        proxyUrl,
        useEnvironmentProxy,
    });

    try {
        switch (vendor) {
        case Vendors.ANTHROPIC:
            return await refreshAnthropicUsage({
                session: httpSession,
                requestJson,
                now,
                credentialBaseDir,
                credentialPath,
                secretCredentialStore,
            });
        case Vendors.OPENAI:
            return await refreshOpenAIUsage({
                session: httpSession,
                requestJson,
                now,
                credentialBaseDir,
                credentialPath,
                secretCredentialStore,
            });
        default:
            return errorState(
                UsageStatus.UNSUPPORTED_ACCOUNT,
                `${VendorLabels[vendor] ?? 'This vendor'} is not supported yet.`,
                now
            );
        }
    } catch (error) {
        if (error instanceof UsageFetchError)
            return errorState(error.status, error.summary, now);

        return errorState(
            UsageStatus.MALFORMED_RESPONSE,
            `${VendorLabels[vendor] ?? 'Vendor'} usage refresh failed unexpectedly.`,
            now
        );
    }
}
