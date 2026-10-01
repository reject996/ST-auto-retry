import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { compileRules, matchContent, lastAssistant, installContentRetry } from './content.mjs';
import { normalizeSettings } from './core.mjs';
const settings = changes => normalizeSettings({ mode: 'specific', contentEnabled: true, contentRules: '拒绝\n/sorry|cannot/ig', ...changes });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('keywords and regex are OR, invalid regex is reported, global regex is repeatable', () => {
    const parsed = compileRules('拒绝\n/sorry/ig\n/[invalid/');
    assert.equal(parsed.errors.length, 1);
    assert.equal(parsed.rules[1].test('SORRY'), true);
    assert.equal(parsed.rules[1].test('SORRY'), true);
    for (const text of ['拒绝执行', 'SORRY', 'cannot proceed']) assert.equal(matchContent(text, settings()).reason, 'content_match');
    assert.equal(matchContent('正常回复', settings()), null);
    assert.equal(matchContent('拒绝', settings({ mode: 'disabled' })), null);
    assert.equal(matchContent('拒绝', settings({ contentEnabled: false })), null);
});
test('length uses code points and strict less than, independently of rules', () => {
    assert.equal(matchContent('你😀', settings({ minResponseLength: 3 })).reason, 'content_short');
    assert.equal(matchContent('你😀', settings({ minResponseLength: 2 })), null);
    assert.equal(matchContent('', settings({ minResponseLength: 0 })), null);
    assert.equal(matchContent('', settings({ minResponseLength: 1 })).reason, 'content_short');
    assert.equal(normalizeSettings({ minResponseLength: -2 }).minResponseLength, 0);
});
test('chat API selection excludes user/system and selects current swipe mes', () => {
    const msg = { mes: 'current', swipes: ['old', 'current'], swipe_id: 1 };
    assert.equal(lastAssistant([{ mes: 'old' }, msg, { is_user: true, mes: '拒绝' }, { is_system: true, mes: '拒绝' }]).text, 'current');
    assert.equal(lastAssistant([{ is_user: true, mes: 'hello' }]), null);
});
function harness({ replies = ['正常回复'], config = {}, limiter, busy = () => false } = {}) {
    const events = new EventEmitter();
    const names = ['GENERATION_STARTED', 'MESSAGE_RECEIVED', 'GENERATION_ENDED', 'GENERATION_STOPPED', 'CHAT_CHANGED', 'MESSAGE_EDITED', 'MESSAGE_DELETED'];
    const types = Object.fromEntries(names.map(x => [x, x]));
    const state = { calls: 0, limits: 0, errors: [], settings: settings({ maxRetries: 2, ...config }) };
    const ctx = { eventSource: events, eventTypes: types, chat: [], characterId: 0, getCurrentChatId: () => 'chat' };
    const emit = (name, ...args) => events.emit(name, ...args);
    const receive = text => {
        ctx.chat.push({ mes: text });
        emit('MESSAGE_RECEIVED', ctx.chat.length - 1);
        emit('GENERATION_ENDED');
    };
    ctx.generate = async type => {
        state.calls++;
        emit('GENERATION_STARTED', type, {}, false);
        ctx.chat.pop();
        emit('MESSAGE_DELETED', ctx.chat.length);
        receive(replies[Math.min(state.calls - 1, replies.length - 1)]);
    };
    const dispose = installContentRetry({ getContext: () => ctx, getSettings: () => state.settings, isBusy: busy,
        limiter: limiter ?? { wait: async () => {} }, onLimit: () => state.limits++, onError: e => state.errors.push(e) });
    const begin = text => { emit('GENERATION_STARTED', 'normal', {}, false); receive(text); };
    return { state, ctx, emit, receive, begin, dispose };
}
test('regeneration reads saved chat text, survives own deletion, stops when accepted', async () => {
    const h = harness({ replies: ['拒绝', '正常回复'] });
    h.begin('SORRY');
    await sleep(230);
    assert.equal(h.state.calls, 2);
    assert.equal(h.ctx.chat.length, 1);
    assert.equal(h.ctx.chat[0].mes, '正常回复');
    assert.deepEqual(h.state.errors, []);
    h.dispose();
});
test('repeated rejection is bounded and retains final reply', async () => {
    const h = harness({ replies: ['拒绝'] });
    h.begin('拒绝');
    await sleep(230);
    assert.equal(h.state.calls, 2);
    assert.equal(h.state.limits, 1);
    assert.equal(h.ctx.chat[0].mes, '拒绝');
    h.dispose();
});
test('stop, chat switch, edits, and deletion cancel deferred retry', async () => {
    for (const name of ['GENERATION_STOPPED', 'CHAT_CHANGED', 'MESSAGE_EDITED', 'MESSAGE_DELETED']) {
        const h = harness(); h.begin('拒绝'); h.emit(name); await sleep(70);
        assert.equal(h.state.calls, 0, name); h.dispose();
    }
});
test('stale history, quiet generation and user tail never trigger', async () => {
    const h = harness();
    h.ctx.chat.push({ mes: '拒绝' });
    h.emit('GENERATION_STARTED', 'normal', {}, false); h.emit('GENERATION_ENDED');
    await sleep(70); assert.equal(h.state.calls, 0);
    h.emit('GENERATION_STARTED', 'quiet', {}, false); h.receive('拒绝');
    await sleep(70); assert.equal(h.state.calls, 0);
    h.begin('拒绝'); h.ctx.chat.push({ is_user: true, mes: 'hello' });
    await sleep(70); assert.equal(h.state.calls, 0); h.dispose();
});
test('disabling while waiting prevents generation and duplicate end events do not double retry', async () => {
    let release;
    const h = harness({ limiter: { wait: () => new Promise(resolve => { release = resolve; }) } });
    h.begin('拒绝'); h.emit('GENERATION_ENDED');
    await sleep(80);
    h.state.settings.contentEnabled = false; release();
    await sleep(30); assert.equal(h.state.calls, 0); h.dispose();
});

