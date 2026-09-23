'use strict';

/* 触界 —— 服务器端神经网络 TTS（微软 Edge 公开语音接口，零依赖实现）
 *
 * 输出：audio-24khz-48kbitrate-mono-mp3
 * 原理：裸 TLS + 手写 WebSocket 客户端，与 speech.platform.bing.com 交互。
 * 带磁盘缓存：同一文本+音色只合成一次。
 */

const tls = require('tls');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TTS_HOST = 'speech.platform.bing.com';
const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const SEC_MS_GEC_VERSION = '1-143.0.3650.75';
const ORIGIN = 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0';

// 微软 DRM 挑战：Windows FILETIME 向下取整 5 分钟 + 令牌 的 SHA256 大写十六进制
function secMsGec() {
  const WIN_EPOCH = 11644473600;
  let ticks = Math.floor((Date.now() / 1000 + WIN_EPOCH) * 1e7);
  ticks -= ticks % 3000000000;
  return crypto.createHash('sha256').update(String(ticks) + TRUSTED_CLIENT_TOKEN).digest('hex').toUpperCase();
}

function ttsPath() {
  return (
    `/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
    `&ConnectionId=${crypto.randomUUID().replace(/-/g, '')}` +
    `&Sec-MS-GEC=${secMsGec()}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`
  );
}

const VOICES = {
  xiaoxiao: { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓（女声，温暖）' },
  yunxi: { id: 'zh-CN-YunxiNeural', label: '云希（男声，沉稳）' },
  yunyang: { id: 'zh-CN-YunyangNeural', label: '云扬（男声，播报）' },
};

const MAX_TEXT = 800; // 单段上限，超出按句子切分

// ---------------------------------------------------------------- 时间戳
function msTimestamp() {
  const d = new Date();
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const mons = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${days[d.getUTCDay()]} ${mons[d.getUTCMonth()]} ${p(d.getUTCDate())} ${d.getUTCFullYear()} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`
  );
}

