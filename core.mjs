export const RETRY_MODES = Object.freeze({
    DISABLED: 'disabled',
    SPECIFIC: 'specific',
    ALL: 'all',
});

export const RESPONSE_OUTCOMES = Object.freeze({
    OK: 'ok',
    EMPTY: 'empty',
    ERROR: 'error',
    UNKNOWN: 'unknown',
});

export const RETRY_REASONS = Object.freeze({
    HTTP_ERROR: 'http_error',
    RESPONSE_ERROR: 'response_error',
    NETWORK_ERROR: 'network_error',
    EMPTY_RESPONSE: 'empty_response',
});

const CHAT_COMPLETION_PATH = '/api/backends/chat-completions/generate';
const SPECIFIC_STATUS_CODES = new Set([429, 503]);

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizePositiveInteger(value, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 1) return fallback;
    return Math.min(Math.trunc(number), 60000);
}

export function createDefaultSettings() {
    return {
        mode: RETRY_MODES.DISABLED,
        maxRetryRpm: 5,
        maxRetries: 5,
        contentEnabled: false,
        contentRules: '',
        minResponseLength: 0,
    };
}

export function normalizeSettings(settings) {
    const defaults = createDefaultSettings();
    if (!isObject(settings)) return defaults;

    return {
        mode: Object.values(RETRY_MODES).includes(settings.mode) ? settings.mode : defaults.mode,
        maxRetryRpm: normalizePositiveInteger(settings.maxRetryRpm, defaults.maxRetryRpm),
        maxRetries: normalizePositiveInteger(settings.maxRetries, defaults.maxRetries),
        contentEnabled: settings.contentEnabled === true,
        contentRules: typeof settings.contentRules === 'string' ? settings.contentRules : '',
        minResponseLength: Number.isFinite(Number(settings.minResponseLength))
            ? Math.max(0, Math.min(1000000, Math.trunc(Number(settings.minResponseLength)))) : 0,
    };
}

function getNumericStatus(value) {
    if (typeof value === 'number' && Number.isInteger(value)) return value;
    if (typeof value !== 'string' || !/^\d{3}$/.test(value.trim())) return undefined;
    return Number(value.trim());
}

