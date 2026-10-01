import { normalizeSettings, RETRY_MODES, waitWithSignal } from './core.mjs';

export function compileRules(value) {
    const rules = [];
    const errors = [];
    String(value ?? '').split(/\r?\n/).forEach((line, index) => {
        const rule = line.trim();
        if (!rule) return;
        if (!rule.startsWith('/')) {
            rules.push({ label: rule, test: text => text.includes(rule) });
            return;
        }
        try {
            const end = rule.lastIndexOf('/');
            if (end === 0) throw new Error('请使用 /表达式/flags 格式');
            const regex = new RegExp(rule.slice(1, end), rule.slice(end + 1));
            rules.push({ label: rule, test: text => { regex.lastIndex = 0; return regex.test(text); } });
        } catch (error) {
            errors.push(`第 ${index + 1} 行：${error.message}`);
        }
    });
    return { rules, errors };
}

export function lastAssistant(chat) {
    if (!Array.isArray(chat)) return null;
    for (let i = chat.length - 1; i >= 0; i--) {
        const message = chat[i];
        if (!message || message.is_user || message.is_system) continue;
        if (typeof message.mes === 'string') return { message, index: i, text: message.mes };
    }
    return null;
}

export function matchContent(text, settings) {
    if (!settings.contentEnabled || settings.mode === RETRY_MODES.DISABLED) return null;
    const match = compileRules(settings.contentRules).rules.find(rule => rule.test(text));
    if (match) return { reason: 'content_match', rule: match.label };
    const length = Array.from(text).length;
    if (settings.minResponseLength > 0 && length < settings.minResponseLength) {
        return { reason: 'content_short', length, minimum: settings.minResponseLength };
    }
    return null;
}

// Event callbacks never await generation: ST awaits its own event listeners.
export function installContentRetry({ getContext, getSettings, limiter, isBusy,
    onRetry = () => {}, onLimit = () => {}, onError = console.error }) {
    const { eventSource: events, eventTypes: types } = getContext();
    let chain = null;
    let ownStart = false;
    let ownDelete = false;
    const cancel = () => { chain?.controller.abort(); chain = null; };
    const identity = ctx => JSON.stringify([ctx.groupId, ctx.characterId, ctx.getCurrentChatId()]);
    const start = (type, _options, dryRun) => {
        if (ownStart && type === 'regenerate') { ownStart = false; return; }
        cancel();
        if (dryRun || getContext().groupId || ['quiet', 'impersonate'].includes(type)) return;
        chain = { id: identity(getContext()), controller: new AbortController(), retries: 0, received: null, pending: false };
    };
    const received = (id, type) => {
        if (!chain || ['quiet', 'impersonate', 'first_message'].includes(type)) return;
        chain.received = getContext().chat[id];
    };
    const check = async current => {
        try {
            // Generation cleanup and group turns can finish after GENERATION_ENDED.
            await waitWithSignal(50, current.controller.signal);
            while (isBusy()) await waitWithSignal(100, current.controller.signal);
            // Start the configurable delay after generation cleanup, then read the latest text.
            const delaySeconds = normalizeSettings(getSettings()).contentCheckDelaySeconds;
            if (delaySeconds > 0) await waitWithSignal(delaySeconds * 1000, current.controller.signal);
            while (isBusy()) await waitWithSignal(100, current.controller.signal);
            if (chain !== current || current.id !== identity(getContext())) return;
            const ctx = getContext();
            const last = lastAssistant(ctx.chat);
            if (!last || last.index !== ctx.chat.length - 1 || last.message !== current.received) return;
            const settings = normalizeSettings(getSettings());
            const match = matchContent(last.text, settings);
            if (!match) return;
            if (current.retries >= settings.maxRetries) { onLimit(); cancel(); return; }
            await limiter.wait(settings.maxRetryRpm, current.controller.signal, 0, delayMs => {
                onRetry({ ...match, retryNumber: current.retries + 1, maxRetries: settings.maxRetries, delayMs });
            });
            if (chain !== current || current.id !== identity(getContext()) || isBusy()) return;
            const latest = lastAssistant(getContext().chat);
            if (!latest || latest.message !== last.message || latest.text !== last.text
                || latest.index !== getContext().chat.length - 1
                || !matchContent(latest.text, normalizeSettings(getSettings()))) return;
            current.retries++;
            current.received = null;
            current.pending = false;
            ownStart = true;
            ownDelete = true;
            // Regenerate replaces the rejected last reply using ST's normal lifecycle.
            await getContext().generate('regenerate');
        } catch (error) {
            if (error?.name !== 'AbortError') { onError(error); if (chain === current) cancel(); }
        } finally { ownStart = false; ownDelete = false; }
    };
    const ended = () => {
        if (!chain || chain.pending || !chain.received) return;
        chain.pending = true;
        void check(chain);
    };
    const subscriptions = [
        [types.GENERATION_STARTED, start], [types.MESSAGE_RECEIVED, received],
        [types.GENERATION_ENDED, ended], [types.GENERATION_STOPPED, cancel],
        [types.CHAT_CHANGED, cancel], [types.MESSAGE_EDITED, cancel],
        [types.MESSAGE_DELETED, () => { if (ownDelete) { ownDelete = false; return; } cancel(); }],
    ];
    for (const [type, handler] of subscriptions) events.on(type, handler);
    return () => { cancel(); for (const [type, handler] of subscriptions) events.removeListener(type, handler); };
}