// ---------------------------------------------------------------- WebSocket 客户端（最小实现：文本/二进制帧、ping/pong、分片合并）
function wsOpen() {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const sock = tls.connect({ host: TTS_HOST, port: 443, servername: TTS_HOST }, () => {
      sock.write(
        `GET ${ttsPath()} HTTP/1.1\r\nHost: ${TTS_HOST}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nOrigin: ${ORIGIN}\r\nUser-Agent: ${UA}\r\n\r\n`
      );
    });
    sock.setTimeout(20000);

    let buf = Buffer.alloc(0);
    let handshaken = false;
    let pendingFrag = null; // { opcode, chunks: [] }

    const handlers = { text: [], binary: [], close: [] };
    const sendQueue = [];
    const api = {
      sendText(str) {
        sendQueue.push(buildFrame(0x1, Buffer.from(String(str), 'utf8')));
        flush();
      },
      onText(fn) { handlers.text.push(fn); },
      onBinary(fn) { handlers.binary.push(fn); },
      close() { try { sock.destroy(); } catch (e) { /* noop */ } },
    };

    function flush() {
      while (handshaken && sendQueue.length) {
        const frame = sendQueue.shift();
        try { sock.write(frame); } catch (e) { /* noop */ }
      }
    }

    function buildFrame(opcode, payload) {
      const mask = crypto.randomBytes(4);
      const len = payload.length;
      let head;
      if (len < 126) {
        head = Buffer.alloc(2);
        head[1] = 0x80 | len;
      } else if (len < 65536) {
        head = Buffer.alloc(4);
        head[1] = 0x80 | 126;
        head.writeUInt16BE(len, 2);
      } else {
        head = Buffer.alloc(10);
        head[1] = 0x80 | 127;
        head.writeBigUInt64BE(BigInt(len), 2);
      }
      head[0] = 0x80 | opcode; // FIN=1
      const masked = Buffer.alloc(len);
      for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
      return Buffer.concat([head, mask, masked]);
    }

    function handleFrame(fin, opcode, payload) {
      // 分片：非 FIN 先暂存；FIN 到达时合并
      if (!fin || (opcode === 0x0 && pendingFrag)) {
        if (opcode !== 0x0) pendingFrag = { opcode, chunks: [payload] };
        else pendingFrag.chunks.push(payload);
        if (!fin) return;
        const merged = { opcode: pendingFrag.opcode, payload: Buffer.concat(pendingFrag.chunks) };
        pendingFrag = null;
        return handleFrame(true, merged.opcode, merged.payload);
      }
      if (opcode === 0x1) handlers.text.forEach((fn) => fn(payload.toString('utf8')));
      else if (opcode === 0x2) handlers.binary.forEach((fn) => fn(payload));
      else if (opcode === 0x8) api.close(); // 服务端关闭
      else if (opcode === 0x9) sendQueue.push(buildFrame(0xa, payload)); // ping -> pong
    }

    function parseFrames() {
      for (;;) {
        if (buf.length < 2) return;
        const b0 = buf[0];
        const b1 = buf[1];
        const fin = !!(b0 & 0x80);
        const opcode = b0 & 0x0f;
        const masked = !!(b1 & 0x80);
        let len = b1 & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2); off = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          len = Number(buf.readBigUInt64BE(2)); off = 10;
        }
        let maskKey = null;
        if (masked) {
          if (buf.length < off + 4) return;
          maskKey = buf.slice(off, off + 4); off += 4;
        }
        if (buf.length < off + len) return;
        let payload = buf.slice(off, off + len);
        buf = buf.slice(off + len);
        if (maskKey) {
          const out = Buffer.alloc(len);
          for (let i = 0; i < len; i++) out[i] = payload[i] ^ maskKey[i % 4];
          payload = out;
        }
        handleFrame(fin, opcode, payload);
      }
    }

    sock.on('data', (chunk) => {
      if (!handshaken) {
        buf = Buffer.concat([buf, chunk]);
        const idx = buf.indexOf('\r\n\r\n');
        if (idx === -1) return;
        const head = buf.slice(0, idx).toString('latin1');
        if (!/^HTTP\/1\.1 101/.test(head)) {
          sock.destroy();
          return reject(new Error('TTS 握手失败: ' + head.split('\r\n')[0]));
        }
        buf = buf.slice(idx + 4);
        handshaken = true;
        flush();
        resolve(api);
      } else {
        buf = Buffer.concat([buf, chunk]);
      }
      parseFrames();
    });
    sock.on('timeout', () => { sock.destroy(); });
    sock.on('error', (e) => { if (!handshaken) reject(e); });
  });
}

// ---------------------------------------------------------------- 合成单段
function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function synthesizeOnce(text, voiceId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { try { wsRef && wsRef.close(); } catch (e) { /* noop */ } reject(new Error('TTS 超时')); }, 20000);
    let wsRef = null;
    (async () => {
      try {
        const ws = await wsOpen();
        wsRef = ws;
        const chunks = [];

        ws.onText((msg) => {
          if (msg.includes('Path:turn.end')) {
            clearTimeout(timeout);
            ws.close();
            resolve(Buffer.concat(chunks));
          }
        });
        ws.onBinary((frame) => {
          // 二进制帧：前 2 字节 BE = 头部长度，其后是 JSON 头，剩余是音频数据
          if (frame.length < 2) return;
          const headLen = frame.readUInt16BE(0);
          if (frame.length <= headLen + 2) return;
          const header = frame.slice(2, 2 + headLen).toString('utf8');
          if (header.includes('Path:audio')) chunks.push(frame.slice(2 + headLen));
        });

        const reqId = crypto.randomUUID().replace(/-/g, '');
        ws.sendText(
          `X-Timestamp:${msTimestamp()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
            JSON.stringify({
              context: {
                synthesis: {
                  audio: {
                    metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' },
                    outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
                  },
                },
              },
            })
        );
        ws.sendText(
          `X-RequestId:${reqId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${msTimestamp()}Z\r\nPath:ssml\r\n\r\n` +
            `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'>` +
            `<voice name='${voiceId}'>` +
            `<prosody pitch='+0Hz' rate='+0%' volume='+0%'>${escapeXml(text)}</prosody>` +
            `</voice></speak>`
        );
      } catch (e) {
        clearTimeout(timeout);
        reject(e);
      }
    })();
  });
}

