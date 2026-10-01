import { compileRules, installContentRetry } from './content.mjs';
import { saveSettingsDebounced, is_send_press } from '/script.js';
import { extension_settings, renderExtensionTemplateAsync } from '/scripts/extensions.js';
import {
    RETRY_MODES,
    RETRY_REASONS,
    RetryRateLimiter,
    createRetryingFetch,
    normalizeSettings,
} from './core.mjs';

const SETTINGS_KEY = 'autoRetry';
const MODULE_MARKER = '/scripts/extensions/';
const FETCH_STATE_KEY = Symbol.for('SillyTavern.autoRetry.fetchState');
let settings;
let disposeContentRetry;

function getExtensionPath() {
    const pathname = decodeURIComponent(new URL('.', import.meta.url).pathname);
    const markerIndex = pathname.indexOf(MODULE_MARKER);
    if (markerIndex === -1) return 'auto-retry';
    return pathname.slice(markerIndex + MODULE_MARKER.length).replace(/\/$/, '');
}

function syncFetchState() {
    const state = globalThis[FETCH_STATE_KEY];
    if (state) state.settings = settings;
}

function loadSettings() {
    settings = normalizeSettings(extension_settings[SETTINGS_KEY]);
    extension_settings[SETTINGS_KEY] = settings;
    syncFetchState();
}

function persistSettings(changes) {
    settings = normalizeSettings({ ...settings, ...changes });
    extension_settings[SETTINGS_KEY] = settings;
    syncFetchState();
    saveSettingsDebounced();
}

function describeReason({ reason, status }) {
    if (reason === 'content_match') return '最后一条 AI 回复命中内容规则';
    if (reason === 'content_short') return '最后一条 AI 回复长度不足';
    if (reason === RETRY_REASONS.EMPTY_RESPONSE) return '检测到空回复';
    if (reason === RETRY_REASONS.NETWORK_ERROR) return '网络请求失败';
    if (status) return `API 返回 HTTP ${status}`;
    return 'API 返回错误';
}

function reportRetry(event) {
    const seconds = Math.ceil(event.delayMs / 1000);
    const waitText = seconds > 0 ? `，将在 ${seconds} 秒后重试` : '，正在重试';
    const message = `${describeReason(event)}${waitText}（${event.retryNumber}/${event.maxRetries}）`;
    console.info(`[自动重试] ${message}`);
    globalThis.toastr?.info(message, '自动重试');
}

function installFetchWrapper() {
    const existing = globalThis[FETCH_STATE_KEY];
    if (existing) {
        existing.settings = settings;
        return;
    }

    const state = {
        settings,
        originalFetch: globalThis.fetch.bind(globalThis),
        limiter: new RetryRateLimiter(),
        wrappedFetch: null,
    };
    state.wrappedFetch = createRetryingFetch(state.originalFetch, {
        getSettings: () => state.settings,
        limiter: state.limiter,
        onRetry: reportRetry,
    });
    globalThis[FETCH_STATE_KEY] = state;
    globalThis.fetch = state.wrappedFetch;
}

function bindCommittedNumber(input, key) {
    const commit = () => {
        persistSettings({ [key]: input.value });
        input.value = String(settings[key]);
    };
    input.addEventListener('change', commit);
    input.addEventListener('keydown', event => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        commit();
        input.blur();
    });
}

async function renderSettings() {
    const container = document.getElementById('extensions_settings2');
    if (!container || document.getElementById('auto-retry-settings')) return;

    const html = await renderExtensionTemplateAsync(getExtensionPath(), 'settings');
    const wrapper = document.createElement('div');
    wrapper.innerHTML = html;
    container.appendChild(wrapper.firstElementChild);

    for (const input of document.querySelectorAll('input[name="auto-retry-mode"]')) {
        input.checked = input.value === settings.mode;
        input.addEventListener('change', () => {
            if (input.checked) persistSettings({ mode: input.value });
        });
    }

    const rpmInput = document.getElementById('auto-retry-rpm');
    const countInput = document.getElementById('auto-retry-count');
    rpmInput.value = String(settings.maxRetryRpm);
    countInput.value = String(settings.maxRetries);
    bindCommittedNumber(rpmInput, 'maxRetryRpm');
    bindCommittedNumber(countInput, 'maxRetries');
    const enabled = document.getElementById('auto-retry-content-enabled');
    enabled.checked = settings.contentEnabled;
    enabled.addEventListener('change', () => persistSettings({ contentEnabled: enabled.checked }));
    const rules = document.getElementById('auto-retry-content-rules');
    const error = document.getElementById('auto-retry-content-errors');
    rules.value = settings.contentRules;
    const validate = () => { error.textContent = compileRules(rules.value).errors.join('\n'); };
    rules.addEventListener('input', () => { persistSettings({ contentRules: rules.value }); validate(); });
    validate();
    const minimum = document.getElementById('auto-retry-min-length');
    minimum.value = String(settings.minResponseLength);
    bindCommittedNumber(minimum, 'minResponseLength');
}

export async function init() {
    loadSettings();
    installFetchWrapper();
    disposeContentRetry?.();
    disposeContentRetry = installContentRetry({
        getContext: () => SillyTavern.getContext(),
        getSettings: () => settings,
        limiter: globalThis[FETCH_STATE_KEY].limiter,
        isBusy: () => is_send_press,
        onRetry: reportRetry,
        onLimit: () => globalThis.toastr?.warning('内容重试已达到次数上限，保留最后一次回复。', '自动重试'),
        onError: error => console.error('[自动重试] 内容检查失败', error),
    });
    await renderSettings();
}

export { RETRY_MODES };
