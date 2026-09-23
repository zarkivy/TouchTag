'use strict';

/* 触界 —— 触觉标签系统（以物体为单位）
 *
 * 核心概念（2026-09-23 修订）：
 *   一枚 NFC 标签对应一个物体，标签的外形「契合」该物体。
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
  [/信封|请柬|卡片|剧本杀/, 'envelope'],
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
  if (category === '娱乐') return 'envelope';
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
function tagSvg(shapeId, { cls = 'tagshape', uid = 't' } = {}) {
  const shape = getShape(shapeId) || SHAPE_BY_ID.card;
  return (
    `<svg class="${cls}" viewBox="0 0 100 100" role="img" aria-label="触觉标签：${escapeAttr(shape.name)}外形" data-uid="${escapeAttr(uid)}">` +
    `<title>${escapeAttr(shape.name)}外形</title>` +
    `<g class="tag-outline">${shape.path}</g>` +
    `<g class="tag-nfc">${nfcDots()}</g>` +
    `</svg>`
  );
}

function escapeAttr(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = {
  VIEWBOX,
  SHAPES,
  getShape,
  suggestShape,
  tagSvg,
  nfcDots,
  // 兼容旧代码引用点（store.js 的 assertSymbol）——新数据模型不再使用，保留空实现防崩
  SYMBOLS: SHAPES,
  getSymbol: getShape,
  assertSymbol: (id) => {
    if (!SHAPE_BY_ID[id]) {
      const err = new Error(`未知的标签外形: ${id}`);
      err.statusCode = 400;
      throw err;
    }
    return id;
  },
};