function getStatusFromErrorText(value) {
    if (typeof value !== 'string') return undefined;
    const text = value.trim();
    if (!text) return undefined;

    const explicitCode = text.match(/(?:^|\D)(429|503)(?!\d)/)?.[1];
    if (explicitCode) return Number(explicitCode);
    if (/service[ _-]*unavailable|\btemporarily unavailable\b|\bhigh demand\b/i.test(text)) return 503;
    if (/too many requests|rate[ _-]*limit|resource[ _-]*exhausted|quota[ _-]*exceeded/i.test(text)) return 429;

    if (/^[\[{]/.test(text)) {
        try {
            return findStatusInErrorDetails(JSON.parse(text));
        } catch {
            // Some proxies include non-JSON context around the upstream error.
        }
    }
    return undefined;
}

function findStatusInErrorDetails(value, depth = 0) {
    if (depth > 6) return undefined;
    if (typeof value === 'string') return getStatusFromErrorText(value);
    if (Array.isArray(value)) {
        for (const item of value) {
            const status = findStatusInErrorDetails(item, depth + 1);
            if (status !== undefined) return status;
        }
        return undefined;
    }
    if (!isObject(value)) return undefined;

    for (const key of ['status', 'statusCode', 'code', 'httpStatus', 'http_status']) {
        const status = getNumericStatus(value[key]);
        if (status !== undefined) return status;
    }
    for (const key of ['error', 'message', 'statusText', 'detail', 'details', 'body', 'response', 'cause', 'type']) {
        if (!Object.hasOwn(value, key)) continue;
        const status = findStatusInErrorDetails(value[key], depth + 1);
        if (status !== undefined) return status;
    }
    return undefined;
}

function getErrorStatus(payload) {
    const error = isObject(payload?.error) ? payload.error : {};
    return getNumericStatus(error.status)
        ?? getNumericStatus(error.statusCode)
        ?? getNumericStatus(error.code)
        ?? getNumericStatus(payload?.status)
        ?? getNumericStatus(payload?.statusCode)
        ?? findStatusInErrorDetails(payload?.error)
        ?? findStatusInErrorDetails(payload);
}

function hasActionContent(value) {
    if (!isObject(value)) return false;
    const type = typeof value.type === 'string' ? value.type.toLowerCase() : '';
    if (/^(?:tool_use|tool_call|function_call|computer_use|image|image_url|audio|input_audio)$/.test(type)) {
        return true;
    }
    if (Array.isArray(value.tool_calls) && value.tool_calls.length > 0) return true;
    if (Array.isArray(value.tools) && value.tools.length > 0) return true;
    return Boolean(value.function_call || value.functionCall || value.tool_call || value.toolCall
        || value.tool_use || value.inlineData || value.image_url || value.audio || value.input_audio
        || hasActionContent(value.content_block) || hasActionContent(value.item));
}

function hasMeaningfulContent(value) {
    if (typeof value === 'string') return value.trim().length > 0;
    if (Array.isArray(value)) {
        return value.some(item => hasMeaningfulContent(item) || hasActionContent(item));
    }
    if (!isObject(value)) return false;
    if (hasActionContent(value)) return true;

    for (const key of ['text', 'output_text', 'content', 'refusal', 'tool_plan', 'delta']) {
        if (Object.hasOwn(value, key) && hasMeaningfulContent(value[key])) return true;
    }
    return false;
}

function analyzeMessage(message) {
    if (typeof message === 'string' || Array.isArray(message)) {
        return hasMeaningfulContent(message) ? RESPONSE_OUTCOMES.OK : RESPONSE_OUTCOMES.EMPTY;
    }
    if (!isObject(message)) return RESPONSE_OUTCOMES.UNKNOWN;
    if (hasActionContent(message)) return RESPONSE_OUTCOMES.OK;

    const contentKeys = ['content', 'text', 'output_text', 'refusal', 'tool_plan'];
    const presentKeys = contentKeys.filter(key => Object.hasOwn(message, key));
    if (presentKeys.length === 0) return RESPONSE_OUTCOMES.UNKNOWN;
    return presentKeys.some(key => hasMeaningfulContent(message[key]))
        ? RESPONSE_OUTCOMES.OK
        : RESPONSE_OUTCOMES.EMPTY;
}

function mergeOutcomes(outcomes) {
    if (outcomes.includes(RESPONSE_OUTCOMES.ERROR)) return RESPONSE_OUTCOMES.ERROR;
    if (outcomes.includes(RESPONSE_OUTCOMES.OK)) return RESPONSE_OUTCOMES.OK;
    if (outcomes.includes(RESPONSE_OUTCOMES.EMPTY)) return RESPONSE_OUTCOMES.EMPTY;
    return RESPONSE_OUTCOMES.UNKNOWN;
}

function analyzeChoices(choices) {
    if (!Array.isArray(choices)) return RESPONSE_OUTCOMES.UNKNOWN;
    if (choices.length === 0) return RESPONSE_OUTCOMES.EMPTY;

    return mergeOutcomes(choices.map(choice => {
        if (!isObject(choice)) return RESPONSE_OUTCOMES.UNKNOWN;
        if (hasActionContent(choice)) return RESPONSE_OUTCOMES.OK;
        if (Object.hasOwn(choice, 'message')) return analyzeMessage(choice.message);
        if (Object.hasOwn(choice, 'delta')) return analyzeMessage(choice.delta);
        if (Object.hasOwn(choice, 'text')) return analyzeMessage(choice.text);
        return RESPONSE_OUTCOMES.UNKNOWN;
    }));
}

function analyzeParts(parts) {
    if (!Array.isArray(parts)) return RESPONSE_OUTCOMES.UNKNOWN;
    if (parts.length === 0) return RESPONSE_OUTCOMES.EMPTY;
    return parts.some(part => hasMeaningfulContent(part) || hasActionContent(part))
        ? RESPONSE_OUTCOMES.OK
        : RESPONSE_OUTCOMES.EMPTY;
}

/**
 * Recognizes the common OpenAI-compatible and provider-specific chat response shapes.
 */
export function analyzeJsonPayload(payload) {
    if (!isObject(payload)) return { outcome: RESPONSE_OUTCOMES.UNKNOWN };
    if (payload.error) {
        return { outcome: RESPONSE_OUTCOMES.ERROR, status: getErrorStatus(payload) };
    }

    if (Object.hasOwn(payload, 'choices')) {
        return { outcome: analyzeChoices(payload.choices) };
    }
    if (Object.hasOwn(payload, 'message')) {
        return { outcome: analyzeMessage(payload.message) };
    }
    if (Array.isArray(payload.output)) {
        const outcomes = payload.output.map(item => {
            if (isObject(item) && /(?:function|tool)_call/.test(String(item.type))) {
                return RESPONSE_OUTCOMES.OK;
            }
            return analyzeMessage(item);
        });
        return { outcome: payload.output.length === 0 ? RESPONSE_OUTCOMES.EMPTY : mergeOutcomes(outcomes) };
    }
    if (Array.isArray(payload.content)) {
        return { outcome: analyzeParts(payload.content) };
    }
    if (Array.isArray(payload.candidates)) {
        const outcomes = payload.candidates.map(candidate => analyzeParts(candidate?.content?.parts));
        return { outcome: payload.candidates.length === 0 ? RESPONSE_OUTCOMES.EMPTY : mergeOutcomes(outcomes) };
    }
    if (isObject(payload.responseContent) && Object.hasOwn(payload.responseContent, 'parts')) {
        return { outcome: analyzeParts(payload.responseContent.parts) };
    }

    return { outcome: RESPONSE_OUTCOMES.UNKNOWN };
}

function analyzeStreamPayload(payload) {
    const regular = analyzeJsonPayload(payload);
    if (regular.outcome !== RESPONSE_OUTCOMES.UNKNOWN) return regular;
    if (!isObject(payload)) return regular;
    if (hasActionContent(payload)) return { outcome: RESPONSE_OUTCOMES.OK };

    if (typeof payload.type === 'string' && payload.type.includes('error')) {
        return { outcome: RESPONSE_OUTCOMES.ERROR, status: getErrorStatus(payload) };
    }
    if (typeof payload.type === 'string' && payload.type.endsWith('.delta') && Object.hasOwn(payload, 'delta')) {
        return {
            outcome: hasMeaningfulContent(payload.delta) ? RESPONSE_OUTCOMES.OK : RESPONSE_OUTCOMES.EMPTY,
        };
    }
    if (Object.hasOwn(payload, 'delta')) {
        return { outcome: analyzeMessage(payload.delta) };
    }
    if (isObject(payload.response)) {
        return analyzeJsonPayload(payload.response);
    }
    return regular;
}

/**
 * Inspects a complete SSE response. Errors take precedence over emitted text so a
 * late stream error can still retry without duplicating already displayed text.
 */
export function analyzeEventStream(text) {
    if (typeof text !== 'string' || text.trim() === '') {
        return { outcome: RESPONSE_OUTCOMES.EMPTY };
    }

    const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const blocks = normalized.split(/\n\n+/);
    const outcomes = [];
    let sawDone = false;
    let errorStatus;

    for (const block of blocks) {
        const data = block.split('\n')
            .filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).trimStart())
            .join('\n')
            .trim();
        if (!data) continue;
        if (data === '[DONE]') {
            sawDone = true;
            continue;
        }
        try {
            const result = analyzeStreamPayload(JSON.parse(data));
            outcomes.push(result.outcome);
            if (result.outcome === RESPONSE_OUTCOMES.ERROR) errorStatus ??= result.status;
        } catch {
            outcomes.push(RESPONSE_OUTCOMES.UNKNOWN);
        }
    }

    const outcome = mergeOutcomes(outcomes);
    if (outcome === RESPONSE_OUTCOMES.ERROR) return { outcome, status: errorStatus };
    if (outcome === RESPONSE_OUTCOMES.OK) return { outcome };
    if (outcome === RESPONSE_OUTCOMES.EMPTY || sawDone) return { outcome: RESPONSE_OUTCOMES.EMPTY };

    try {
        return analyzeJsonPayload(JSON.parse(text));
    } catch {
        return { outcome: RESPONSE_OUTCOMES.UNKNOWN };
    }
}

