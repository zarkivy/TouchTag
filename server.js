'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const { Store, httpError } = require('./lib/store');
const { SHAPES, tagSvg } = require('./lib/tactile');
const stl = require('./lib/stl');
const { TTS, VOICES } = require('./lib/tts');
const speech = require('./lib/speech');
const ai = require('./lib/ai');
const vision = require('./lib/vision');

// 支持 CLI 参数（--port / --host），便于预览环境转发端口
const argv = process.argv.slice(2);
const argVal = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
};
const PORT = Number(argVal('--port') || process.env.PORT || 3000);
const HOST = argVal('--host') || process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.TOUCHTAG_DATA_DIR || path.join(__dirname, 'data');
const PHOTO_DIR = path.join(DATA_DIR, 'photos');
const FORCED_BASE_URL = (process.env.TOUCHTAG_BASE_URL || '').replace(/\/+$/, '');
const TTS_VOICE = process.env.TOUCHTAG_TTS_VOICE || 'xiaoxiao';

const store = new Store(DATA_DIR);
const tts = new TTS(path.join(DATA_DIR, 'audio'), TTS_VOICE);
try { fs.mkdirSync(PHOTO_DIR, { recursive: true }); } catch (e) { /* noop */ }

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function baseUrl(req) {
  if (FORCED_BASE_URL) return FORCED_BASE_URL;
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

function withUrl(req, item) {
  const base = baseUrl(req);
  return {
    ...item,
    nfc_path: `/i/${item.id}`,
    nfc_url: `${base}/i/${item.id}`,
    photo_url: item.photo ? `${base}/api/photos/${item.photo}` : null,
    // 一枚标签的预览 SVG（物体外形 + NFC 双凸点）。已无「表面图案」层。
    tag_svg: tagSvg(item.tag_shape, { uid: item.id }),
    // 3D 打印文件：演示占位（真实版应由外形轮廓挤出成实体）
    stl_url: `/api/items/${item.id}/stl`,
    stl_placeholder_mm: (() => {
      const [w, h] = stl.PLACEHOLDER_MM[item.tag_shape] || stl.PLACEHOLDER_MM.card;
      return { width_mm: w, height_mm: h, thickness_mm: stl.THICKNESS_MM, is_placeholder: true };
    })(),
    // 播报文案由服务端统一生成：与预热缓存一一对应，前端直接用，保证缓存命中
    speech: {
      intro: speech.introSpeech(item),
      actions: item.actions.map((a) => speech.actionSpeech(item, a)),
    },
  };
}

/* 预热音频：创建/更新物品后 fire-and-forget，让现场「碰一下就播」成为可能 */
function warmItemAudio(item) {
  if (!tts.enabled) return Promise.resolve();
  return tts
    .warm(speech.warmTexts(item).map((x) => x.text), TTS_VOICE)
    .then((r) => console.log(`[tts] 预热 ${item.id} ${item.name}：新合成 ${r.generated} 段，命中 ${r.cached} 段，耗时 ${r.elapsed_ms}ms`))
    .catch((e) => console.error('[tts] 预热异常:', e.message));
}

/* 全量预热：跑在后台，用状态查询跟进，避免 27 段串行把网关顶成 504 */
let warmJob = { running: false, started_at: null, finished_at: null, result: null };

function warmStatus() {
  const texts = allWarmTexts();
  return {
    running: warmJob.running,
    started_at: warmJob.started_at,
    finished_at: warmJob.finished_at,
    result: warmJob.result,
    pending_texts: texts.length,
    voice: TTS_VOICE,
  };
}

function allWarmTexts() {
  const texts = [];
  store.listItems().forEach((it) => speech.warmTexts(it).forEach((x) => texts.push(x.text)));
  return texts;
}

async function runWarm() {
  const texts = allWarmTexts();
  const result = await tts.warm(texts, TTS_VOICE, 3);
  warmJob = { running: false, started_at: warmJob.started_at, finished_at: new Date().toISOString(), result };
  console.log(`[tts] 预热完成：共 ${result.total} 段，新合成 ${result.generated}，命中 ${result.cached}，失败 ${result.failed}，耗时 ${result.elapsed_ms}ms`);
  return { ...warmStatus(), ...result };
}

function startWarm() {
  if (warmJob.running) return { ...warmStatus(), note: '预热已经在进行中' };
  warmJob = { running: true, started_at: new Date().toISOString(), finished_at: null, result: null };
  runWarm().catch((e) => {
    warmJob.running = false;
    console.error('[tts] 预热任务失败:', e.message);
  });
  return { ...warmStatus(), note: '预热已在后台开始，可以轮询 GET /api/tts/warm 查看进度' };
}

function sendJSON(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(httpError(413, '请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(httpError(400, '请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

/* HTML 里引用的 /assets/*.css|js 自动带上文件修改时间作为版本号。
 * 这样改一行前端代码、刷新就能看到，不需要手动清缓存，也不会出现
 * 「服务端已更新、演示机还在跑旧脚本」的现场事故。
 */
function versionAssets(html) {
  return html.replace(/\/assets\/([\w.-]+\.(?:css|js))/g, (whole, file) => {
    try {
      const st = fs.statSync(path.join(PUBLIC_DIR, file));
      return `/assets/${file}?v=${Math.floor(st.mtimeMs)}`;
    } catch (e) {
      return whole;
    }
  });
}

function serveStatic(res, relPath) {
  const safe = path.normalize(relPath).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(PUBLIC_DIR, safe);
  if (!full.startsWith(PUBLIC_DIR)) return sendText(res, 403, '禁止访问');
  fs.readFile(full, (err, buf) => {
    if (err) return sendText(res, 404, '页面不存在');
    const ext = path.extname(full).toLowerCase();
    // 页面与前端脚本每次都要回源校验：现场改一行代码，刷新就能看到。
    const revalidate = ['.html', '.js', '.css'].includes(ext);
    let body = buf;
    if (ext === '.html') body = Buffer.from(versionAssets(buf.toString('utf8')), 'utf8');
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': body.length,
      'cache-control': revalidate ? 'no-cache' : 'public, max-age=604800',
    });
    res.end(body);
  });
}

const PAGE_ROUTES = [
  [/^\/$/, 'index.html'],
  [/^\/admin\/?$/, 'admin.html'],
  [/^\/items\/?$/, 'items.html'],
  [/^\/create\/?$/, 'create.html'],
  [/^\/edit\/[A-Za-z0-9]+\/?$/, 'create.html'],
  [/^\/i\/[A-Za-z0-9]+\/?$/, 'item.html'],
  [/^\/ask\/[A-Za-z0-9]+\/?$/, 'item.html'],
  [/^\/bind\/[A-Za-z0-9]+\/?$/, 'bind.html'],
  [/^\/print\/?$/, 'print.html'],
  [/^\/print\/[A-Za-z0-9]+\/?$/, 'print.html'],
  [/^\/demo\/?$/, 'demo.html'],
];

async function handleApi(req, res, url) {
  const seg = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  const method = req.method;

  if (seg[0] === 'health') {
    return sendJSON(res, 200, {
      ok: true,
      engine: ai.llmStatus(),
      vision: vision.vlmStatus(),
      tts: tts.status(),
      uptime_s: Math.round(process.uptime()),
    });
  }

  // 现场自检：真的打一次模型，确认密钥、额度、模型名都对。
  // 路演前跑一遍，比等到评委面前才发现 AI 不通要稳。
  if (seg[0] === 'ai' && seg[1] === 'selftest' && method === 'GET') {
    return sendJSON(res, 200, { llm: await ai.selftest() });
  }

  // 照片：只读，文件名严格校验（防路径穿越）
  if (seg[0] === 'photos' && seg[1] && method === 'GET') {
    const name = seg[1];
    if (!/^[A-Za-z0-9_-]+\.(jpg|jpeg|png|webp)$/i.test(name)) return sendText(res, 400, '文件名不合法');
    const full = path.join(PHOTO_DIR, name);
    return fs.readFile(full, (err, buf) => {
      if (err) return sendText(res, 404, '照片不存在');
      const ext = path.extname(full).toLowerCase();
      res.writeHead(200, {
        'content-type': ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg',
        'content-length': buf.length,
        'cache-control': 'public, max-age=604800',
      });
      res.end(buf);
    });
  }

  // 全量预热语音：现场 Demo 前跑一次，把打开到可听压到 1 秒内（PRD F04）
  // /api/tts/warm       → 后台任务，立刻返回（避免网关超时）
  // /api/tts/warm?wait=1 → 同步等完（本地调试用）
  if (seg[0] === 'tts' && seg[1] === 'warm') {
    if (method === 'GET') return sendJSON(res, 200, warmStatus());
    if (method !== 'POST') return sendJSON(res, 405, { error: '不支持的方法' });
    if (url.searchParams.get('wait') === '1') {
      const r = await runWarm();
      return sendJSON(res, 200, r);
    }
    const state = startWarm();
    return sendJSON(res, 202, state);
  }

  // 神经网络语音：GET /api/tts?text=...&voice=xiaoxiao|yunxi|yunyang → audio/mpeg
  if (seg[0] === 'tts' && method === 'GET') {
    const text = (url.searchParams.get('text') || '').trim().slice(0, 1000);
    const voice = url.searchParams.get('voice') || TTS_VOICE;
    if (!text) return sendJSON(res, 400, { error: '缺少 text 参数' });
    try {
      const mp3 = await tts.getAudio(text, voice);
      res.writeHead(200, {
        'content-type': 'audio/mpeg',
        'content-length': mp3.length,
        'cache-control': 'public, max-age=86400',
      });
      return res.end(mp3);
    } catch (e) {
      console.error('[tts]', e.message);
      return sendJSON(res, 502, { error: '语音合成暂时不可用' });
    }
  }

  if (seg[0] === 'config') {
    return sendJSON(res, 200, {
      base_url: baseUrl(req),
      ai: ai.llmStatus(),
      vision: vision.vlmStatus(),
      tts: tts.status(),
      nfc_platform_notes: {
        iphone: '提前把 HTTPS 短链写进 NDEF，靠系统后台读卡弹通知，点开进 Safari',
        android: '系统可直接打开；Chrome 的 Web NFC 需要 HTTPS、用户手势和权限',
        writing: '现场用 NFC Tools 预写，或 Android Chrome 在本站绑定页写入',
      },
    });
  }

  if (seg[0] === 'stats' && method === 'GET') return sendJSON(res, 200, store.stats());

  if (seg[0] === 'symbols' && method === 'GET') return sendJSON(res, 200, { symbols: SHAPES });

  // 触觉标签系统：外形库（第一层信息传递的选项清单）。已无表面图案层。
  if (seg[0] === 'tactile' && method === 'GET') {
    return sendJSON(res, 200, { shapes: SHAPES });
  }

  if (seg[0] === 'tags' && method === 'GET') {
    const tags = store.allTags().map((t) => ({ ...t, nfc_url: `${baseUrl(req)}${t.nfc_path}` }));
    return sendJSON(res, 200, { tags });
  }

  if (seg[0] === 'items') {
    if (seg.length === 1) {
      if (method === 'GET') {
        const items = store
          .listItems({
            q: url.searchParams.get('q') || '',
            category: url.searchParams.get('category') || '',
            safety: url.searchParams.get('safety') || '',
          })
          .map((it) => withUrl(req, it));
        return sendJSON(res, 200, { items, total: items.length });
      }
      if (method === 'POST') {
        const body = await readBody(req);
        const item = store.createItem(body);
        warmItemAudio(item);
        return sendJSON(res, 201, withUrl(req, item));
      }
      return sendJSON(res, 405, { error: '不支持的方法' });
    }

    const id = seg[1];
    if (seg.length === 2) {
      if (method === 'GET') return sendJSON(res, 200, withUrl(req, store.getItem(id)));
      if (method === 'PATCH' || method === 'PUT') {
        const body = await readBody(req);
        const item = store.updateItem(id, body);
        warmItemAudio(item);
        return sendJSON(res, 200, withUrl(req, item));
      }
      if (method === 'DELETE') {
        const item = store.deleteItem(id);
        return sendJSON(res, 200, { deleted: item.id, name: item.name });
      }
      return sendJSON(res, 405, { error: '不支持的方法' });
    }

    // 保存设备照片（配置端一次定型，使用端不再看图）
    if (seg[2] === 'photo' && method === 'POST') {
      const body = await readBody(req, 5 * 1024 * 1024);
      const item = store.getItem(id);
      const meta = vision.dataUrlToParts(body.image);
      const ext = meta.mime === 'image/png' ? 'png' : meta.mime === 'image/webp' ? 'webp' : 'jpg';
      const fname = `${item.id}-${Date.now()}.${ext}`;
      fs.writeFileSync(path.join(PHOTO_DIR, fname), Buffer.from(String(body.image).split(',')[1], 'base64'));
      // 同一物品只保留最新一张，避免磁盘无限增长
      if (item.photo && item.photo !== fname) {
        try { fs.unlinkSync(path.join(PHOTO_DIR, item.photo)); } catch (e) { /* noop */ }
      }
      const updated = store.updateItem(item.id, { photo: fname });
      return sendJSON(res, 200, { photo: fname, photo_url: `${baseUrl(req)}/api/photos/${fname}`, bytes: meta.bytes, item_id: updated.id });
    }

    /* 3D 打印文件（STL）：GET /api/items/:id/stl
     * 注意这是**演示占位件**——按外形给一个不同长宽比的方块，用来把演示链路走通。
     * 真实版本应当由 lib/tactile.js 的外形轮廓挤出成实体，见 lib/stl.js 顶部注释。
     */
    if (seg[2] === 'stl' && method === 'GET') {
      const item = store.getItem(id);
      const r = stl.placeholderStl(item.tag_shape);
      res.writeHead(200, {
        'content-type': 'model/stl',
        'content-length': r.buffer.length,
        'content-disposition': `attachment; filename="touchtag-${item.id}.stl"`,
        // 演示占位件会随实现变化，别让浏览器缓存住旧几何
        'cache-control': 'no-store',
        'x-touchtag-stl': `placeholder ${r.width_mm}x${r.height_mm}x${r.thickness_mm}mm shape=${r.shape_id}`,
      });
      return res.end(r.buffer);
    }

    /* 一物一签：只支持「确认」与「更新摆放说明」，不再支持一物多签的增删 */
    if (seg[2] === 'tags' && seg[3]) {
      const tagId = seg[3];
      const flag = seg[4];
      const item = store.getItem(id);
      if (item.tag.tag_id !== tagId) throw httpError(404, `该物品的标签编号不是 ${tagId}`);
      if (method === 'POST' && flag === 'verify') {
        const body = await readBody(req);
        const tag = store.setTagVerified(id, tagId, body.verified !== false);
        return sendJSON(res, 200, tag);
      }
      if (method === 'PATCH' || method === 'PUT') {
        const body = await readBody(req);
        const updated = store.updateItem(id, {
          tag: {
            ...item.tag,
            placement_note: body.placement_note !== undefined ? body.placement_note : item.tag.placement_note,
            tag_type: body.tag_type !== undefined ? body.tag_type : item.tag.tag_type,
          },
        });
        return sendJSON(res, 200, updated.tag);
      }
    }

    /* 第三层信息传递：手机摄像头拍下此刻，AI 结合档案回答实时信息 */
    if (seg[2] === 'look' && method === 'POST') {
      const body = await readBody(req, 5 * 1024 * 1024);
      const item = store.getItem(id);
      const started = Date.now();
      const r = await vision.look(item, body.image);
      return sendJSON(res, 200, { ...r, item_id: item.id, item_name: item.name, elapsed_ms: Date.now() - started });
    }

    if (seg[2] === 'qa-logs' && method === 'GET') {
      return sendJSON(res, 200, { logs: store.listQA(id, Number(url.searchParams.get('limit') || 50)) });
    }

    return sendJSON(res, 404, { error: '未知的接口' });
  }

  if (seg[0] === 'ask' && method === 'POST') {
    const body = await readBody(req);
    const item = store.getItem(body.item_id || '');
    const started = Date.now();
    const result = await ai.ask(item, body.question);
    const log = store.logQA({
      item_id: item.id,
      question: body.question,
      answer: result.answer,
      answer_source: result.answer_source,
      matched_action: result.matched_action,
    });
    return sendJSON(res, 200, {
      item_id: item.id,
      item_name: item.name,
      question: body.question,
      answer: result.answer,
      // 短回答优先（PRD §7 + §9）：音频首答只播摘要，完整内容留在屏幕上
      answer_brief: speech.briefAnswer(result.answer),
      brief_only: speech.shouldBrief(result.answer),
      answer_source: result.answer_source,
      matched_action: result.matched_action,
      llm_error: result.llm_error || null,
      elapsed_ms: Date.now() - started,
      log_id: log.id,
    });
  }

  if (seg[0] === 'qa-logs' && seg[1] && seg[2] === 'feedback' && method === 'POST') {
    const body = await readBody(req);
    return sendJSON(res, 200, store.setFeedback(seg[1], body.feedback));
  }

  if (seg[0] === 'qa-logs' && method === 'GET') {
    return sendJSON(res, 200, {
      logs: store.listQA(url.searchParams.get('item_id') || '', Number(url.searchParams.get('limit') || 100)),
    });
  }

  if (seg[0] === 'vision' && seg[1] === 'candidates' && method === 'POST') {
    const body = await readBody(req, 5 * 1024 * 1024);
    return sendJSON(res, 200, await vision.candidates(body));
  }

  return sendJSON(res, 404, { error: '未知的接口' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const started = Date.now();

  res.on('finish', () => {
    if (url.pathname.startsWith('/assets/')) return;
    console.log(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`);
  });

  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);

    if (url.pathname.startsWith('/assets/')) {
      return serveStatic(res, url.pathname.replace('/assets/', ''));
    }

    if (url.pathname === '/favicon.ico') {
      return serveStatic(res, 'favicon.svg');
    }

    for (const [re, file] of PAGE_ROUTES) {
      if (re.test(url.pathname)) return serveStatic(res, file);
    }

    return sendText(res, 404, '页面不存在');
  } catch (err) {
    const code = err.statusCode || 500;
    if (code >= 500) console.error('[error]', err);
    if (res.headersSent) return;
    sendJSON(res, code, { error: err.message || '服务器内部错误' });
  }
});

server.listen(PORT, HOST, () => {
  const s = store.stats();
  console.log(`TouchTag / 触界 已启动 → http://${HOST}:${PORT}`);
  console.log(`数据目录: ${DATA_DIR}`);
  console.log(`物品 ${s.items} 件 · 标签 ${s.tags} 枚 · 已确认操作 ${s.actions} 条`);
  console.log(`问答引擎: ${ai.llmStatus().engine}${ai.llmEnabled() ? ` (${ai.llmStatus().model})` : ''}`);
  console.log(`视觉理解: ${vision.vlmStatus().engine}${vision.vlmEnabled() ? ` (${vision.vlmStatus().model})` : ''}`);
  console.log(`语音: ${tts.enabled ? `神经网络语音（${VOICES[TTS_VOICE] ? VOICES[TTS_VOICE].label : TTS_VOICE}）` : '已关闭，使用浏览器合成'}`);

  // 启动后后台补齐语音缓存（F04：现场打开即播）。TOUCHTAG_WARM_ON_BOOT=off 可关闭。
  if (tts.enabled && process.env.TOUCHTAG_WARM_ON_BOOT !== 'off') {
    setTimeout(() => {
      const texts = [];
      store.listItems().forEach((it) => speech.warmTexts(it).forEach((x) => texts.push(x.text)));
      tts
        .warm(texts, TTS_VOICE)
        .then((r) => console.log(`[tts] 启动预热完成：共 ${r.total} 段，新合成 ${r.generated}，命中 ${r.cached}，失败 ${r.failed}，耗时 ${r.elapsed_ms}ms`))
        .catch((e) => console.error('[tts] 启动预热失败:', e.message));
    }, 6000);
  }
});
