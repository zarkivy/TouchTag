'use strict';

/* 触界 —— 触觉标签系统（以物体为单位）
 *
 * 核心概念（2026-09-23 修订）：
 *   一枚 NFC 标签对应一个物体，标签的外形「契合」该物体。
 *
 * 外形从哪来（2026-09-23 修订）：
 *   · 新增物品时，外形由模型按物品照片实时画出（见 lib/shapegen.js），生成结果随物品入库
 *     （item.tag_shape_custom），此后不再变化 —— 已打印出来的标签必须保持同一个手感。
 *   · 下面的 SHAPES 内置外形库有两个用途：示例数据的既有外形，以及生成不可用时的兜底。
 *   无论外形来自哪里，几何都要经过本文件的 sanitizeCustomShape 重新解析与序列化，
 *   模型返回的字符串不会被直接写进页面。
 *   第一层信息传递完全靠手：
 *     · 外形（SHAPES）→ 摸轮廓就知道「这是什么东西、属于哪一类」
 *     · 双凸点 → 告诉手指「手机碰这里」
 *   不再做按钮级符号（旧版 start/stop/plus 已废弃），也不再有「表面图案」：
 *   实体是 3D 打印的小卡片，摸形状本来就够了。再叠一层纹理等于让人同时学两套
 *   语言——学习成本翻倍，换来的信息量却和外形重复（药瓶形、药盒形本身就已经
 *   把药品这一类和别的类别分开了）。所以外形这一个轴同时承担「是哪一件」和
 *   「属于哪一类」。
 *   历史：PATTERNS / CATEGORY_PATTERN / getPattern 与档案字段 tag_pattern
 *   已于 2026-09-23 一并删除，SEED_VERSION 2 → 3（旧数据自动备份后重建）。
 *   按钮的定位与操作，交给第二层语音播报与第三层 AI。
 */

const VIEWBOX = 100;

