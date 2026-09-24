'use strict';

const { shapeOf, suggestShape } = require('./tactile');
const { chatCompletion } = require('./chat');

const LLM_BASE_URL = (process.env.TOUCHTAG_LLM_BASE_URL || '').replace(/\/+$/, '');
const LLM_API_KEY = process.env.TOUCHTAG_LLM_API_KEY || '';
const LLM_MODEL = process.env.TOUCHTAG_LLM_MODEL || '';
const LLM_TIMEOUT_MS = Number(process.env.TOUCHTAG_LLM_TIMEOUT_MS || 60000);

/* 推理模型（DeepSeek-V4.1-Flash 等）会先输出思考内容，且思考 token 计入 max_tokens。
 * 预算给小了会出现「HTTP 200 但正文为空」——表面上成功，实际什么也没答，
 * 然后静默回退到本地引擎，很难发现。实测 600 和 2400 都会被打穿。
 * max_tokens 是**上限不是计费量**，没用完不花钱，所以这里给足。
 */
const LLM_MAX_TOKENS = Number(process.env.TOUCHTAG_LLM_MAX_TOKENS || 8000);
// 推理强度 low/high/max。语音场景要的是「快」而不是「想得深」，默认压到 low。
const LLM_EFFORT = (process.env.TOUCHTAG_LLM_EFFORT || 'low').toLowerCase();
const VALID_EFFORT = ['low', 'high', 'max'];

function llmEnabled() {
  return Boolean(LLM_BASE_URL && LLM_API_KEY && LLM_MODEL);
}

function llmStatus() {
  return {
    enabled: llmEnabled(),
    model: llmEnabled() ? LLM_MODEL : null,
    base_url: llmEnabled() ? LLM_BASE_URL : null,
    max_tokens: llmEnabled() ? LLM_MAX_TOKENS : null,
    effort: llmEnabled() && VALID_EFFORT.includes(LLM_EFFORT) ? LLM_EFFORT : null,
    engine: llmEnabled() ? 'llm' : 'local-rule-engine',
  };
}

// ---------------------------------------------------------------- 提示词约束
// 与 PRD「AI 行为要求」和「AI Prompt / RAG 原则」一一对应。
// 三层模型下，方位语言一律以「NFC 标签」为基准（一物一签，标签位置固定）。
const SYSTEM_PROMPT = `你是 TouchTag（触界）的物品助手，服务对象是盲人和低视力用户。你只通过语音与他们交流。

绝对规则：
1. 只能使用【物品档案】里已经录入的信息。档案里没有的按钮、档位、功能，一律不要说，也不要用常识补全。
2. 如果【用户问题】和档案内容**没有对应关系**（例如问外卖、天气、聊天），第一句必须直接说“档案里没有记录这个，需要家人确认后再补充”，并且**不要**顺手给一个跟问题无关的操作。宁可只说这一句，也不要为了“给个动作”而答非所问。
3. 只有当问题确实对应档案里的内容时，第一句话才是用户现在马上能做的动作，控制在 25 个字以内。之后才展开细节，总长度不超过 150 字。
4. 描述位置必须可执行：以「NFC 标签」为基准给相对方位，例如“从标签向右约两指宽”“标签正上方一指宽”。禁止说“在旁边”“在桌子上”这类无法定位的描述。
5. 用户能靠触摸认出的只有「标签本身」：外形与物体同形，摸轮廓就知道是什么东西。提到标签时只说它的外形（形状、轮廓摸起来什么样），不要发明按钮上的凸点符号，也不要说标签上有图案、纹理或花纹。
6. 如果 safety_level 是 high，或问题涉及加热、电气、燃气、药品，先给出安全提示，不要做任何安全保证，不要给出档案外的剂量建议。
7. 回答末尾用一句话说明信息来源，例如“来源：说明书第 12 页 + 家人确认”。不要用 Markdown 标记，不要输出列表符号，纯口语短句即可。`;

function tagContextLines(item) {
  const shape = shapeOf(item);
  const lines = [];
  lines.push('触觉标签（一物一签，用户靠它先摸后碰）：');
  lines.push(
    `- 外形：${shape ? `${shape.shape}，摸起来${shape.feel}` : item.tag_shape}`
  );
  if (item.tag && item.tag.placement_note) lines.push(`- 标签贴放位置：${item.tag.placement_note}`);
  if (item.placement_note) lines.push(`- 摆放说明：${item.placement_note}`);
  return lines;
}