export function shouldRetry(mode, reason, status) {
    if (mode === RETRY_MODES.DISABLED) return false;
    if (reason === RETRY_REASONS.EMPTY_RESPONSE) return true;
    if (mode === RETRY_MODES.ALL) return true;
    return (reason === RETRY_REASONS.HTTP_ERROR || reason === RETRY_REASONS.RESPONSE_ERROR)
        && SPECIFIC_STATUS_CODES.has(Number(status));
}

export function parseRetryAfter(value, now = Date.now()) {
    if (typeof value !== 'string' || value.trim() === '') return 0;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
    const date = Date.parse(value);
    return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}

function makeAbortError() {
    if (typeof DOMException === 'function') return new DOMException('The operation was aborted.', 'AbortError');
    const error = new Error('The operation was aborted.');
    error.name = 'AbortError';
    return error;
}

export function waitWithSignal(milliseconds, signal) {
    if (signal?.aborted) return Promise.reject(makeAbortError());
    if (milliseconds <= 0) return Promise.resolve();

    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, milliseconds);
        const onAbort = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            reject(makeAbortError());
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

export class RetryRateLimiter {
    constructor({ now = () => Date.now(), sleep = waitWithSignal } = {}) {
        this.now = now;
        this.sleep = sleep;
        this.nextRetryAt = 0;
    }

