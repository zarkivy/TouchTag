'use strict';

/* 触界 —— 前端共享脚本
 * 语音策略：优先播放服务器端神经网络语音（/api/tts），失败自动回退到浏览器 speechSynthesis。
 * 所有交互保留原生 HTML 兜底，读屏用户与低版本浏览器都不受影响。
 */

// ------------------------------------------------------------------ 工具
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function api(path, options = {}) {
  const opts = { headers: {}, ...options };
  if (opts.body && typeof opts.body !== 'string') {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, opts);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (e) {
    data = { error: text };
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || `请求失败（${res.status}）`);
    err.status = res.status;
    err.payload = data;
    throw err;
  }
  return data;
}

function idFromPath(prefix) {
  const parts = window.location.pathname.split('/').filter(Boolean);
  const q = new URLSearchParams(window.location.search).get('id');
  if (prefix && parts[0] === prefix && parts[1]) return parts[1].toUpperCase();
  return q ? q.toUpperCase() : '';
}

/* 顶部/底部浮动提示。
 * 注意：这个盒子是 position:fixed 的，清空内容时**必须一并隐藏**。
 * 曾经只清 textContent 不隐藏，于是屏幕上永久挂着一个空的黑色胶囊
 * （padding 撑出来 46×30px，正好在视口底部正中），看起来就像页面"显示错乱"。
 */
function toast(msg, kind = 'ok') {
  if (!msg) return;
  let box = $('#toast');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toast';
    box.setAttribute('role', 'status');
    box.setAttribute('aria-live', 'polite');
    box.style.cssText =
      'position:fixed;left:50%;bottom:26px;transform:translateX(-50%);max-width:min(560px,90vw);' +
      'padding:14px 22px;border-radius:14px;font-size:.95rem;z-index:99;border:1px solid transparent;' +
      'background:#1C1917;color:#fff;box-shadow:0 12px 32px rgba(28,25,23,.22)';
    document.body.appendChild(box);
  }
  box.textContent = msg;
  box.style.display = 'block'; // 上一次消失时被隐藏了，这里恢复
  box.style.background = kind === 'error' ? '#B42318' : '#1C1917';
  box.style.color = '#fff';
  clearTimeout(box._t);
  box._t = setTimeout(() => {
    box.textContent = '';
    box.style.display = 'none';
  }, 5200);
}

// ------------------------------------------------------------------ 触觉标签系统
let TACTILE_CACHE = null;

async function loadTactile() {
  if (TACTILE_CACHE) return TACTILE_CACHE;
  TACTILE_CACHE = await api('/api/tactile');
  return TACTILE_CACHE;
}

/* 兼容辅助：拿外形/图案清单（旧代码里叫 symbols） */
async function loadSymbols() {
  const t = await loadTactile();
  return t.shapes || [];
}

function shapeSvg(shape, cls = 'symbol') {
  if (!shape) return '';
  return (
    `<svg class="${cls}" viewBox="0 0 100 100" role="img" aria-label="标签外形：${escapeHtml(shape.name)}">` +
    `<title>${escapeHtml(shape.name)}</title>${shape.path}</svg>`
  );
}

/* 一枚完整标签的预览：外形轮廓 + NFC 双凸点。
 * 2026-09-23 起不再画「表面图案」——实体是 3D 打印的小卡片，外形一个轴就够了。
 */
function tagPreviewSvg(shape, cls = 'symbol', uid = 'p') {
  if (!shape) return '';
  return (
    `<svg class="${cls}" viewBox="0 0 100 100" role="img" aria-label="触觉标签：${escapeHtml(shape.name)}外形" data-uid="${escapeHtml(uid)}">` +
    `<title>${escapeHtml(shape.name)}外形</title>` +
    `<g class="tag-outline">${shape.path}</g>` +
    `<g class="tag-nfc"><circle cx="41" cy="30" r="7" /><circle cx="59" cy="30" r="7" /></g>` +
    `</svg>`
  );
}