// ---------------------------------------------------------------- 外形库
// 每种外形对应一类物体的轮廓。path 画在 100×100 视窗里，统一用描边轮廓，
// 因为标签是「剪出来的形状」——用户摸到的是整片标签的边缘。
// 3D 打印实体时，这份轮廓就是卡片的剪影；里面的细节线（把手、按键板）是画给
// 眼睛看的，打样时要决定「去掉」还是「刻成凹槽」——刻成凹槽反而更好摸。
const SHAPES = [
  {
    id: 'fryer',
    shape: '空气炸锅形',
    name: '空气炸锅',
    object_hint: '空气炸锅、小型卧式烤箱',
    feel: '横放的圆润方块，上沿有一小块凸出的屏幕台，正中一条横把手',
    path:
      '<path d="M12 34 Q12 24 24 24 L76 24 Q88 24 88 34 L88 66 Q88 76 76 76 L24 76 Q12 76 12 66 Z" />' +
      '<path d="M40 52 L60 52 L60 60 Q60 63 57 63 L43 63 Q40 63 40 60 Z" />' +
      '<path d="M18 34 L82 34" stroke-width="3" fill="none" />',
  },
  {
    id: 'microwave',
    shape: '微波炉形',
    name: '微波炉',
    object_hint: '微波炉、横长条电器',
    feel: '横长方块，左半是一大扇门，右侧一条竖窄条是按键板',
    path:
      '<rect x="8" y="26" width="84" height="48" rx="8" />' +
      '<rect x="16" y="34" width="48" height="32" rx="4" fill="none" stroke-width="3" />' +
      '<path d="M72 32 L72 68 M80 32 L80 68" stroke-width="3" fill="none" />',
  },
  {
    id: 'washer',
    shape: '洗衣机形',
    name: '洗衣机',
    object_hint: '滚筒洗衣机、洗碗机',
    feel: '方块轮廓，正中一个大圆环，圆环里是空的',
    path:
      '<rect x="14" y="14" width="72" height="72" rx="10" fill="none" stroke-width="6" />' +
      '<circle cx="50" cy="54" r="22" fill="none" stroke-width="6" />' +
      '<path d="M24 24 L46 24" stroke-width="4" fill="none" />',
  },
  {
    id: 'ricecooker',
    shape: '电饭煲形',
    name: '电饭煲',
    object_hint: '电饭煲、电压力锅',
    feel: '上宽下略窄的圆胖罐形，顶部一条横把手',
    path:
      '<path d="M22 36 Q22 22 50 22 Q78 22 78 36 L74 78 Q74 86 66 86 L34 86 Q26 86 26 78 Z" />' +
      '<path d="M30 24 L70 24" stroke-width="5" fill="none" />',
  },
  {
    id: 'pillbox',
    shape: '小药盒形',
    name: '药盒',
    object_hint: '药盒、小收纳盒、名片盒',
    feel: '扁扁的小方块，比一节手指略大，边角圆润',
    path: '<rect x="22" y="30" width="56" height="40" rx="8" /><path d="M22 44 L78 44" stroke-width="3" fill="none" />',
  },
  {
    id: 'bottle',
    shape: '药瓶形',
    name: '药瓶 / 罐子',
    object_hint: '药瓶、罐装食品、保温杯',
    feel: '竖着的圆瓶，顶部一圈凸出的瓶盖，比药盒高、能立起来',
    path:
      '<rect x="38" y="10" width="24" height="12" rx="3" />' +
      '<path d="M32 30 Q32 22 40 22 L60 22 Q68 22 68 30 L68 82 Q68 90 60 90 L40 90 Q32 90 32 82 Z" />',
  },
  {
    id: 'shirt',
    shape: '衣物形',
    name: '衣物',
    object_hint: '衬衫、T 恤、外套（衣架上的任何衣服）',
    feel: '一件小衣服的轮廓：肩部两个尖角，下面是衣身',
    path:
      '<path d="M34 18 L44 14 Q50 22 56 14 L66 18 L84 30 L76 44 L68 40 L68 88 L32 88 L32 40 L24 44 L16 30 Z" />',
  },
  {
    id: 'pouch',
    shape: '食品袋形',
    name: '食品袋',
    object_hint: '袋装食品、零食、密封袋',
    feel: '上窄下宽的袋子，顶部一条封口实条',
    path:
      '<path d="M28 14 L72 14 L80 30 L80 84 Q80 90 74 90 L26 90 Q20 90 20 84 L20 30 Z" />' +
      '<path d="M28 20 L72 20" stroke-width="5" fill="none" />',
  },
  {
    id: 'remote',
    shape: '遥控器形',
    name: '遥控器',
    object_hint: '遥控器、竖长条小物件',
    feel: '竖长条，正好一个手掌宽的一半，边缘圆润',
    path: '<rect x="32" y="10" width="36" height="80" rx="10" /><circle cx="50" cy="26" r="5" />',
  },
  {
    id: 'idcard',
    shape: '身份卡形',
    name: '身份卡 / 卡牌',
    object_hint: '狼人杀身份卡、桌游角色牌、证件卡、会员卡',
    feel: '横着的圆角卡片，左边一个圆片（证件照位），右边两条横线',
    path:
      '<rect x="10" y="24" width="80" height="52" rx="7" />' +
      '<circle cx="28" cy="50" r="8" fill="none" stroke-width="3" />' +
      '<path d="M44 42 L80 42 M44 58 L80 58" stroke-width="3" fill="none" />',
  },
  {
    id: 'envelope',
    shape: '信封形',
    name: '信封 / 卡片',
    object_hint: '剧本杀信封、请柬、卡片',
    feel: '横着的扁方块，背面有两条对折斜线',
    path:
      '<rect x="10" y="26" width="80" height="48" rx="6" />' +
      '<path d="M10 30 L50 56 L90 30" fill="none" stroke-width="4" />',
  },
  {
    id: 'card',
    shape: '通用圆角卡',
    name: '通用（默认）',
    object_hint: '没有专属外形时的默认选择',
    feel: '一片圆角小卡片，四边都圆，不求与物体同形',
    path: '<rect x="16" y="22" width="68" height="56" rx="12" />',
  },
];

const SHAPE_BY_ID = SHAPES.reduce((a, s) => ((a[s.id] = s), a), {});

function getShape(id) {
  return SHAPE_BY_ID[id] || null;
}

/* 关键词 → 外形建议：创建端与数据规范化共用，保证「名字里有炸锅就给炸锅形」 */
const SHAPE_KEYWORDS = [
  [/炸锅|空气炸|烤箱|空气锅/, 'fryer'],
  [/微波炉|微波/, 'microwave'],
  [/洗衣机|洗碗机|滚筒/, 'washer'],
  [/电饭煲|电饭锅|压力锅/, 'ricecooker'],
  [/药瓶|瓶子|罐|保温杯|水杯/, 'bottle'],
  [/衬衫|衣服|T ?恤|外套|裤子|裙子|毛衣|衣物/, 'shirt'],
  [/药盒|盒子|收纳盒|名片盒/, 'pillbox'],
  [/袋|零食|燕麦|米面|包装食/, 'pouch'],
  [/遥控器|游戏手柄/, 'remote'],
  [/狼人杀|身份卡|身份牌|角色牌|卡牌|桌游|扑克|麻将/, 'idcard'],
  [/信封|请柬|邀请函/, 'envelope'],
];

