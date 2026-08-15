import test from 'node:test';
import assert from 'node:assert/strict';
import {
    RESPONSE_OUTCOMES,
    RETRY_MODES,
    RETRY_REASONS,
    RetryRateLimiter,
    analyzeEventStream,
    analyzeJsonPayload,
    createDefaultSettings,
    createRetryingFetch,
    normalizeSettings,
    parseRetryAfter,
    shouldRetry,
} from './core.mjs';

const endpoint = 'http://localhost/api/backends/chat-completions/generate';
const instantLimiter = {
    now: () => 0,
    wait: async (_rpm, _signal, _minimumDelay, onScheduled) => onScheduled?.(0),
};

function jsonResponse(value, status = 200, headers = {}) {
    return new Response(JSON.stringify(value), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
    });
}

function streamResponse(events, status = 200) {
    return new Response(events, {
        status,
        headers: { 'content-type': 'text/event-stream' },
    });
}

function makeSequenceFetch(sequence) {
    const calls = [];
    const fetch = async (...args) => {
        calls.push(args);
        const next = sequence.shift();
        if (next instanceof Error) throw next;
        return typeof next === 'function' ? next() : next;
    };
    fetch.calls = calls;
    return fetch;
}

function settings(mode, changes = {}) {
    return { ...createDefaultSettings(), mode, maxRetryRpm: 60000, ...changes };
}

test('defaults and invalid persisted settings normalize safely', () => {
    assert.deepEqual(createDefaultSettings(), {
        mode: RETRY_MODES.DISABLED,
        maxRetryRpm: 5,
        maxRetries: 5,
    });
    assert.deepEqual(normalizeSettings({ mode: 'bad', maxRetryRpm: 0, maxRetries: 'x' }), createDefaultSettings());
    assert.deepEqual(normalizeSettings({ mode: RETRY_MODES.ALL, maxRetryRpm: '12', maxRetries: 3.9 }), {
        mode: RETRY_MODES.ALL,
        maxRetryRpm: 12,
        maxRetries: 3,
    });
});

test('JSON payload analysis distinguishes empty content, text, tools, and errors', () => {
    assert.equal(analyzeJsonPayload({ choices: [{ message: { content: '' } }] }).outcome, RESPONSE_OUTCOMES.EMPTY);
    assert.equal(analyzeJsonPayload({ choices: [{ message: { content: '  ' } }] }).outcome, RESPONSE_OUTCOMES.EMPTY);
    assert.equal(analyzeJsonPayload({ choices: [{ message: { content: '\n \r\n\t', extra_content: { google: {} }, role: 'assistant' } }] }).outcome, RESPONSE_OUTCOMES.EMPTY);
    assert.equal(analyzeJsonPayload({ choices: [{ message: { content: 'hello' } }] }).outcome, RESPONSE_OUTCOMES.OK);
    assert.equal(analyzeJsonPayload({ choices: [{ message: { content: null, tool_calls: [{}] } }] }).outcome, RESPONSE_OUTCOMES.OK);
    assert.equal(analyzeJsonPayload({ content: [{ type: 'tool_use', id: 'tool-1' }] }).outcome, RESPONSE_OUTCOMES.OK);
    assert.deepEqual(analyzeJsonPayload({ error: { status: 429 } }), { outcome: RESPONSE_OUTCOMES.ERROR, status: 429 });
});

test('SSE analysis detects empty, content, late errors, and tool calls', () => {
    const empty = 'data: {"choices":[{"delta":{"content":""}}]}\n\ndata: [DONE]\n\n';
    const content = 'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: [DONE]\n\n';
    const lateError = `${content}data: {"error":{"status":503}}\n\n`;
    const tool = 'data: {"choices":[{"delta":{"tool_calls":[{}]}}]}\n\ndata: [DONE]\n\n';
    const responsesTool = 'data: {"type":"response.output_item.added","item":{"type":"function_call"}}\n\ndata: [DONE]\n\n';
    const anthropicTool = 'data: {"type":"content_block_start","content_block":{"type":"tool_use"}}\n\ndata: [DONE]\n\n';
    assert.equal(analyzeEventStream(empty).outcome, RESPONSE_OUTCOMES.EMPTY);
    assert.equal(analyzeEventStream(content).outcome, RESPONSE_OUTCOMES.OK);
    assert.deepEqual(analyzeEventStream(lateError), { outcome: RESPONSE_OUTCOMES.ERROR, status: 503 });
    assert.equal(analyzeEventStream(tool).outcome, RESPONSE_OUTCOMES.OK);
    assert.equal(analyzeEventStream(responsesTool).outcome, RESPONSE_OUTCOMES.OK);
    assert.equal(analyzeEventStream(anthropicTool).outcome, RESPONSE_OUTCOMES.OK);
});