// 按句子切成 ≤MAX_TEXT 的段（MP3 缓冲直接拼接即可播放）
function splitText(text) {
  const src = String(text).replace(/\s+/g, ' ').trim();
  if (src.length <= MAX_TEXT) return [src];
  const parts = [];
  let cur = '';
  for (const piece of src.split(/(?<=[。！？；\n])/)) {
    if ((cur + piece).length > MAX_TEXT && cur) { parts.push(cur); cur = ''; }
    if (piece.length > MAX_TEXT) {
      // 超长无标点句，硬切
      for (let i = 0; i < piece.length; i += MAX_TEXT) {
        parts.push(piece.slice(i, i + MAX_TEXT));
      }
    } else cur += piece;
  }
  if (cur) parts.push(cur);
  return parts.filter(Boolean);
}

// ---------------------------------------------------------------- 缓存 + 对外接口
class TTS {
  constructor(cacheDir, defaultVoice) {
    this.cacheDir = cacheDir;
    this.defaultVoice = VOICES[defaultVoice] ? defaultVoice : 'xiaoxiao';
    this.enabled = process.env.TOUCHTAG_TTS !== 'off';
    try { fs.mkdirSync(cacheDir, { recursive: true }); } catch (e) { this.enabled = false; }
  }

  async getAudio(text, voiceKey) {
    const v = VOICES[voiceKey] || VOICES.xiaoxiao;
    const clean = splitText(text).join('');
    if (!clean || !this.enabled) throw new Error('TTS 不可用');
    const hash = crypto.createHash('sha1').update(v.id + '|' + clean).digest('hex');
    const file = path.join(this.cacheDir, hash + '.mp3');
    try { return fs.readFileSync(file); } catch (e) { /* 未缓存 */ }
    const parts = splitText(text);
    const buffers = [];
    for (const p of parts) buffers.push(await synthesizeOnce(p, v.id));
    const out = Buffer.concat(buffers);
    const tmp = file + '.tmp-' + process.pid;
    try {
      fs.writeFileSync(tmp, out);
      fs.renameSync(tmp, file);
    } catch (e) { /* 缓存写失败不影响返回 */ }
    return out;
  }

  status() {
    const dv = VOICES[this.defaultVoice] || VOICES.xiaoxiao;
    return {
      enabled: this.enabled,
      voice: this.defaultVoice,
      voice_label: dv.label,
      voices: VOICES,
    };
  }

  /* 预热：把一批文本提前合成进磁盘缓存。
   * 现场 Demo 前跑一次，物品页打开即播，延迟从 3.5 秒降到毫秒级（PRD F04 ≤3 秒）。
   * 并发 3：单条合成受上游限制约 1.5–3 秒，串行 27 段要一分多钟，会顶到网关超时。
   */
  async warm(texts, voiceKey = 'xiaoxiao', concurrency = 3) {
    const list = (texts || []).filter((t) => t && String(t).trim());
    const v = VOICES[voiceKey] || VOICES.xiaoxiao;
    const started = Date.now();
    let generated = 0;
    let cached = 0;
    let failed = 0;
    let cursor = 0;

    const worker = async () => {
      for (;;) {
        const i = cursor;
        cursor += 1;
        if (i >= list.length) return;
        const clean = String(list[i]).trim().slice(0, 1000);
        const hash = crypto.createHash('sha1').update(v.id + '|' + splitText(clean).join('')).digest('hex');
        const hit = fs.existsSync(path.join(this.cacheDir, hash + '.mp3'));
        try {
          await this.getAudio(clean, voiceKey);
          if (hit) cached += 1;
          else generated += 1;
        } catch (e) {
          failed += 1;
          console.error('[tts] 预热失败:', e.message, '|', clean.slice(0, 30));
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, list.length || 1) }, worker));
    return { total: list.length, generated, cached, failed, elapsed_ms: Date.now() - started };
  }
}

module.exports = { TTS, VOICES };