function suggestShape(name, category) {
  const text = String(name || '');
  for (const [re, id] of SHAPE_KEYWORDS) {
    if (re.test(text)) return id;
  }
  if (category === '药品') return 'pillbox';
  if (category === '衣物') return 'shirt';
  if (category === '食品') return 'pouch';
  if (category === '易丢物品') return 'remote';
  // 「娱乐」落到卡牌：这个类别里最常见的是桌游身份卡 / 角色牌，不是信封
  if (category === '娱乐') return 'idcard';
  return 'card';
}

/* 双凸点：所有标签共有的「碰这里」标记 */
function nfcDots(cx = 50, cy = 30, r = 7) {
  return `<circle cx="${cx - 9}" cy="${cy}" r="${r}" /><circle cx="${cx + 9}" cy="${cy}" r="${r}" />`;
}

/* 生成一枚「以物体为单位」的触觉标签 SVG：
 *   外轮廓 = 外形（就是剪下来 / 打印出来的那张卡片），底部中央 = NFC 双凸点。
 *   uid 只用于 aria-label 之外的调试可读性，一页多枚标签不会互相干扰。
 */
function renderTag(shape, { cls = 'tagshape', uid = 't', label = '' } = {}) {
  const text = label || `触觉标签：${shape.name || ''}外形`;
  return (
    `<svg class="${cls}" viewBox="0 0 100 100" role="img" aria-label="${escapeAttr(text)}" data-uid="${escapeAttr(uid)}">` +
    `<title>${escapeAttr(text)}</title>` +
    `<g class="tag-outline">${shape.path}</g>` +
    `<g class="tag-nfc">${nfcDots()}</g>` +
    `</svg>`
  );
}

/* 按内置外形 id 渲染（示例数据、首页轮廓条用）。 */
function tagSvg(shapeId, opts) {
  return renderTag(getShape(shapeId) || SHAPE_BY_ID.card, opts);
}

/* 按物品渲染：优先用它自己那枚生成出来的外形，没有才回落到内置外形 id。 */
function tagSvgFor(item, opts) {
  const shape = shapeOf(item);
  return shape ? renderTag(shape, opts) : '';
}