    async wait(rpm, signal, minimumDelay = 0, onScheduled) {
        const interval = 60000 / normalizePositiveInteger(rpm, 5);
        const currentTime = this.now();
        const scheduledAt = Math.max(currentTime + Math.max(0, minimumDelay), this.nextRetryAt);
        this.nextRetryAt = scheduledAt + interval;
        const delay = Math.max(0, scheduledAt - currentTime);
        onScheduled?.(delay);
        await this.sleep(delay, signal);
        return delay;
    }
}

export function isChatCompletionRequest(input, init) {
    const method = String(init?.method ?? input?.method ?? 'GET').toUpperCase();
    if (method !== 'POST') return false;

    const rawUrl = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
    if (!rawUrl) return false;
    try {
        const base = globalThis.location?.origin ?? 'http://localhost';
        return new URL(rawUrl, base).pathname.endsWith(CHAT_COMPLETION_PATH);
    } catch {
        return false;
    }
}

async function readRequestStreamFlag(input, init) {
    let body = init?.body;
    if (body === undefined && typeof Request === 'function' && input instanceof Request) {
        try {
            body = await input.clone().text();
        } catch {
            return false;
        }
    }
    if (typeof body !== 'string') return false;
    try {
        return JSON.parse(body)?.stream === true;
    } catch {
        return false;
    }
}

function createAttempt(originalFetch, input, init) {
    if (typeof Request === 'function') {
        try {
            const template = new Request(input, init);
            return {
                signal: template.signal,
                run: () => originalFetch(template.clone()),
            };
        } catch {
            // Relative URLs are accepted by browsers but not by every test runtime.
        }
    }
    return {
        signal: init?.signal ?? input?.signal,
        run: () => originalFetch(input, init),
    };
}

