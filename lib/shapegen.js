'use strict';

/* 触界 —— 标签外形的实时生成
 *
 * 新增物品时，外形不再由人从固定清单里挑，而是让模型按这件物品的照片（或名称与说明）
 * 画出它的剪影轮廓：盲人用户先摸标签，靠轮廓认出这是什么物品、属于哪一类。
 *
 * 分工：
 *   · 本文件：把「物品是谁」变成一次模型调用，并把模型回话收敛成一份外形 JSON；
 *   · lib/tactile.js：解析、校验、重算坐标、重新序列化（模型返回的字符串不直接进页面）；
 *   · lib/store.js：生成结果随物品入库，此后不再变化。
 *
 * 为什么入库后就固定：一枚标签打印出来贴到物品上，手感就必须永远一样。
 * 「重新生成」等于换一枚实体标签，需要重新打印 —— 这一点在配置端只影响录入人，不影响使用者。
 *
 * 模型不可用时退回内置外形库，并在 source 里如实写明来源，前端照实显示，不假装是 AI 画的。
 */

const { chatCompletion, parseJsonLoose } = require('./chat');
const { getShape, suggestShape, sanitizeCustomShape } = require('./tactile');
const stl = require('./stl');

const VLM = {
  baseUrl: (process.env.TOUCHTAG_VLM_BASE_URL || '').replace(/\/+$/, ''),
  apiKey: process.env.TOUCHTAG_VLM_API_KEY || '',
  model: process.env.TOUCHTAG_VLM_MODEL || '',
};
const LLM = {
  baseUrl: (process.env.TOUCHTAG_LLM_BASE_URL || '').replace(/\/+$/, ''),
  apiKey: process.env.TOUCHTAG_LLM_API_KEY || '',
  model: process.env.TOUCHTAG_LLM_MODEL || '',
};

const TIMEOUT_MS = Number(process.env.TOUCHTAG_SHAPE_TIMEOUT_MS || 90000);
/* 外形本身是短输出（一条轮廓 + 两行说明），但推理模型画轮廓前会先「想」很久，
 * 思考 token 也计入 max_tokens。实测给 8000 会被思考吃穿（返回 200 但正文为空），
 * 于是白等一次调用再退成纯文字。max_tokens 是上限不是计费量，给足。 */
const MAX_TOKENS = Number(process.env.TOUCHTAG_SHAPE_MAX_TOKENS || 16000);
const EFFORT = (process.env.TOUCHTAG_SHAPE_EFFORT || 'low').toLowerCase();

function usable(cfg) {
  return Boolean(cfg.baseUrl && cfg.apiKey && cfg.model);
}

/* 看图优先用视觉配置；只配了问答模型时也能用（同一端点通常文字图片都收），
 * 真发不出图片就在下一次尝试里退成纯文字。 */
function pickConfig() {
  if (usable(VLM)) return { ...VLM, kind: 'vlm' };
  if (usable(LLM)) return { ...LLM, kind: 'llm' };
  return null;
}

function shapegenStatus() {
  const cfg = pickConfig();
  return {
    enabled: Boolean(cfg),
    engine: cfg ? cfg.kind : 'library-only',
    model: cfg ? cfg.model : null,
    max_tokens: cfg ? MAX_TOKENS : null,
  };
}

const SHAPE_PROMPT = `你在为一个无障碍项目画「触觉标签」的外形轮廓。

背景：每件物品上会贴一枚 3D 打印的薄卡片标签，卡片外形取自这件物品本身的剪影。
盲人用户先摸到标签，靠轮廓认出这是什么物品、属于哪一类，再用手机碰标签中央的两个凸点读信息。
所以轮廓只要抓住这件物品最有辨识度的外形特征：长宽比、凸出的把手或屏幕台、瓶盖、门框、按键板、袋口封条。
不要写字，不要画图案或装饰花纹，不要画那两个凸点（系统会自己加上去）。

请只输出一个 JSON 对象（不要 Markdown 代码块，不要解释文字），字段如下：
{
  "device": "你在照片里看到的物品（中文，12 字以内；照片看不清就按名称判断）",
  "shape_name": "外形名，四个字左右，以「形」结尾，例如 空气炸锅形、药瓶形、食品袋形",
  "feel": "一句话：这个轮廓摸起来什么样（30 字以内，念给盲人听）",
  "features": "这个轮廓抓住了哪几个外形特征（一句话，20 字以内）",
  "outline_d": "闭合轮廓的 SVG path：只用 M L H V C Q Z 这几个大写指令、绝对坐标，画在 100×100 的视窗里，四周留 10 的边距（坐标落在 10–90 之间），以 Z 收尾",
  "detail_d": "可选的细节线条（把手、按键板、瓶盖分界、封口条）：只用同样的指令，可以不闭合；没有就填空字符串",
  "max_size_mm": 40
}

规则：
1. outline_d 必须是闭合回路（以 Z 结尾），顶点不少于 8 个。长宽比要接近这件物品的真实长宽比，别都画成正方形。
2. 只用大写 M L H V C Q Z。不要用 A（弧线）、不要用 S/T、不要用 transform，不要写 fill / stroke / class 这类属性。
3. 坐标写整数或一位小数，全部落在 0–100 之间。圆角用 C 或 Q 曲线，不要用很多短折线硬怼。
4. detail_d 是刻在卡片上的凹槽，1 到 3 条即可，不要画成图案，也不要越出轮廓太多。
5. 长宽比不要超过 1:3。比这更细长的卡片又放不下芯片，手指也摸不出长边和短边的差别。
6. max_size_mm 填这件物品实物的最大边长（毫米）：遥控器约 15，药盒约 9，饭煲约 30，微波炉约 50。
   系统会按 outline_d 的长宽比把它折算成卡片的打印尺寸，不必你算准。
7. 只输出 JSON，不要解释。

两个已有外形，风格照这个来：
空气炸锅：outline_d = "M14 34 C14 25 21 21 29 21 L71 21 C79 21 86 25 86 34 L86 64 C86 73 79 77 71 77 L29 77 C21 77 14 73 14 64 Z"，detail_d = "M40 49 L60 49 L60 61 C60 64 57 66 54 66 L46 66 C43 66 40 64 40 61 Z"
药瓶：outline_d = "M38 28 C38 21 43 17 50 17 C57 17 62 21 62 28 L62 76 C62 83 57 87 50 87 C43 87 38 83 38 76 Z"，detail_d = "M40 32 L60 32"`;

