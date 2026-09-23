'use strict';

const fs = require('fs');
const path = require('path');
const { ITEMS, SEED_VERSION } = require('./seed');
const { getShape, suggestShape } = require('./tactile');

const CATEGORIES = ['家电', '衣物', '药品', '食品', '娱乐', '易丢物品', '其他'];
const SAFETY_LEVELS = ['normal', 'high'];
const TAG_TYPES = ['normal', 'on-metal', 'sewable', 'active'];

const ID_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const MAX_QA_LOGS = 500;

function httpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function randomCode(len) {
  let out = '';
  for (let i = 0; i < len; i += 1) {
    out += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
  }
  return out;
}

function str(v, max = 2000) {
  if (v === undefined || v === null) return '';
  return String(v).trim().slice(0, max);
}

function strArray(v, max = 20, len = 500) {
  if (!Array.isArray(v)) return [];
  return v.map((x) => str(x, len)).filter(Boolean).slice(0, max);
}

class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'touchtag.json');
    this.state = { version: SEED_VERSION, items: [], qa_logs: [], updated_at: null };
    this.load();
  }

  load() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    /* 版本升级会「备份旧文件 + 用新种子重建」：档案内容本来就不该保留（新概念会让旧字段
     * 失去意义）。但照片是例外——照片是磁盘上按物品编号命名的真实文件（DATA_DIR/photos），
     * 重建后必须把 photo 字段带回来，否则物品页上的实拍照片会全部消失，
     * 而它们不是能从种子里恢复的数据。
     */
    const carryPhoto = new Map();
    if (fs.existsSync(this.file)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        // 数据版本不一致（例如从「按钮级符号」旧模型升级到「物体单位标签」模型）
        // → 备份旧文件后用新种子重建，保证演示数据与新概念一致。
        if (raw.version !== SEED_VERSION) {
          const backup = `${this.file}.v${raw.version || 1}-${Date.now()}`;
          fs.copyFileSync(this.file, backup);
          if (Array.isArray(raw.items)) {
            raw.items.forEach((it) => {
              if (!it || !it.id || !it.photo) return;
              // 只带「文件确实还在」的照片，避免重建出一个指向空文件的字段
              if (fs.existsSync(path.join(this.dataDir, 'photos', it.photo))) carryPhoto.set(it.id, it.photo);
            });
          }
          console.error(
            `[store] 数据版本 ${raw.version || '?'} ≠ ${SEED_VERSION}，已备份到 ${backup}，用新种子数据重建` +
              (carryPhoto.size ? `（保留了 ${carryPhoto.size} 件物品的照片）` : '')
          );
        } else {
          this.state = {
            version: raw.version,
            items: Array.isArray(raw.items) ? raw.items.map((it) => this.normalizeItem(it, it.id)) : [],
            qa_logs: Array.isArray(raw.qa_logs) ? raw.qa_logs : [],
            updated_at: raw.updated_at || null,
          };
          return;
        }
      } catch (e) {
        const backup = `${this.file}.broken-${Date.now()}`;
        fs.copyFileSync(this.file, backup);
        console.error(`[store] 数据文件损坏，已备份到 ${backup}，将用示例数据重建`);
      }
    }
    const items = this.normalizeAll(ITEMS);
    items.forEach((it) => {
      if (carryPhoto.has(it.id)) it.photo = carryPhoto.get(it.id);
    });
    this.state = {
      version: SEED_VERSION,
      items,
      qa_logs: [],
      updated_at: new Date().toISOString(),
    };
    this.save();
  }

  save() {
    this.state.updated_at = new Date().toISOString();
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.file);
  }

  normalizeAll(items) {
    return items.map((it) => this.normalizeItem(it, it.id));
  }

  normalizeItem(input, id) {
    const item = {
      id,
      name: str(input.name, 80),
      category: CATEGORIES.includes(input.category) ? input.category : '其他',
      brand_model: str(input.brand_model, 120),
      safety_level: SAFETY_LEVELS.includes(input.safety_level) ? input.safety_level : 'normal',
      location: str(input.location, 160),
      summary: str(input.summary, 1200),
      placement_note: str(input.placement_note, 300),
      // 第一层触觉：外形就是唯一一个轴——契合物体的同时承担类别语义
      tag_shape: getShape(input.tag_shape) ? input.tag_shape : suggestShape(input.name, input.category),
      created_by: str(input.created_by, 60) || '未署名',
      photo: str(input.photo, 200),
      sensitive: Boolean(input.sensitive),
      created_at: input.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
      controls: this.normalizeControls(input.controls),
      actions: this.normalizeActions(input.actions),
      safety_notes: strArray(input.safety_notes, 12, 300),
      // 第二层入口：一枚 NFC 标签对应一个物体
      tag: this.normalizeTag(input.tag || (Array.isArray(input.tags) ? input.tags[0] : null)),
    };
    if (!item.name) throw httpError(400, '物品名称不能为空');
    return item;
  }

  normalizeControls(controls) {
    if (!Array.isArray(controls)) return [];
    return controls
      .map((c) => ({
        name: str(c && c.name, 60),
        kind: ['button', 'knob', 'display', 'touch'].includes(c && c.kind) ? c.kind : 'button',
        position: str(c && c.position, 300),
      }))
      .filter((c) => c.name)
      .slice(0, 30);
  }

  normalizeActions(actions) {
    if (!Array.isArray(actions)) return [];
    return actions
      .map((a) => ({
        action_name: str(a && a.action_name, 80),
        steps: strArray(a && a.steps, 20, 400),
        source: str(a && a.source, 160) || '用户录入',
        verified: Boolean(a && a.verified),
      }))
      .filter((a) => a.action_name && a.steps.length)
      .slice(0, 12);
  }

  /* 一枚 NFC 标签对应一个物体。旧数据里的 tags 数组只取第一枚。 */
  normalizeTag(tag) {
    return {
      tag_id: (tag && str(tag.tag_id, 20)) || `T-${randomCode(4)}`,
      tag_type: TAG_TYPES.includes(tag && tag.tag_type) ? tag.tag_type : 'normal',
      placement_note: str(tag && tag.placement_note, 200),
      verified: Boolean(tag && tag.verified),
      finder: tag && tag.finder ? str(tag.finder, 40) : null,
    };
  }

  nextId() {
    for (let i = 0; i < 200; i += 1) {
      const code = randomCode(5);
      if (!this.state.items.some((it) => it.id === code)) return code;
    }
    throw httpError(500, '无法生成唯一编号，请重试');
  }

  listItems({ q, category, safety } = {}) {
    let items = this.state.items.slice();
    if (category) items = items.filter((it) => it.category === category);
    if (safety) items = items.filter((it) => it.safety_level === safety);
    if (q) {
      const needle = String(q).trim().toLowerCase();
      items = items.filter((it) =>
        [it.name, it.brand_model, it.location, it.summary, it.category, ...it.safety_notes]
          .join(' ')
          .toLowerCase()
          .includes(needle)
      );
    }
    return items.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  }

  getItem(id) {
    const item = this.state.items.find((it) => it.id === String(id).toUpperCase());
    if (!item) throw httpError(404, `没有找到编号为 ${id} 的物品`);
    return item;
  }

  createItem(payload) {
    const id = this.nextId();
    const item = this.normalizeItem(payload || {}, id);
    this.state.items.push(item);
    this.save();
    return item;
  }

  updateItem(id, patch) {
    const item = this.getItem(id);
    const merged = { ...item, ...(patch || {}), id: item.id, created_at: item.created_at };
    const next = this.normalizeItem(merged, item.id);
    const idx = this.state.items.findIndex((it) => it.id === item.id);
    this.state.items[idx] = next;
    this.save();
    return next;
  }

  deleteItem(id) {
    const item = this.getItem(id);
    this.state.items = this.state.items.filter((it) => it.id !== item.id);
    this.state.qa_logs = this.state.qa_logs.filter((l) => l.item_id !== item.id);
    this.save();
    return item;
  }

  setTagVerified(itemId, tagId, verified) {
    const item = this.getItem(itemId);
    if (item.tag.tag_id !== tagId) throw httpError(404, `该物品下没有标签 ${tagId}`);
    item.tag.verified = Boolean(verified);
    item.updated_at = new Date().toISOString();
    this.save();
    return item.tag;
  }

  logQA(entry) {
    const row = {
      id: `Q-${randomCode(6)}`,
      item_id: entry.item_id,
      question: str(entry.question, 500),
      answer: str(entry.answer, 4000),
      answer_source: str(entry.answer_source, 40),
      matched_action: str(entry.matched_action, 80) || null,
      timestamp: new Date().toISOString(),
      feedback: null,
    };
    this.state.qa_logs.push(row);
    if (this.state.qa_logs.length > MAX_QA_LOGS) {
      this.state.qa_logs = this.state.qa_logs.slice(-MAX_QA_LOGS);
    }
    this.save();
    return row;
  }

  setFeedback(logId, feedback) {
    const row = this.state.qa_logs.find((l) => l.id === logId);
    if (!row) throw httpError(404, `没有找到问答记录 ${logId}`);
    row.feedback = ['up', 'down'].includes(feedback) ? feedback : null;
    this.save();
    return row;
  }

  listQA(itemId, limit = 50) {
    let rows = this.state.qa_logs.slice().reverse();
    if (itemId) rows = rows.filter((l) => l.item_id === String(itemId).toUpperCase());
    return rows.slice(0, limit);
  }

  allTags() {
    return this.state.items.map((it) => ({
      ...it.tag,
      item_id: it.id,
      item_name: it.name,
      nfc_path: `/i/${it.id}`,
    }));
  }

  stats() {
    const items = this.state.items;
    return {
      items: items.length,
      tags: items.length, // 一物一签
      tags_verified: items.filter((it) => it.tag.verified).length,
      controls: items.reduce((n, it) => n + it.controls.length, 0),
      actions: items.reduce((n, it) => n + it.actions.length, 0),
      high_risk: items.filter((it) => it.safety_level === 'high').length,
      qa_logs: this.state.qa_logs.length,
      updated_at: this.state.updated_at,
    };
  }
}

module.exports = { Store, CATEGORIES, SAFETY_LEVELS, TAG_TYPES, httpError };