async function symbolBoxes(ids, cls = 'symbol') {
  const { shapes } = await loadTactile();
  return ids
    .map((id) => shapes.find((s) => s.id === id))
    .filter(Boolean)
    .map(
      (s) =>
        `<figure class="symbol-box" style="margin:0">${shapeSvg(s, cls)}<figcaption class="name">${escapeHtml(
          s.name
        )}</figcaption></figure>`
    )
    .join('');
}

// ------------------------------------------------------------------ 语音播报
/* 两级语音：
 *   1. 服务器神经网络语音（晓晓等，自然、有情感）—— GET /api/tts?text=…
 *   2. 浏览器自带合成（离线兜底）
 * speak() 对调用方保持同步接口；内部自动选择可用通道。
 */
const Speaker = {
  supported: typeof window !== 'undefined' && 'speechSynthesis' in window,
  voice: null,
  rate: Number(localStorage.getItem('tt-rate') || 0.95),
  onstate: null,
  _speaking: false,
  _audio: null,        // 正在播放的 <audio>
  _serverDead: false,  // 服务器语音连续失败后本会话内直接走浏览器
  _serverFail: 0,
  _wantStop: false,

  pickVoice() {
    if (!this.supported) return;
    const voices = window.speechSynthesis.getVoices();
    if (!voices.length) return;
    const zh = voices.filter((v) => /zh|cmn|Chinese/i.test(`${v.lang} ${v.name}`));
    this.voice =
      zh.find((v) => /Xiaoxiao|晓晓|Yunxi|Tingting|婷婷|Google 普通话|Siri/i.test(v.name)) || zh[0] || null;
  },

  get speaking() {
    if (this._audio && !this._audio.paused) return true;
    return this.supported && window.speechSynthesis.speaking;
  },

  speak(text, onEnd) {
    this.stop();
    this._wantStop = false;
    const clean = String(text || '').slice(0, 900);
    if (!clean) {
      if (onEnd) onEnd();
      return false;
    }
    this._emit(true);

    if (!this._serverDead) {
      this._speakServer(clean, onEnd).catch(() => {
        this._serverFail += 1;
        if (this._serverFail >= 2) this._serverDead = true;
        if (!this._wantStop) this._speakBrowser(clean, onEnd);
      });
      return true;
    }
    return this._speakBrowser(clean, onEnd);
  },

  async _speakServer(text, onEnd) {
    const voice = localStorage.getItem('tt-voice') || 'xiaoxiao';
    const url = '/api/tts?voice=' + encodeURIComponent(voice) + '&text=' + encodeURIComponent(text);
    const a = new Audio();
    a.preload = 'auto';
    this._audio = a;
    const cleanup = () => {
      if (this._audio === a) this._audio = null;
      a.onended = null;
      a.onerror = null;
    };
    a.onended = () => {
      cleanup();
      this._emit(false);
      if (onEnd && !this._wantStop) onEnd();
    };
    // 服务器/网络出错：回退浏览器合成，用户不会突然没声音
    a.onerror = () => {
      cleanup();
      this._serverFail += 1;
      if (this._serverFail >= 2) this._serverDead = true;
      if (!this._wantStop) this._speakBrowser(text, onEnd);
      else this._emit(false);
    };
    a.src = url; // 直接给 URL：浏览器边下边播，弱网也能在 3 秒内出声
    try {
      await a.play();
    } catch (e) {
      // 自动播放被拦截（无用户手势）：不是服务器问题，交给 UI 提示用户点按钮
      cleanup();
      this._serverFail = 0;
      this._emit(false);
      if (this.onblocked && typeof this.onblocked === 'function') this.onblocked();
      throw e;
    }
  },

  _speakBrowser(text, onEnd) {
    if (!this.supported) {
      toast('这台设备暂时发不出语音，文字内容就在页面上。', 'error');
      this._emit(false);
      if (onEnd) onEnd();
      return false;
    }
    const synth = window.speechSynthesis;
    synth.cancel();
    clearTimeout(this._watchdog);
    const u = new SpeechSynthesisUtterance(text);
    if (!this.voice) this.pickVoice();
    if (this.voice) u.voice = this.voice;
    u.lang = (this.voice && this.voice.lang) || 'zh-CN';
    u.rate = this.rate;
    u.pitch = 1;
    const finish = () => {
      clearTimeout(this._watchdog);
      this._emit(false);
      if (onEnd && !this._wantStop) onEnd();
    };
    u.onend = finish;
    u.onerror = finish;
    synth.speak(u);
    this._emit(true);
    // 看门狗：部分浏览器不触发 onend，避免按钮卡在「停止」
    const estimateMs = Math.max(6000, (text.length / 4) * 1000 + 5000);
    this._watchdog = setTimeout(() => {
      if (!window.speechSynthesis.speaking) finish();
    }, estimateMs);
    return true;
  },

  stop() {
    this._wantStop = true;
    if (this._audio) {
      const a = this._audio;
      this._audio = null;   // 先摘引用，避免 error/ended 回调再触发状态翻转
      a.onended = null;
      a.onerror = null;
      try {
        a.pause();
        a.removeAttribute('src');
      } catch (e) { /* noop */ }
    }
    if (this.supported) window.speechSynthesis.cancel();
    this._emit(false);
  },

  _emit(state) {
    this._speaking = state;
    if (typeof this.onstate === 'function') this.onstate(state);
  },

  setRate(r) {
    this.rate = Number(r);
    localStorage.setItem('tt-rate', String(this.rate));
  },
};

