import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {UsageStatus} from './usageState.js';
import {
    VendorLabels,
} from './vendors.js';
import {
    UsageFetchError,
    loginCommand,
} from './vendorErrors.js';

const HTTP_TIMEOUT_SECONDS = 10;

export function createHttpSession() {
    return new Soup.Session({
        timeout: HTTP_TIMEOUT_SECONDS,
    });
}

export async function requestJson(session, {
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
        throw httpStatusError(vendor, status);

    try {
        return text.trim().length > 0 ? JSON.parse(text) : {};
    } catch (error) {
        throw new UsageFetchError(
            UsageStatus.MALFORMED_RESPONSE,
            `${VendorLabels[vendor]} returned usage data in an unexpected shape.`
        );
    }
}

export function httpStatusError(vendor, status) {
    const label = VendorLabels[vendor];
    if (status === 401 || status === 403) {
        return new UsageFetchError(
            UsageStatus.UNAUTHENTICATED,
            `${label} rejected the saved credentials. Sign in again with ${loginCommand(vendor)}.`
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