test('content delay settings accept seconds and normalize invalid persisted values', () => {
    assert.equal(normalizeSettings({}).contentCheckDelaySeconds, 0);
    for (const value of [-1, 'bad', Infinity]) {
        assert.equal(normalizeSettings({ contentCheckDelaySeconds: value }).contentCheckDelaySeconds, 0);
    }
    assert.equal(normalizeSettings({ contentCheckDelaySeconds: '0.15' }).contentCheckDelaySeconds, 0.15);
    assert.equal(normalizeSettings({ contentCheckDelaySeconds: 99999 }).contentCheckDelaySeconds, 3600);
});

test('each generation waits the configured delay and duplicate end events do not bypass it', async () => {
    const h = harness({ config: { contentCheckDelaySeconds: 0.15 }, replies: ['拒绝', '正常回复'] });
    try {
        h.begin('拒绝');
        h.emit('GENERATION_ENDED');
        await sleep(100);
        assert.equal(h.state.calls, 0);
        await sleep(160);
        assert.equal(h.state.calls, 1);
        await sleep(230);
        assert.equal(h.state.calls, 2);
        assert.deepEqual(h.state.errors, []);
    } finally { h.dispose(); }
});

test('content is read after the delay, not when generation ends', async () => {
    const h = harness({ config: { contentCheckDelaySeconds: 0.15 } });
    try {
        h.begin('正常回复');
        await sleep(100);
        h.ctx.chat[0].mes = '拒绝';
        assert.equal(h.state.calls, 0);
        await sleep(160);
        assert.equal(h.state.calls, 1);
    } finally { h.dispose(); }
});

test('cancellation, disabling, and updated accepted text prevent retry during the delay', async () => {
    const actions = [
        ...['GENERATION_STOPPED', 'CHAT_CHANGED', 'MESSAGE_EDITED', 'MESSAGE_DELETED'].map(name => h => h.emit(name)),
        h => h.emit('GENERATION_STARTED', 'normal', {}, false),
        h => { h.state.settings.contentEnabled = false; },
        h => { h.state.settings.mode = 'disabled'; },
        h => { h.ctx.chat[0].mes = '正常回复'; },
        h => h.dispose(),
    ];
    await Promise.all(actions.map(async action => {
        const h = harness({ config: { contentCheckDelaySeconds: 0.15 } });
        try {
            h.begin('拒绝');
            await sleep(100);
            action(h);
            await sleep(160);
            assert.equal(h.state.calls, 0);
            assert.deepEqual(h.state.errors, []);
        } finally { h.dispose(); }
    }));
});

test('configured delay begins after generation is no longer busy', async () => {
    let busy = true;
    const h = harness({ config: { contentCheckDelaySeconds: 0.15 }, busy: () => busy });
    try {
        h.begin('拒绝');
        await sleep(220);
        assert.equal(h.state.calls, 0);
        busy = false;
        await sleep(100);
        assert.equal(h.state.calls, 0);
        await sleep(170);
        assert.equal(h.state.calls, 1);
    } finally { h.dispose(); }
});