if (Speaker.supported) {
  window.speechSynthesis.onvoiceschanged = () => Speaker.pickVoice();
  Speaker.pickVoice();
}

// 播放按钮绑定：自动处理「播放 / 停止」状态与 aria
function bindSpeakButton(button, getText, liveRegion) {
  if (!button) return;
  let busy = false;
  const render = (speaking) => {
    busy = speaking;
    button.setAttribute('aria-pressed', String(speaking));
    const label = button.querySelector('[data-label]');
    if (label) label.textContent = speaking ? '停止播报' : button.dataset.idleLabel || '播放';
  };
  render(false);
  Speaker.onstate = (s) => render(s);
  button.addEventListener('click', () => {
    button.classList.remove('btn-pulse');
    if (busy || Speaker.speaking) {
      Speaker.stop();
      return;
    }
    const text = typeof getText === 'function' ? getText() : String(getText);
    if (!text) {
      toast('这段内容还没有可播报的文字。', 'error');
      return;
    }
    if (liveRegion) liveRegion.textContent = text;
    Speaker.speak(text);
  });
  // 浏览器拦截自动播放时，给按钮加呼吸光圈提示「点我」
  Speaker.onblocked = () => button.classList.add('btn-pulse');
}

function repeatButton(button, getText, liveRegion) {
  if (!button) return;
  button.dataset.idleLabel = button.dataset.idleLabel || '再播一次';
  const label = button.querySelector('[data-label]');
  if (label) label.textContent = '再播一次';
  button.addEventListener('click', () => {
    const text = typeof getText === 'function' ? getText() : String(getText);
    if (liveRegion) liveRegion.textContent = text;
    Speaker.speak(text);
  });
}

// ------------------------------------------------------------------ 显示偏好
/* 「放大字号 / 高对比度」两个开关已从界面上撤掉（各页顶栏不再有这排按钮）。
 * 这里同时清掉历史遗留的本地偏好，否则之前开过大字号的人会一直卡在大字号上，
 * 而屏幕上已经没有能把它切回来的按钮了。CSS 里的 html[data-scale|data-contrast]
 * 规则保留着，将来要重新接开关时还在。
 */
function dropLegacyPrefs() {
  try {
    localStorage.removeItem('tt-scale');
    localStorage.removeItem('tt-contrast');
  } catch (e) { /* 隐私模式下 localStorage 不可用，忽略 */ }
}

// 高亮当前导航项
function markCurrentNav() {
  const here = window.location.pathname;
  $$('.site-nav a').forEach((a) => {
    const href = a.getAttribute('href') || '';
    const inItems = /^\/(items|i|ask|bind|print)\b/.test(here) && href === '/items';
    if (href === here || inItems) a.setAttribute('aria-current', 'page');
  });
}

document.addEventListener('DOMContentLoaded', () => {
  dropLegacyPrefs();
  markCurrentNav();
});