function buildContext({ name, category, summary, intent }) {
  return (
    '背景信息：\n' +
    `- 物品名（用户自填，可能为空）= ${name || '（空）'}\n` +
    `- 类别（用户自选，仅供参考）= ${category || '未填'}\n` +
    `- 用途备注 = ${intent || '（空）'}\n` +
    `- 其它说明 = ${summary || '无'}\n` +
    '照片如果拍到了控制面板、把手、瓶盖、袋口这些外形特征，轮廓里要体现出来。'
  );
}

async function callModel(cfg, context, image, withImage) {
  const prompt = `${SHAPE_PROMPT}\n\n${context}`;
  const content = withImage && image
    ? [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: image } }]
    : prompt;
  const { content: text, meta } = await chatCompletion({
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    model: cfg.model,
    maxTokens: MAX_TOKENS,
    temperature: 0.2,
    effort: EFFORT,
    timeoutMs: TIMEOUT_MS,
    messages: [{ role: 'user', content }],
  });
  return { parsed: parseJsonLoose(text), meta };
}

/* 生成器不可用/生成失败时的兜底：内置外形库里最接近的一个。
 * 形状仍是确定的、可打印的，只是不是照着这件物品画的。 */
function libraryShape(name, category, reason) {
  const base = getShape(suggestShape(name, category)) || getShape('card');
  const [w, h] = stl.PLACEHOLDER_MM[base.id] || stl.PLACEHOLDER_MM.card;
  return {
    id: base.id,
    shape: base.shape,
    name: base.name,
    feel: base.feel,
    object_hint: base.object_hint,
    path: base.path,
    outline_d: '',
    detail_d: [],
    width_mm: w,
    height_mm: h,
    source: 'library',
    reason,
    generated_at: new Date().toISOString(),
  };
}

function libraryResult(name, category, reason, extra) {
  const shape = libraryShape(name, category, reason);
  const why = String(reason || '').slice(0, 60);
  return {
    ok: true,
    ai_generated: false,
    source: 'library',
    shape,
    notice: `外形生成暂不可用（${why}），本次使用内置的${shape.shape}。`,
    ...extra,
  };
}

/* 配置端主入口：按照片（有则用）与物品信息生成一枚外形。
 * 任何一步失败都退回内置外形库，返回值里始终说明来源，绝不假装是模型画的。
 */
async function generate({ image, name, category, summary, intent } = {}) {
  const started = Date.now();
  const context = buildContext({ name, category, summary, intent });
  const cfg = pickConfig();

  const rawImage = typeof image === 'string' && image.startsWith('data:image/') ? image : '';
  if (!cfg) return libraryResult(name, category, '未配置模型', { elapsed_ms: Date.now() - started });
  if (!rawImage && !name) {
    const err = new Error('请先拍摄照片，或至少填写物品名称');
    err.statusCode = 400;
    throw err;
  }

  const attempts = rawImage ? [true, false] : [false];
  let lastError = null;
  for (const withImage of attempts) {
    try {
      const { parsed, meta } = await callModel(cfg, context, rawImage, withImage);
      const shape = sanitizeCustomShape({ ...parsed, source: withImage ? 'vlm' : 'llm' });
      if (!shape) {
        lastError = new Error('模型给出的轮廓不合规（指令或坐标越界）');
        continue;
      }
      return {
        ok: true,
        ai_generated: true,
        source: shape.source,
        shape,
        view: withImage ? 'photo' : 'text',
        notice: withImage
          ? '已按照片生成了这枚物品的外形。'
          : '已按名称与说明生成了这枚物品的外形。',
        elapsed_ms: Date.now() - started,
        model_ms: meta.elapsed_ms,
      };
    } catch (e) {
      lastError = e;
      console.error(`[shapegen] 生成失败（${withImage ? '带照片' : '纯文字'}）：${e.message}`);
    }
  }
  return libraryResult(name, category, (lastError && lastError.message) || '模型未返回可用轮廓', {
    elapsed_ms: Date.now() - started,
  });
}

module.exports = { generate, shapegenStatus };