test('retry policy matches the three requested modes', () => {
    assert.equal(shouldRetry(RETRY_MODES.DISABLED, RETRY_REASONS.EMPTY_RESPONSE), false);
    assert.equal(shouldRetry(RETRY_MODES.SPECIFIC, RETRY_REASONS.HTTP_ERROR, 429), true);
    assert.equal(shouldRetry(RETRY_MODES.SPECIFIC, RETRY_REASONS.HTTP_ERROR, 503), true);
    assert.equal(shouldRetry(RETRY_MODES.SPECIFIC, RETRY_REASONS.HTTP_ERROR, 500), false);
    assert.equal(shouldRetry(RETRY_MODES.SPECIFIC, RETRY_REASONS.NETWORK_ERROR), false);
    assert.equal(shouldRetry(RETRY_MODES.SPECIFIC, RETRY_REASONS.EMPTY_RESPONSE), true);
    assert.equal(shouldRetry(RETRY_MODES.ALL, RETRY_REASONS.NETWORK_ERROR), true);
    assert.equal(shouldRetry(RETRY_MODES.ALL, RETRY_REASONS.HTTP_ERROR, 401), true);
});

test('disabled mode and unrelated requests are passed through once', async () => {
    const original = makeSequenceFetch([
        jsonResponse({ choices: [{ message: { content: 'disabled' } }] }),
        jsonResponse({ ok: true }),
    ]);
    const wrapped = createRetryingFetch(original, {
        getSettings: () => settings(RETRY_MODES.DISABLED),
        limiter: instantLimiter,
    });
    await wrapped(endpoint, { method: 'POST', body: '{}' });
    await wrapped('http://localhost/api/backends/chat-completions/status', { method: 'POST' });
    assert.equal(original.calls.length, 2);
});

test('specific mode retries 429 and 503 but not 500', async () => {
    const original = makeSequenceFetch([
        jsonResponse({ error: 'rate limit' }, 429),
        jsonResponse({ error: 'unavailable' }, 503),
        jsonResponse({ choices: [{ message: { content: 'ok' } }] }),
    ]);
    const events = [];
    const wrapped = createRetryingFetch(original, {
        getSettings: () => settings(RETRY_MODES.SPECIFIC),
        limiter: instantLimiter,
        onRetry: event => events.push(event),
    });
    const response = await wrapped(endpoint, { method: 'POST', body: '{}' });
    assert.equal((await response.json()).choices[0].message.content, 'ok');
    assert.equal(original.calls.length, 3);
    assert.deepEqual(events.map(event => event.status), [429, 503]);

    const noRetryOriginal = makeSequenceFetch([jsonResponse({ error: 'server' }, 500)]);
    const noRetry = createRetryingFetch(noRetryOriginal, {
        getSettings: () => settings(RETRY_MODES.SPECIFIC),
        limiter: instantLimiter,
    });
    assert.equal((await noRetry(endpoint, { method: 'POST' })).status, 500);
    assert.equal(noRetryOriginal.calls.length, 1);
});

test('specific mode retries successful JSON empty replies', async () => {
    const original = makeSequenceFetch([
        jsonResponse({ choices: [{ message: { content: null } }] }),
        jsonResponse({ choices: [{ message: { content: 'final' } }] }),
    ]);
    const wrapped = createRetryingFetch(original, {
        getSettings: () => settings(RETRY_MODES.SPECIFIC),
        limiter: instantLimiter,
    });
    const response = await wrapped(endpoint, { method: 'POST', body: JSON.stringify({ stream: false }) });
    assert.equal((await response.json()).choices[0].message.content, 'final');
    assert.equal(original.calls.length, 2);
});

test('SSE empty response is replaced by the successful retry without losing its body', async () => {
    const original = makeSequenceFetch([
        streamResponse('data: {"choices":[{"delta":{"content":""}}]}\n\ndata: [DONE]\n\n'),
        streamResponse('data: {"choices":[{"delta":{"content":"final"}}]}\n\ndata: [DONE]\n\n'),
    ]);
    const wrapped = createRetryingFetch(original, {
        getSettings: () => settings(RETRY_MODES.SPECIFIC),
        limiter: instantLimiter,
    });
    const response = await wrapped(endpoint, { method: 'POST', body: JSON.stringify({ stream: true }) });
    assert.match(await response.text(), /final/);
    assert.equal(original.calls.length, 2);
});

test('all mode retries network and arbitrary HTTP errors', async () => {
    const original = makeSequenceFetch([
        new TypeError('network failed'),
        jsonResponse({ error: 'bad gateway' }, 502),
        jsonResponse({ choices: [{ message: { content: 'recovered' } }] }),
    ]);
    const wrapped = createRetryingFetch(original, {
        getSettings: () => settings(RETRY_MODES.ALL),
        limiter: instantLimiter,
    });
    const response = await wrapped(endpoint, { method: 'POST', body: '{}' });
    assert.equal((await response.json()).choices[0].message.content, 'recovered');
    assert.equal(original.calls.length, 3);
});