function escapeAttr(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ================================================================ AI 生成外形
 * 生成出来的外形是外部输入，本段代码负责把它变成可信的几何：
 *   1. 只认 M L H V C Q Z 六个指令（大小写均可，一律转成绝对坐标）；
 *      出现 A/S/T、transform、fill 这类东西一律判为不可用 —— 宁可退回内置外形；
 *   2. 重算所有坐标：等比缩放到视窗内居中铺满，坐标不再由模型说了算；
 *   3. 序列化成只含数字与指令字母的字符串，再拼成 path 标签。
 * 这样模型能控制的只有「轮廓长什么样」，控制不了「页面里写进什么」。
 */

const SHAPE_TARGET = 84;             // 等比缩放后，较长边占 84（视窗 100，四周留 8 的边距）
const MAX_PATH_CHARS = 3000;
const PATH_ALLOWED_RE = /^[MmLlHhVvCcQqZz0-9.,\s+-]+$/;
const PATH_TOKEN_RE = /[MmLlHhVvCcQqZz]|[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)/g;
const PATH_SUPPORTED = 'MLHVCQ';

function round1(v) {
  const r = Math.round(v * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

function str(v, max) {
  return String(v == null ? '' : v).trim().slice(0, max);
}

function clampNum(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function hash32(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/* 解析成绝对坐标指令表；任何不认识的写法都返回 null。 */
function parsePathAbs(d) {
  const text = String(d == null ? '' : d).trim();
  if (!text || text.length > MAX_PATH_CHARS) return null;
  if (!PATH_ALLOWED_RE.test(text)) return null;
  const tokens = text.match(PATH_TOKEN_RE);
  if (!tokens || !/^[A-Za-z]$/.test(tokens[0])) return null;

  const cmds = [];
  let i = 0;
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;

  while (i < tokens.length) {
    const letter = tokens[i];
    if (!/^[A-Za-z]$/.test(letter)) return null; // 参数个数与指令对不上
    i += 1;
    if (letter === 'Z' || letter === 'z') {
      cmds.push({ cmd: 'Z', pts: [] });
      cx = sx;
      cy = sy;
      continue;
    }
    const up = letter.toUpperCase();
    if (PATH_SUPPORTED.indexOf(up) === -1) return null;
    const rel = letter !== up;
    const need = up === 'C' ? 6 : up === 'Q' ? 4 : up === 'H' || up === 'V' ? 1 : 2;
    let first = true;
    while (i < tokens.length && !/^[A-Za-z]$/.test(tokens[i])) {
      if (i + need > tokens.length) return null;
      const v = [];
      for (let k = 0; k < need; k += 1) {
        const n = Number(tokens[i + k]);
        if (!Number.isFinite(n)) return null;
        v.push(n);
      }
      i += need;
      if (up === 'M') {
        const px = rel ? cx + v[0] : v[0];
        const py = rel ? cy + v[1] : v[1];
        // M 之后的坐标对按 SVG 规范是隐式的 L
        if (first) {
          cmds.push({ cmd: 'M', pts: [[px, py]] });
          sx = px;
          sy = py;
          first = false;
        } else {
          cmds.push({ cmd: 'L', pts: [[px, py]] });
        }
        cx = px;
        cy = py;
      } else if (up === 'L') {
        const px = rel ? cx + v[0] : v[0];
        const py = rel ? cy + v[1] : v[1];
        cmds.push({ cmd: 'L', pts: [[px, py]] });
        cx = px;
        cy = py;
      } else if (up === 'H') {
        const px = rel ? cx + v[0] : v[0];
        cmds.push({ cmd: 'L', pts: [[px, cy]] });
        cx = px;
      } else if (up === 'V') {
        const py = rel ? cy + v[0] : v[0];
        cmds.push({ cmd: 'L', pts: [[cx, py]] });
        cy = py;
      } else if (up === 'Q') {
        const x1 = rel ? cx + v[0] : v[0];
        const y1 = rel ? cy + v[1] : v[1];
        const x2 = rel ? cx + v[2] : v[2];
        const y2 = rel ? cy + v[3] : v[3];
        cmds.push({ cmd: 'Q', pts: [[x1, y1], [x2, y2]] });
        cx = x2;
        cy = y2;
      } else {
        const x1 = rel ? cx + v[0] : v[0];
        const y1 = rel ? cy + v[1] : v[1];
        const x2 = rel ? cx + v[2] : v[2];
        const y2 = rel ? cy + v[3] : v[3];
        const x3 = rel ? cx + v[4] : v[4];
        const y3 = rel ? cy + v[5] : v[5];
        cmds.push({ cmd: 'C', pts: [[x1, y1], [x2, y2], [x3, y3]] });
        cx = x3;
        cy = y3;
      }
    }
  }
  return cmds.length >= 2 ? cmds : null;
}

function bboxOf(cmds) {
  let minx = Infinity;
  let miny = Infinity;
  let maxx = -Infinity;
  let maxy = -Infinity;
  cmds.forEach((c) =>
    c.pts.forEach(([x, y]) => {
      if (x < minx) minx = x;
      if (y < miny) miny = y;
      if (x > maxx) maxx = x;
      if (y > maxy) maxy = y;
    })
  );
  if (!Number.isFinite(minx)) return null;
  return { minx, miny, maxx, maxy, w: maxx - minx, h: maxy - miny };
}

function serializePath(cmds) {
  return cmds
    .map((c) => c.cmd + (c.pts.length ? ' ' + c.pts.map(([x, y]) => `${round1(x)} ${round1(y)}`).join(' ') : ''))
    .join(' ');
}

function transformPath(cmds, t) {
  return cmds.map((c) => ({
    cmd: c.cmd,
    pts: c.pts.map(([x, y]) => [x * t.scale + t.ox, y * t.scale + t.oy]),
  }));
}

/* 把一段（或几段）path 规范成「100×100 视窗里等比居中铺满」的形式。
 * 返回 { d, extras, aspect }；坐标不可信时返回 null。
 */
function normalizeOutline(d, extras) {
  let cmds = parsePathAbs(d);
  const box = cmds && bboxOf(cmds);
  if (!box) return null;
  // 坐标跨度上限 1000：允许模型用 0–1000 这类放大十倍的坐标系（照样能归一化），
  // 但拦掉明显错乱的输出（把字号、时间戳之类当成坐标写进来）。
  if (box.w < 1 || box.h < 1 || box.w > 1000 || box.h > 1000) return null;
  const aspect = box.w / box.h;
  if (aspect > 8 || aspect < 1 / 8) return null;
  // 至少四个顶点（一枚方卡片就是四边形），更少说明轮廓没画出来
  const vertexCount = cmds.reduce((n, c) => n + c.pts.length, 0);
  if (vertexCount < 4) return null;

  // 轮廓必须是闭合回路（卡片是剪出来的）：模型漏了 Z 就补上，而不是整段作废
  const closed = cmds[cmds.length - 1].cmd === 'Z';
  if (!closed) cmds = cmds.concat([{ cmd: 'Z', pts: [] }]);

  const scale = SHAPE_TARGET / Math.max(box.w, box.h);
  const t = {
    scale,
    ox: 50 - scale * (box.minx + box.w / 2),
    oy: 50 - scale * (box.miny + box.h / 2),
  };
  const list = Array.isArray(extras) ? extras : extras ? [extras] : [];
  return {
    d: serializePath(transformPath(cmds, t)),
    extras: list
      .map((x) => parsePathAbs(x))
      .filter(Boolean)
      .map((c) => serializePath(transformPath(c, t)))
      .filter((x) => x.length > 4)
      .slice(0, 3),
    aspect,
  };
}
/* 把模型（或生成器兜底）给的外形整理成档案能直接用的字段。
 * 返回 null 表示几何不可用，调用方应退回内置外形库。
 */
function sanitizeCustomShape(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const outline = normalizeOutline(raw.outline_d || raw.path_d || '', raw.detail_d || raw.details);
  if (!outline) return null;

  const shapeName = str(raw.shape || raw.shape_name || raw.name, 16);
  const shape = shapeName ? (/形$/.test(shapeName) ? shapeName : `${shapeName}形`) : '自定义形';
  const detailMarkup = outline.extras.map((x) => `<path d="${x}" fill="none" stroke-width="3" />`).join('');

  // 打印尺寸：模型给的是「实物最大边长」，长宽比一律以画出来的轮廓为准，
  // 免得出现「画出竖长条、尺寸却按横宽算」这种手感与外观不符的标签。
  // 两个物理约束兜底：短边不足 20 毫米整枚等比放大（标签里要放得下 NFC 芯片、够手指捏住），
  // 长边超过 72 毫米再等比收回。打印件长宽比额外收在 3:1 以内 —— 更细长的卡片摸不出边缘差异。
  const long0 = clampNum(raw.max_size_mm, 26, 60, 44);
  const printAspect = Math.min(3, Math.max(1 / 3, outline.aspect));
  const ratio = printAspect >= 1 ? printAspect : 1 / printAspect;
  let longMm = long0;
  let shortMm = long0 / ratio;
  if (shortMm < 20) {
    longMm *= 20 / shortMm;
    shortMm = 20;
  }
  if (longMm > 72) {
    const k = 72 / longMm;
    longMm *= k;
    shortMm *= k;
  }
  const round05 = (v) => Math.round(v * 2) / 2;
  const widthMm = round05(outline.aspect >= 1 ? longMm : shortMm);
  const heightMm = round05(outline.aspect >= 1 ? shortMm : longMm);

  return {
    // 由几何本身派生：同一段轮廓无论什么时候生成，拿到的 id 都一样
    id: `ai-${hash32(outline.d + '|' + outline.extras.join('|'))}`,
    shape,
    name: str(raw.device || raw.object_name || raw.name, 24) || shape.replace(/形$/, ''),
    feel: str(raw.feel, 60),
    object_hint: str(raw.features, 80),
    path: `<path d="${outline.d}" />${detailMarkup}`,
    outline_d: outline.d,
    detail_d: outline.extras,
    width_mm: widthMm,
    height_mm: heightMm,
    // 模型对实物最大边长的估计值也一并存下来：几何每次重新解析时，
    // 打印尺寸才能算出同一个结果（否则回落到默认值，页面显示的尺寸会变）。
    max_size_mm: long0,
    source: ['vlm', 'llm'].indexOf(raw.source) >= 0 ? raw.source : 'ai',
    generated_at: str(raw.generated_at, 40) || new Date().toISOString(),
  };
}

/* 物品最终使用的外形：自己生成的那枚优先，其次是内置外形库。 */
function shapeOf(item) {
  if (item && item.tag_shape_custom) {
    const custom = sanitizeCustomShape(item.tag_shape_custom);
    if (custom) return custom;
  }
  return getShape(item && item.tag_shape);
}

module.exports = {
  VIEWBOX,
  SHAPES,
  getShape,
  shapeOf,
  suggestShape,
  sanitizeCustomShape,
  normalizeOutline,
  tagSvg,
  tagSvgFor,
  nfcDots,
};
