'use strict';

/* 触界 —— 3D 打印文件（STL）**演示占位**实现
 *
 * 为什么是占位：真实产品应当把 tactile.js 里的外形轮廓做多边形化（rect/circle/path
 * 全部离散成折线，按 even-odd 处理内孔），再沿 Z 轴挤出成实体，细节线刻成凹槽——
 * 那是纯几何算法活，且必须做「同一物品每次打印手感一致」的回归测试。
 *
 * 为什么不让 AI 生成 STL：外形库本身就是矢量轮廓，几何是确定的。让模型生成，
 * 同一件物品打印两次形状都会飘——对靠手感认物的盲人是致命的。能算就别猜。
 *
 * 现在的占位做法：按外形给一个不同长宽比的圆角方块（毫米），厚 3 毫米，
 * 保证演示链路「选外形 → 下载 STL → 拖进切片软件能看到东西 → 真机打出来」能走通，
 * 而且不同物品下到的块看起来不一样。
 *
 * 输出二进制 STL：80 字节头 + uint32 三角面数 + 每面 50 字节（法线 3 + 顶点 9 + 属性 2）。
 */

// 每种外形的占位底面尺寸（毫米，宽 × 高），按真实物体的长宽比粗略给一个。
const PLACEHOLDER_MM = {
  fryer: [46, 34],
  microwave: [48, 30],
  washer: [44, 46],
  ricecooker: [38, 44],
  pillbox: [34, 26],
  bottle: [26, 44],
  shirt: [44, 40],
  pouch: [34, 44],
  remote: [20, 48],
  envelope: [46, 32],
  card: [40, 34],
};

const THICKNESS_MM = 3;
const HEADER_TEXT = 'TouchTag tag - demo placeholder box, not final tag geometry';

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function unit(v) {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

/* 一个中心在原点、底面贴在 z=0 的长方体，12 个三角面，顶点顺序按右手法则朝外。 */
const BOX_TRIS = [
  [0, 3, 2], [0, 2, 1], // 底面 z=0，法线 (0,0,-1)
  [4, 5, 6], [4, 6, 7], // 顶面 z=t，法线 (0,0,+1)
  [0, 1, 5], [0, 5, 4], // y = -h/2
  [1, 2, 6], [1, 6, 5], // x = +w/2
  [2, 3, 7], [2, 7, 6], // y = +h/2
  [3, 0, 4], [3, 4, 7], // x = -w/2
];

function boxStl(w, h, t) {
  const x = w / 2;
  const y = h / 2;
  const V = [
    [-x, -y, 0], [x, -y, 0], [x, y, 0], [-x, y, 0],
    [-x, -y, t], [x, -y, t], [x, y, t], [-x, y, t],
  ];
  const buf = Buffer.alloc(84 + BOX_TRIS.length * 50);
  buf.write(HEADER_TEXT, 0, 80, 'ascii');
  buf.writeUInt32LE(BOX_TRIS.length, 80);
  let off = 84;
  for (const [ia, ib, ic] of BOX_TRIS) {
    const a = V[ia];
    const b = V[ib];
    const c = V[ic];
    const n = unit(cross(sub(b, a), sub(c, a)));
    for (const v of [...n, ...a, ...b, ...c]) {
      buf.writeFloatLE(v, off);
      off += 4;
    }
    buf.writeUInt16LE(0, off); // attribute byte count，STL 规范里必须是 0
    off += 2;
  }
  return buf;
}

function sizeForShape(shapeId) {
  return PLACEHOLDER_MM[shapeId] || PLACEHOLDER_MM.card;
}

/* 按标签外形产出占位 STL。返回值同时给出尺寸，便于页面/接口如实标注「这是占位件」。 */
function placeholderStl(shapeId) {
  const [w, h] = sizeForShape(shapeId);
  return {
    buffer: boxStl(w, h, THICKNESS_MM),
    width_mm: w,
    height_mm: h,
    thickness_mm: THICKNESS_MM,
    shape_id: PLACEHOLDER_MM[shapeId] ? shapeId : 'card',
    placeholder: true,
  };
}

module.exports = { placeholderStl, PLACEHOLDER_MM, THICKNESS_MM };