test('maximum retries means extra attempts and returns the last response', async () => {
    const original = makeSequenceFetch([
        jsonResponse({ error: 'one' }, 500),
        jsonResponse({ error: 'two' }, 500),
        jsonResponse({ error: 'three' }, 500),
    ]);
    const wrapped = createRetryingFetch(original, {
        getSettings: () => settings(RETRY_MODES.ALL, { maxRetries: 2 }),
        limiter: instantLimiter,
    });
    const response = await wrapped(endpoint, { method: 'POST' });
    assert.equal(response.status, 500);
    assert.equal(original.calls.length, 3);
});

test('rate limiter spaces shared retries and honors larger Retry-After values', async () => {
    let now = 1000;
    const waits = [];
    const limiter = new RetryRateLimiter({
        now: () => now,
        sleep: async delay => {
            waits.push(delay);
            now += delay;
        },
    });
    await limiter.wait(5);
    await limiter.wait(5);
    await limiter.wait(5, undefined, 20000);
    assert.deepEqual(waits, [0, 12000, 20000]);
    assert.equal(parseRetryAfter('1.5', 0), 1500);
    assert.equal(parseRetryAfter('Thu, 01 Jan 1970 00:00:03 GMT', 1000), 2000);
});

test('response-embedded 429 retries in specific mode', async () => {
    const original = makeSequenceFetch([
        jsonResponse({ error: { code: '429', message: 'limited' } }),
        jsonResponse({ choices: [{ message: { content: 'ok' } }] }),
    ]);
    const wrapped = createRetryingFetch(original, {
        getSettings: () => settings(RETRY_MODES.SPECIFIC),
        limiter: instantLimiter,
    });
    const response = await wrapped(endpoint, { method: 'POST' });
    assert.equal((await response.json()).choices[0].message.content, 'ok');
    assert.equal(original.calls.length, 2);
});

test('specific mode retries errors whose upstream status was hidden by SillyTavern', async () => {
    const original = makeSequenceFetch([
        jsonResponse({ error: { message: 'Service Unavailable' }, quota_error: false }),
        jsonResponse({ error: { message: 'Too Many Requests' }, quota_error: false }),
        jsonResponse({
            choices: [{
                finish_reason: 'stop',
                index: 0,
                message: {
                    content: 'Hello! How can I help you today?',
                    extra_content: { google: {} },
                    role: 'assistant',
                },
            }],
        }),
    ]);
    const events = [];
    const wrapped = createRetryingFetch(original, {
        getSettings: () => settings(RETRY_MODES.SPECIFIC),
        limiter: instantLimiter,
        onRetry: event => events.push(event),
    });

    const response = await wrapped(endpoint, { method: 'POST', body: JSON.stringify({ stream: false }) });
    assert.equal((await response.json()).choices[0].message.content, 'Hello! How can I help you today?');
    assert.deepEqual(events.map(event => event.status), [503, 429]);
    assert.equal(original.calls.length, 3);
});

test('specific mode retries the exact whitespace-only OpenAI-compatible message shape', async () => {
    const emptyReply = {
        choices: [{
            finish_reason: 'stop',
            index: 0,
            message: {
                content: '\n   \t\n',
                extra_content: { google: { grounding: true } },
                role: 'assistant',
            },
        }],
        model: 'models/gemini-3.7-flash',
        object: 'chat.completion',
    };
    const original = makeSequenceFetch([
        jsonResponse(emptyReply),
        jsonResponse({ choices: [{ message: { content: 'recovered' } }] }),
    ]);
    const events = [];
    const wrapped = createRetryingFetch(original, {
        getSettings: () => settings(RETRY_MODES.SPECIFIC),
        limiter: instantLimiter,
        onRetry: event => events.push(event),
    });

    const response = await wrapped(endpoint, { method: 'POST', body: JSON.stringify({ stream: false }) });
    assert.equal((await response.json()).choices[0].message.content, 'recovered');
    assert.deepEqual(events.map(event => event.reason), [RETRY_REASONS.EMPTY_RESPONSE]);
    assert.equal(original.calls.length, 2);
});

test('specific mode extracts retryable codes from nested and serialized upstream errors', () => {
    assert.deepEqual(
        analyzeJsonPayload({ error: { body: '[{ "error": { "code": 503, "status": "UNAVAILABLE" } }]' } }),
        { outcome: RESPONSE_OUTCOMES.ERROR, status: 503 },
    );
    assert.deepEqual(
        analyzeJsonPayload({ error: { details: [{ message: 'RESOURCE_EXHAUSTED' }] } }),
        { outcome: RESPONSE_OUTCOMES.ERROR, status: 429 },
    );
});