function buildUserPrompt(item, question) {
  const lines = [];
  lines.push('【物品档案】');
  lines.push(`名称：${item.name}`);
  if (item.brand_model) lines.push(`型号：${item.brand_model}`);
  lines.push(`类别：${item.category}`);
  lines.push(`位置：${item.location || '未录入'}`);
  lines.push(`安全等级：${item.safety_level === 'high' ? '高风险，需要额外谨慎' : '普通'}`);
  lines.push(`说明：${item.summary}`);
  tagContextLines(item).forEach((l) => lines.push(l));
  lines.push('按钮与控制件（方位以标签为基准）：');
  item.controls.forEach((c) => {
    lines.push(`- ${c.name}｜位置：${c.position || '未录入'}`);
  });
  lines.push('已确认的操作步骤：');
  item.actions.forEach((a, i) => {
    lines.push(`${i + 1}. ${a.action_name}（来源：${a.source}${a.verified ? '，已确认' : '，未确认'}）`);
    a.steps.forEach((s) => lines.push(`   步骤：${s}`));
  });
  if (item.safety_notes.length) {
    lines.push('安全提示：');
    item.safety_notes.forEach((s) => lines.push(`- ${s}`));
  }
  lines.push('');
  lines.push(`【用户问题】${question}`);
  lines.push('请按规则用口语回答，只使用上面的档案信息。');
  return lines.join('\n');
}

async function askLLM(item, question) {
  const { content, meta } = await chatCompletion({
    baseUrl: LLM_BASE_URL,
    apiKey: LLM_API_KEY,
    model: LLM_MODEL,
    maxTokens: LLM_MAX_TOKENS,
    temperature: 0.2,
    effort: LLM_EFFORT,
    timeoutMs: LLM_TIMEOUT_MS,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(item, question) },
    ],
  });
  return { answer: content, answer_source: 'llm', matched_action: null, llm_meta: meta };
}

// --------------------------------------------------- 本地检索兜底引擎
// 定位：不是“生成”，而是“检索 + 拼装”。只会说出档案里已有的句子。

const STOP_BIGRAMS = new Set([
  '怎么', '怎样', '如何', '这个', '那个', '什么', '可以', '能不能', '一下', '请问',
  '告诉', '我要', '我想', '帮我', '现在', '我们', '我的', '这是', '是不', '不是',
]);

// 同义词扩展：用户口语和档案用词不一致时，先做一轮改写再检索
// （仍然只是检索，不生成任何档案里没有的内容）
const SYNONYMS = {
  忘记: '漏服 忘吃 漏掉 补服',
  忘了: '漏服 忘吃 漏掉 补服',
  漏: '漏服 补服',
  几片: '剂量 每次一片 服用',
  几次: '剂量 次数 每天两次',
  多久: '时间 分钟 小时 保质期',
  按键: '按钮 凸点 摸到',
  按钮: '按键 凸点 位置',
  在哪: '位置 摸到 凸点',
  怎么用: '操作 步骤',
  坏了: '故障 不动 没反应',
  响: '蜂鸣 提示音',
  洗: '机洗 水洗 洗涤 水温',
  搭: '搭配 配',
  能穿: '合适 正式 搭配',
  安全: '注意 危险 不能 禁止',
  省电: '功率 耗电',
};

function expandQuestion(question) {
  const q = String(question);
  const extras = [];
  Object.keys(SYNONYMS).forEach((k) => {
    if (q.includes(k)) extras.push(...SYNONYMS[k].split(' ').filter(Boolean));
  });
  return { text: extras.length ? `${q} ${extras.join(' ')}` : q, extras };
}

function bigrams(text) {
  const t = String(text)
    .replace(/[\s，。？?！!、,.：:；;""''（）()\[\]【】《》\-—～~]/g, '')
    .toLowerCase();
  const out = new Set();
  for (let i = 0; i < t.length - 1; i += 1) out.add(t.slice(i, i + 2));
  if (t.length === 1) out.add(t);
  return out;
}

function overlapScore(qgrams, text, weight) {
  if (!text) return 0;
  const hay = text.toLowerCase();
  let hits = 0;
  qgrams.forEach((g) => {
    if (hay.includes(g)) hits += 1;
  });
  return hits * weight;
}

