import {
    UsageSources,
    createUsageState,
} from './usageState.js';
import {Vendors} from './vendors.js';

export class UsageFetchError extends Error {
    constructor(status, summary) {
        super(summary);
        this.status = status;
        this.summary = summary;
    }
}

export function errorState(status, summary, now) {
    return createUsageState({
        status,
        summary,
        updatedAt: now,
        source: UsageSources.LIVE,
    });
}

export function loginCommand(vendor) {
    switch (vendor) {
    case Vendors.ANTHROPIC:
        return '`claude`';
    case Vendors.OPENAI:
        return '`codex login`';
    default:
        return 'the vendor CLI';
    }
}
