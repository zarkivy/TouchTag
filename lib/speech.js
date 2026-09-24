'use strict';

/* 触界 —— 播报文案的唯一来源（三层信息传递之第二层）
 *
 * 为什么单独抽出来：F04 要求「页面打开到可听 ≤3 秒」。做法是把播报文案在服务端
 * 生成，创建/更新物品时就预合成音频；前端播放的文本必须与预热时完全一致，
 * 否则缓存永远不命中。文案一旦分散在前端，就会出现「预热了但前端拼的字符串不同」的坑。
 */

const { shapeOf } = require('./tactile');

// 播报介绍：先说是什么、标签摸起来什么样，再说放在哪、能问什么。
// 不念型号——盲人关心的是「这是什么、放在哪、怎么用」，型号是家人录入时核对用的，
// 念出来只是噪音（还常和名称重复，比如「美的 KZC50 空气炸锅」）。
function endWithPunct(s) {
  const t = String(s || '').trim();
  if (!t) return '';
  return /[。！？；，、]$/.test(t) ? t : t + '。';
}

/* 只描述外形。表面图案那一层已撤掉（2026-09-23）：
 * 实体是 3D 打印的小卡片，外形一个轴就够了，不再让人学第二套语言。
 * 外形可能来自内置外形库，也可能是模型照这件物品生成的（item.tag_shape_custom），
 * 两者形状与手感描述字段一致，这里不用区分。
 */
function shapePhrase(item) {
  const shape = shapeOf(item);
  if (!shape || !shape.feel) return '';
  return `它的标签摸起来是${shape.shape}，${shape.feel}`;
}

function introSpeech(item) {
  const parts = ['这是' + item.name + '。'];
  const tagLine = shapePhrase(item);
  if (tagLine) parts.push(tagLine + '。');
  if (item.location) parts.push('它放在' + item.location + '。');
  if (item.summary) parts.push(endWithPunct(item.summary));
  if (item.safety_notes.length) parts.push('使用前请注意：' + endWithPunct(item.safety_notes[0]));
  /* 最后一句只说**位置**，不说按钮叫什么。
   * 盲人找按钮是按位置找的：读屏逐个翻页太慢，而念出「看一眼」这三个字等于没给坐标
   * ——他既不知道按钮叫什么名字对他有什么用，也不知道它在哪。
   * 屏幕最下方是唯一一个不用数、不用摸、滚多少内容都不会跑掉的位置，
   * 对应的按钮因此固定在底栏里（见 public/app.css 的 .look-bar）。
   * 顺带说明「会拍一张照片」：相机是系统界面，不提前说一句，突然亮起来会吓人。 */
  parts.push('想看看它现在什么样，按一下屏幕最下面那颗按钮，拍张照片，我帮你看。');
  return parts.join('');
}

function actionSpeech(item, action) {
  const caution = action.verified ? '' : '这条还没有经过确认，请谨慎使用。';
  return action.action_name + '。' + action.steps.join(' ') + caution + '来自' + action.source + '。';
}

/* 物品相关的全部可预合成文案（含常见快捷问句的答案），用于预热缓存。
 * 返回 [{ key, text }]，key 仅作日志用。
 */
function warmTexts(item) {
  const out = [{ key: 'intro', text: introSpeech(item) }];
  item.actions.forEach((a, i) => out.push({ key: `action:${i}`, text: actionSpeech(item, a) }));
  return out.filter((x) => x.text && x.text.trim());
}

/* 简短回答：音频交互首答要短（PRD §7「短回答优先」）
 * 规则：第一句必须是用户马上能做的动作，所以要先跳过「边界声明」类句子
 * （例如「这是高风险物品，我只复述档案里已经确认过的内容。」）——那是免责，
 * 不是动作。完整声明仍留在屏幕上的完整回答里。
 */
const GUARD_SENTENCE = /(高风险|我只复述|我只说|我不会给|不给建议|不做保证|需要确认|待确认|交给专业人员|属于.*类别)/;

function briefAnswer(answer, max = 45) {
  const text = String(answer || '').trim();
  if (!text) return '';
  const sentences = text.split(/[。！？]/).map((s) => s.trim()).filter(Boolean);
  const pick = sentences.find((s) => !GUARD_SENTENCE.test(s)) || sentences[0] || text;
  const cut = pick.trim().slice(0, max);
  return cut.length < pick.trim().length ? cut + '…' : cut + '。';
}

function shouldBrief(answer, threshold = 90) {
  return String(answer || '').trim().length > threshold;
}

module.exports = { introSpeech, actionSpeech, warmTexts, briefAnswer, shouldBrief };