const INTENTS = [
  { id: 'location', weight: 2, words: ['在哪', '哪里', '位置', '哪里按', '怎么找', '哪个按钮', '摸到', '找不', '按哪'] },
  { id: 'safety', weight: 2, words: ['安全', '危险', '注意', '会不会', '有毒', '烫', '出事', '误', '禁忌', '副作用', '过敏'] },
  { id: 'dose', weight: 2, words: ['几片', '几次', '几勺', '多少', '剂量', '多久吃', '几下', '几格', '度数'] },
  { id: 'operation', weight: 3, words: ['怎么', '如何', '操作', '按', '开', '关', '加热', '洗', '煮', '解冻', '停止', '启动', '冲泡', '脱水', '预约', '用'] },
  { id: 'attribute', weight: 1, words: ['是什么', '介绍', '这是什么', '保质', '多久', '型号', '颜色', '材质', '搭配', '能不能穿', '合适'] },
  { id: 'list', weight: 1, words: ['能问什么', '有什么', '能干', '都能问', '帮助', '功能'] },
];

function detectIntent(question) {
  const q = String(question);
  let best = { id: 'unknown', weight: 0 };
  INTENTS.forEach((it) => {
    const hit = it.words.filter((w) => q.includes(w)).length;
    if (hit > 0 && hit * it.weight >= best.weight) best = { id: it.id, weight: hit * it.weight };
  });
  return best.id;
}

function bestAction(item, qgrams, extras) {
  let best = null;
  item.actions.forEach((a) => {
    const text = `${a.action_name} ${a.steps.join(' ')}`;
    const nameScore = overlapScore(qgrams, a.action_name, 6);
    const bodyScore = overlapScore(qgrams, a.steps.join(' '), 1);
    const controlScore = overlapScore(qgrams, item.controls.map((c) => c.name).join(' '), 2);
    // 同义词命中是强信号：口语和档案用词不同时靠它召回
    const synHits = (extras || []).filter((t) => text.includes(t)).length;
    const total = nameScore * 3 + bodyScore + controlScore + synHits * 5;
    if (!best || total > best.score) best = { action: a, score: total, synHits };
  });
  return best;
}

function shapePhrase(item) {
  const shape = shapeOf(item);
  return shape ? `${shape.shape}标签` : '触觉标签';
}

function firstSentence(text, max = 60) {
  if (!text) return '';
  const cut = text.split(/[。！？]/).filter(Boolean)[0] || text;
  return cut.length > max ? `${cut.slice(0, max)}` : `${cut}。`;
}