async function inspectSuccessfulResponse(response, expectsStream) {
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    const isEventStream = expectsStream || contentType.includes('text/event-stream');
    const copy = response.clone();

    if (isEventStream) {
        return analyzeEventStream(await copy.text());
    }

    const text = await copy.text();
    if (text.trim() === '') return { outcome: RESPONSE_OUTCOMES.EMPTY };
    try {
        return analyzeJsonPayload(JSON.parse(text));
    } catch {
        return { outcome: RESPONSE_OUTCOMES.UNKNOWN };
    }
}

async function discardResponse(response) {
    try {
        await response.body?.cancel();
    } catch {
        // The body can already be closed after a cloned response was inspected.
    }
}

function isAbortError(error, signal) {
    return signal?.aborted || error?.name === 'AbortError';
}

/**
 * Creates a fetch wrapper that retries only SillyTavern chat-completion generation requests.
 */
export function createRetryingFetch(originalFetch, {
    getSettings,
    limiter = new RetryRateLimiter(),
    onRetry = () => {},
} = {}) {
    if (typeof originalFetch !== 'function') throw new TypeError('originalFetch must be a function');

    return async function retryingFetch(input, init) {
        if (!isChatCompletionRequest(input, init)) return originalFetch(input, init);

        const settings = normalizeSettings(getSettings?.());
        if (settings.mode === RETRY_MODES.DISABLED) return originalFetch(input, init);

        const expectsStream = await readRequestStreamFlag(input, init);
        const attempt = createAttempt(originalFetch, input, init);
        let retriesUsed = 0;

        const scheduleRetry = async (reason, status, response) => {
            const retryAfter = response
                ? parseRetryAfter(response.headers.get('retry-after'), limiter.now?.() ?? Date.now())
                : 0;
            retriesUsed += 1;
            await limiter.wait(settings.maxRetryRpm, attempt.signal, retryAfter, delayMs => {
                onRetry({
                    reason,
                    status,
                    retryNumber: retriesUsed,
                    maxRetries: settings.maxRetries,
                    delayMs,
                });
            });
        };

        while (true) {
            let response;
            try {
                response = await attempt.run();
            } catch (error) {
                if (isAbortError(error, attempt.signal)) throw error;
                if (retriesUsed >= settings.maxRetries
                    || !shouldRetry(settings.mode, RETRY_REASONS.NETWORK_ERROR)) {
                    throw error;
                }
                await scheduleRetry(RETRY_REASONS.NETWORK_ERROR);
                continue;
            }

            if (!response.ok) {
                if (retriesUsed >= settings.maxRetries
                    || !shouldRetry(settings.mode, RETRY_REASONS.HTTP_ERROR, response.status)) {
                    return response;
                }
                const status = response.status;
                await discardResponse(response);
                await scheduleRetry(RETRY_REASONS.HTTP_ERROR, status, response);
                continue;
            }

            let analysis;
            try {
                analysis = await inspectSuccessfulResponse(response, expectsStream);
            } catch (error) {
                if (isAbortError(error, attempt.signal)) throw error;
                if (retriesUsed >= settings.maxRetries
                    || !shouldRetry(settings.mode, RETRY_REASONS.NETWORK_ERROR)) {
                    throw error;
                }
                await discardResponse(response);
                await scheduleRetry(RETRY_REASONS.NETWORK_ERROR);
                continue;
            }

            const reason = analysis.outcome === RESPONSE_OUTCOMES.EMPTY
                ? RETRY_REASONS.EMPTY_RESPONSE
                : analysis.outcome === RESPONSE_OUTCOMES.ERROR
                    ? RETRY_REASONS.RESPONSE_ERROR
                    : undefined;
            if (!reason || retriesUsed >= settings.maxRetries
                || !shouldRetry(settings.mode, reason, analysis.status)) {
                return response;
            }

            await discardResponse(response);
            await scheduleRetry(reason, analysis.status, response);
        }
    };
}
