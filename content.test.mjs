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