function askLocal(item, question) {
  const intent = detectIntent(question);
  const expanded = expandQuestion(question);
  const qgrams = bigrams(expanded.text);
  // 高风险物品：只要回答牵着操作步骤，就先声明边界
  const riskPrefix =
    item.safety_level === 'high'
      ? '这是高风险物品，我只复述档案里已经确认过的内容。'
      : '';

  if (intent === 'list') {
    const names = item.actions.map((a) => a.action_name).join('；');
    return {
      answer: `现在可以问我这些：${names}。也可以问我按钮在哪里、有什么安全注意。`,
      answer_source: 'local-rule-engine',
      matched_action: null,
    };
  }

  if (intent === 'location') {
    const scored = item.controls
      .map((c) => ({ c, score: overlapScore(qgrams, c.name, 4) + overlapScore(qgrams, c.position, 1) }))
      .sort((a, b) => b.score - a.score);
    const top = scored[0];
    if (!top || top.score === 0) {
      const list = item.controls.map((c) => `${c.name}：${c.position}`).join('。');
      return {
        answer: `档案里没有记录这个按钮的位置。已知的定位基准是：先摸到${shapePhrase(item)}，其它按键都在它附近。已录入的控制件有：${list}。`,
        answer_source: 'local-rule-engine',
        matched_action: null,
      };
    }
    return {
      answer: `${top.c.name}的位置是：${top.c.position}。`,
      answer_source: 'local-rule-engine',
      matched_action: null,
    };
  }

  if (intent === 'safety') {
    const guard =
      item.safety_level === 'high'
        ? '这一项属于高风险类别，档案里没有写到的操作我不会给建议。'
        : '';
    const notes = item.safety_notes.length
      ? item.safety_notes.map((n) => n).join(' ')
      : '档案里还没有录入安全注意事项，建议让家人补充后再操作。';
    const source = item.safety_notes.length ? '物品档案里的安全提示' : '物品档案（暂无安全提示）';
    return {
      answer: `${guard}${notes} 来源：${source}。`,
      answer_source: 'local-rule-engine',
      matched_action: null,
    };
  }

  const cand = bestAction(item, qgrams, expanded.extras);

  if (intent === 'dose' && item.safety_level === 'high') {
    const dose = item.actions.find((a) => /剂量|服用|几次|几片|次数/.test(a.action_name + a.steps.join('')));
    const prefix = '剂量和次数属于高风险信息，我只复述档案里已经由专业人员确认过的内容。';
    if (dose) {
      return {
        answer: `${prefix}${dose.steps.join(' ')} 来源：${dose.source}。`,
        answer_source: 'local-rule-engine',
        matched_action: dose.action_name,
      };
    }
    return {
      answer: `${prefix}档案里没有录入剂量信息，请以医生面诊结论或药师书面确认为准。`,
      answer_source: 'local-rule-engine',
      matched_action: null,
    };
  }

  if (cand && cand.score >= 3) {
    const a = cand.action;
    const head = firstSentence(a.steps[0]);
    const rest = a.steps.slice(1);
    const body = rest.length ? ` ${rest.join(' ')}` : '';
    const verified = a.verified ? '已确认' : '尚未确认，请谨慎使用';
    return {
      answer: `${riskPrefix}${head}${body} 来源：${a.source}（${verified}）。`,
      answer_source: 'local-rule-engine',
      matched_action: a.action_name,
    };
  }

  if (intent === 'attribute') {
    const parts = [];
    if (item.brand_model) parts.push(`型号是${item.brand_model}`);
    if (item.summary) parts.push(item.summary);
    if (item.location) parts.push(`放在${item.location}`);
    return {
      answer: `${parts.join('。')} 来源：物品档案。`,
      answer_source: 'local-rule-engine',
      matched_action: null,
    };
  }

  const names = item.actions.map((a) => a.action_name).join('；');
  return {
    answer: `档案里没有和这个问题对应的记录，我不会凭常识补充。已录入的操作有：${names}。先摸到${shapePhrase(item)}就可以碰手机打开本页。如需新增内容，请在创建页补录后再问。`,
    answer_source: 'local-rule-engine',
    matched_action: null,
  };
}

async function ask(item, question) {
  const q = String(question || '').trim();
  if (!q) {
    const err = new Error('问题不能为空');
    err.statusCode = 400;
    throw err;
  }
  if (llmEnabled()) {
    try {
      return await askLLM(item, q);
    } catch (e) {
      console.error('[ai] 大模型调用失败，回退到本地检索引擎:', e.message);
      const fallback = askLocal(item, q);
      fallback.answer_source = 'local-rule-engine (llm-failed)';
      fallback.llm_error = e.message;
      return fallback;
    }
  }
  return askLocal(item, q);
}

// --------------------------------------------------- 创建阶段：候选建议
// PRD F07：AI 只给候选，用户必须确认后才能入库。

const CATEGORY_TEMPLATES = {
  家电: {
    controls: [
      { name: '电源', kind: 'button', position: '面板最右端，待确认' },
      { name: '开始 / 暂停', kind: 'button', position: '待确认（建议以标签为基准记相对方位）' },
      { name: '停止 / 取消', kind: 'button', position: '待确认' },
      { name: '显示屏', kind: 'display', position: '面板最上方一行' },
    ],
  },
  衣物: {
    controls: [
      { name: '触觉标签', kind: 'touch', position: '领口内侧左下角' },
      { name: '水洗标', kind: 'display', position: '腰部内侧布标' },
    ],
  },
  药品: {
    controls: [{ name: '触觉标签', kind: 'touch', position: '药盒盖内侧中央' }],
  },
  食品: {
    controls: [
      { name: '袋口夹子', kind: 'touch', position: '袋口顶部' },
      { name: '保质期位置', kind: 'display', position: '袋身右上角' },
    ],
  },
  娱乐: {
    controls: [{ name: '触觉标签', kind: 'touch', position: '道具背面中央' }],
  },
  易丢物品: {
    controls: [{ name: '触觉标签', kind: 'touch', position: '物品背面下半部' }],
  },
};

function suggestCandidates({ name, category, notes } = {}) {
  const tpl = CATEGORY_TEMPLATES[category] || CATEGORY_TEMPLATES['家电'];
  const keyword = `${name || ''} ${notes || ''}`;
  const actions = [];
  if (/微波炉/.test(keyword)) {
    actions.push({
      action_name: '加热一杯牛奶 60 秒',
      steps: ['把杯子放中央，关门', '按开始键一次', '按加时键两下加到 60 秒', '再按开始键'],
      source: 'AI 候选，待用户确认',
      verified: false,
    });
  } else if (/洗衣/.test(keyword)) {
    actions.push({
      action_name: '洗一次日常衣物',
      steps: ['放入衣物关舱门', '旋钮转到日常档', '按开始键'],
      source: 'AI 候选，待用户确认',
      verified: false,
    });
  } else if (/饭煲|电饭/.test(keyword)) {
    actions.push({
      action_name: '煮两杯米的白饭',
      steps: ['放两杯米加水到刻度 2', '按功能键选精煮', '按开始键'],
      source: 'AI 候选，待用户确认',
      verified: false,
    });
  } else if (/药|片|胶囊/.test(keyword)) {
    actions.push({
      action_name: '每天的服用方式',
      steps: ['待填写：请让医生或药师确认剂量与次数', '待填写：请确认是否随餐服用'],
      source: 'AI 候选，必须由专业人员确认',
      verified: false,
    });
  } else {
    actions.push({
      action_name: '待填写：最常用的一个操作',
      steps: ['待填写第一句：用户马上能做的动作', '待填写第二句：按键在标签的什么方位', '待填写第三句：如何确认成功'],
      source: 'AI 候选，待用户确认',
      verified: false,
    });
  }
  const risk = /药|加热|燃气|电/.test(keyword) || category === '药品';
  return {
    source: 'template',
    needs_confirmation: true,
    notice: '以下内容为候选结果，须由录入人逐条确认后方可作为正式档案使用。',
    category: category || '家电',
    safety_level: risk ? 'high' : 'normal',
    tag_shape: suggestShape(name, category),
    controls: tpl.controls,
    actions,
    safety_notes: risk
      ? ['高风险类别：档案中没有写到的操作，助手不会给建议。', '请补充本机特有的事故预防事项。']
      : ['请补充本物品特有的事故预防事项。'],
  };
}

/* 现场自检：真的打一次模型，回报延迟与 token 用量。
 * 路演前一条命令就能确认「AI 通了没有」，不用等到评委面前才发现密钥过期。
 */
async function selftest() {
  if (!llmEnabled()) {
    return { ok: false, engine: 'local-rule-engine', reason: '未配置大模型，当前使用本地检索引擎（这是可用的兜底，不是故障）' };
  }
  const started = Date.now();
  try {
    const { content, meta } = await chatCompletion({
      baseUrl: LLM_BASE_URL,
      apiKey: LLM_API_KEY,
      model: LLM_MODEL,
      // 自检也得给足预算：推理模型的思考照样吃 max_tokens，
      // 给小了会把「能连通」误判成「不通」。
      maxTokens: Math.max(2048, Math.min(LLM_MAX_TOKENS, 4096)),
      temperature: 0,
      effort: LLM_EFFORT,
      timeoutMs: LLM_TIMEOUT_MS,
      messages: [
        { role: 'system', content: '你只回复 JSON，不要任何解释。' },
        { role: 'user', content: '只输出 {"ok":true} 这一个 JSON，不要别的字。' },
      ],
    });
    return {
      ok: true,
      engine: 'llm',
      model: meta.model,
      effort: VALID_EFFORT.includes(LLM_EFFORT) ? LLM_EFFORT : null,
      max_tokens: LLM_MAX_TOKENS,
      reply: content.slice(0, 200),
      elapsed_ms: Date.now() - started,
      prompt_tokens: meta.prompt_tokens,
      completion_tokens: meta.completion_tokens,
      reasoning_tokens: meta.reasoning_tokens,
    };
  } catch (e) {
    return {
      ok: false,
      engine: 'llm',
      model: LLM_MODEL,
      error: e.message,
      diagnostic: e.diagnostic || null,
      elapsed_ms: Date.now() - started,
      note: '调用失败时问答会自动回退到本地检索引擎，用户仍能得到只引用档案的回答。',
    };
  }
}

module.exports = { ask, askLocal, suggestCandidates, llmStatus, llmEnabled, selftest, SYSTEM_PROMPT };
