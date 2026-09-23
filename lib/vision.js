'use strict';

/* 触界 —— 视觉理解（两个位置，两种任务）
 *
 * A. 配置端「看一次」（创建阶段）：
 *    把设备照片编译成物品档案候选（按钮清单、操作步骤、标签外形建议）。
 *    模型只给候选，needs_confirmation 恒为 true，必须人工逐条确认才能入库。
 *
 * B. 使用端「看一眼」（第三层信息传递）：
 *    用户已经通过触摸 + NFC 知道「这是什么物品」，现在打开摄像头拍下此刻的样子，
 *    AI 结合物品档案回答「此刻的实时信息」：屏幕读数、指示灯、里面有什么、
 *    颜色款式、是否开封/到期等。这是三层模型里的第三层。
 *
 * 硬约束：
 *   1. 两个任务都不做安全保证；高风险类别（药品/加热/燃气）只描述事实，不给操作指令；
 *   2. 未接入视觉模型时，明确告知，绝不假装「AI 看过照片」；
 *   3. 「看一眼」的照片与档案物品不符时，必须如实说明。
 */

const { chatCompletion } = require('./chat');
const { SHAPES, suggestShape } = require('./tactile');

const VLM_BASE_URL = (process.env.TOUCHTAG_VLM_BASE_URL || '').replace(/\/+$/, '');
const VLM_API_KEY = process.env.TOUCHTAG_VLM_API_KEY || '';
const VLM_MODEL = process.env.TOUCHTAG_VLM_MODEL || '';
const VLM_TIMEOUT_MS = Number(process.env.TOUCHTAG_VLM_TIMEOUT_MS || 120000);

/* 看图任务要同时产出控制件清单和操作步骤候选，输出比纯问答长得多。
 * 推理模型的思考 token 也计入 max_tokens，预算给小了会「200 但正文空」。
 * 实测：900 → 必失败；6000 → 加了步骤起草后又被思考吃穿；16000 稳定。
 */
const VLM_MAX_TOKENS = Number(process.env.TOUCHTAG_VLM_MAX_TOKENS || 16000);
const VLM_EFFORT = (process.env.TOUCHTAG_VLM_EFFORT || 'low').toLowerCase();
const VALID_EFFORT = ['low', 'high', 'max'];

function vlmEnabled() {
  return Boolean(VLM_BASE_URL && VLM_API_KEY && VLM_MODEL);
}

function vlmStatus() {
  return {
    enabled: vlmEnabled(),
    model: vlmEnabled() ? VLM_MODEL : null,
    max_tokens: vlmEnabled() ? VLM_MAX_TOKENS : null,
    effort: vlmEnabled() && VALID_EFFORT.includes(VLM_EFFORT) ? VLM_EFFORT : null,
    engine: vlmEnabled() ? 'vlm' : 'template-only',
  };
}

// ---------------------------------------------------------------- A. 配置端候选

const SHAPE_MENU = SHAPES.map((s) => `${s.id}=${s.name}（适合：${s.object_hint}）`).join('；');

/* 物品档案里「AI 应该尽量替人填掉」的那几个字段。
 * 模型给不出值的，前端会把这个字段标红，提示录入人手动补。
 * 顺序即页面上的顺序。 */
const ITEM_CATEGORIES = ['家电', '衣物', '药品', '食品', '娱乐', '易丢物品', '其他'];
const AUTOFILL_FIELDS = ['name', 'category', 'brand_model', 'location', 'summary', 'placement_note'];

const VLM_PROMPT = `你在帮一个无障碍项目填写「物品档案」。这个项目给每件物品贴一枚 NFC 触觉标签：标签是 3D 打印出来的小卡片，外形与物体本身同形（摸轮廓就知道是什么，也靠轮廓区分类别），卡片中部有两个可摸到的凸点作为「手机碰这里」的 NFC 触碰点。标签上没有任何图案或纹理，别提起这类东西。

你的任务是**尽可能多地把档案字段填掉**，让人只需要补你确实看不出来的那几项。请只输出一个 JSON 对象（不要 Markdown 代码块，不要解释文字），字段如下：
{
  "panel_visible": true 或 false（这张照片里到底能不能看到可操作的按钮/旋钮/控制面板）,
  "device_guess": "你判断这是什么设备/物品（中文，简短）",
  "visible_text": ["照片上能看清的文字或图标说明"],

  "name_guess": "建议的物品名称（中文，12 字以内；看得出用途或位置就带上，例如 厨房微波炉、衣柜里的黑衬衫）",
  "category_guess": "只能从这几个里原样选一个：${ITEM_CATEGORIES.join('、')}",
  "brand_model_guess": "照片上看得清的品牌与型号（例如 美的 M1-L213B）；看不清就填空字符串，绝对不要猜",
  "location_guess": "从照片背景能看出的摆放位置（例如 厨房台面靠窗一侧）；看不出来就填空字符串",
  "summary": "一句话说明这件物品长什么样、控制件在哪里，交给盲人听（40 字以内）",
  "placement_note": "建议把这枚标签贴在物品的哪个位置（一句话，例如：贴在控制面板右下角，别挡住散热口）",

  "tag_shape_guess": "建议的标签外形 id，只能从下面的清单里选：${SHAPE_MENU}",

  "controls": [
    { "name": "控制件名称", "kind": "button|knob|display|touch", "panel_hint": "在物品上的相对位置描述，例如 面板右下角", "tag_hint": "假设标签贴在你建议的位置，用户从标签出发怎么摸到它，例如 从标签向右约两指宽" }
  ],
  "suggested_actions": [
    {
      "action_name": "用户最常做的那件事（例如 加热一杯牛奶 60 秒）",
      "steps": ["第一句：用户马上能做的动作", "第二句：按键在标签的什么方位（用『从标签向右两指宽』这类相对方位）", "第三句：如何确认操作成功"],
      "confidence": "high|medium|low"
    }
  ],
  "safety_notes": ["这类物品使用时要留意的点，不确定就写待确认"],
  "confidence": "high|medium|low"
}

规则：
1. **判断物品类型只能靠照片**。背景信息里的「想用它做什么」只用来决定起草哪几件操作，
   绝不能拿它去猜这是什么。背景信息里的「物品名」为空时，就完全按照片判断，不要脑补。
2. 只描述照片里确实能看到的东西。看不清就写「看不清，待确认」，不要猜型号。
3. panel_hint 用「面板左上/中央/右下」这类相对方位，不要写「在旁边」。
4. suggested_actions 的写法取决于有没有给「想用它做什么」：
   - **给了**（背景信息里的 intent 非空）：围绕那件事起草 1 到 3 条候选操作。
   - **没给**：只给 1 条最基础、最不容易出错的（例如 如何立即停止），
     不要替用户发明使用场景。
   每条 steps 必须 3 句、每句不超过 30 字，念给盲人听。
   方位一律以「标签」为基准（『从标签向上一指宽』），因为标签是用户唯一能先摸到的东西。
   只使用你在 controls 里确实看到的按键，不要发明照片里没有的按键或档位。
5. tag_shape_guess 必须从清单里选，选最适合这件物品轮廓的那个。
6. 如果照片里的物品涉及吃药、用药剂量、燃气或需要专业判断，suggested_actions 给空数组 []，
   在 safety_notes 里写明「具体步骤必须由医生、药师或专业人员确认后填写」。
7. 不要做任何安全保证。安全注意事项不确定的一律写「待确认」。
8. **照片里看不到控制面板时必须诚实认输**：输出
   "panel_visible": false、"controls": []、"suggested_actions": []、
   "device_guess" 照实写你看到的那个东西、"summary" 里说明「照片里没有拍到控制面板」、
   "confidence" 写 low。宁可直接说看不见，也不要为了凑答案编造按键。
9. name_guess、category_guess、summary、placement_note、tag_shape_guess 必须给。
   只有 brand_model_guess 和 location_guess 允许留空：**这两项只有照片里确实看得出来才填**，
   看不出来一律填空字符串 ""。空字符串会被系统当成「需要人工填写」，会自动提醒录入人补上；
   千万不要写「待确认」「未知」「不确定」这类占位词，那会把空位填死。
10. category_guess 必须是给定清单里的原词，原样输出，不要自创类别。
11. tag_hint 要用「从标签向右约两指宽」这种以标签为原点、手指能数出距离的说法，
    因为用户唯一能先摸到的就是标签本身。
12. 如果照片里拍到的其实是屏幕、纸面、说明书或另一台手机的界面（也就是「物件的照片」
    而不是物件本身），那么屏幕上那些文字属于别处的信息：
    brand_model_guess 和 location_guess 一律留空，并在 summary 里说明「照片里拍到的是
    屏幕/纸面，不是实物」。拍糊了、只拍到一角、只拍到包装盒的，同样按这条处理。

【效率要求】model 是推理模型，思考会直接变成用户等待的时间，请照做：
- 先看一眼照片判断类型，然后就下结论，不要反复推敲、不要穷举其他可能性；
- 每个字段给出最合理的判断即可，不要列出被否决的备选；
- 直接输出 JSON，不要在正文里解释你的思考过程。`;

function dataUrlToParts(dataUrl) {
  const m = String(dataUrl).match(/^data:(image\/(png|jpeg|jpg|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!m) {
    const err = new Error('图片格式不支持，请上传 JPG 或 PNG 照片');
    err.statusCode = 400;
    throw err;
  }
  const buf = Buffer.from(m[3], 'base64');
  if (buf.length > 3 * 1024 * 1024) {
    const err = new Error('照片太大了（上限 3MB），请压缩后再试');
    err.statusCode = 413;
    throw err;
  }
  return { mime: m[1] === 'image/jpg' ? 'image/jpeg' : m[1], bytes: buf.length };
}

function parseJsonLoose(text) {
  let t = String(text || '').trim();
  t = t.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('模型没有返回 JSON');
  return JSON.parse(t.slice(start, end + 1));
}

const HIGH_RISK = /药|片|胶囊|加热|微波|燃气|电|热水|炉/;

function clampStr(s, max) {
  return String(s == null ? '' : s).trim().slice(0, max);
}

/* 模型有时只给「面板右下角」这种相对面板的说法，而表单里这一栏要求
 * 「用户怎么摸到它」，参照物必须是标签。补一句前缀，让这句话念出来是完整的。 */
function withTagAnchor(text) {
  if (!text) return '';
  if (/标签/.test(text)) return text;
  return '从标签摸到面板后，' + text;
}

async function callVLM(prompt, imageDataUrl, maxTokens) {
  const { content, meta } = await chatCompletion({
    baseUrl: VLM_BASE_URL,
    apiKey: VLM_API_KEY,
    model: VLM_MODEL,
    maxTokens: maxTokens || VLM_MAX_TOKENS,
    temperature: 0.1,
    effort: VLM_EFFORT,
    timeoutMs: VLM_TIMEOUT_MS,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: imageDataUrl } },
        ],
      },
    ],
  });
  return { parsed: parseJsonLoose(content), meta };
}

/* 把模型给的候选步骤清洗成档案能直接用的形状。
 * 底线：verified 恒为 false；source 写明是「视觉模型候选」；句数与长度设上限。
 */
function sanitizeActions(raw, fallback) {
  if (!Array.isArray(raw)) return fallback;
  const out = [];
  raw.slice(0, 3).forEach((a) => {
    if (!a || typeof a !== 'object') return;
    const actionName = clampStr(a.action_name, 60);
    const steps = (Array.isArray(a.steps) ? a.steps : [])
      .map((s) => clampStr(s, 60))
      .filter(Boolean)
      .slice(0, 5);
    if (!actionName || !steps.length) return;
    out.push({
      action_name: actionName,
      steps,
      source: '视觉模型候选（必须人工确认后才能启用）',
      verified: false,
      confidence: ['high', 'medium', 'low'].includes(a.confidence) ? a.confidence : 'low',
    });
  });
  if (out.length) return out;
  /* 模型主动给空数组 = 它对「吃药/燃气/需专业判断」的自觉拒答。
   * 绝不能拿模板把步骤补回来，只留一条待填写占位，把决定权交回给人。
   */
  return [
    {
      action_name: '待填写：最常用的一个操作',
      steps: [
        '待填写第一句：用户马上能做的动作',
        '待填写第二句：按键在标签的什么方位',
        '待填写第三句：如何确认成功',
      ],
      source: '模型判断该物品需专业人员确认，未生成步骤',
      verified: false,
      confidence: 'low',
      placeholder: true,
    },
  ];
}

/* 把模型（或兜底逻辑）能确定的字段整理成一张「自动填写表」。
 * 约定：值为空字符串 = 这一项 AI 判不出来，需要人手工填，前端据此把该字段标红。
 *
 * fallback 放的是用户自己在表单里已经敲进去的值：模型没给值时就沿用它，
 * 免得「AI 跑一趟把用户刚填的东西清空」。
 */
function buildAutofill(raw, fallback, options) {
  const r = raw || {};
  const f = fallback || {};
  const pick = (a, b) => clampStr(a, 200) || clampStr(b, 200);
  /* dropPhysical：照片里连控制面板都没看到时置真。
   * 实测踩过的坑：拍的是电脑屏幕 / 纸面 / 另一台手机的界面时，模型会把屏幕上的文字
   * 当成这件物品的型号和摆放位置填进来（「美的 KZC50」「厨房台面靠墙一侧」其实来自截图）。
   * 这两项会被当成事实念给用户听，宁可留空交给人工，也不要在这时候硬填。 */
  const drop = Boolean(options && options.dropPhysical);
  return {
    name: pick(r.name_guess, f.name),
    category: ITEM_CATEGORIES.includes(r.category_guess) ? r.category_guess : clampStr(f.category, 20),
    // 品牌型号与物理位置是模型最容易「一本正经胡说」的两项：
    // 允许为空，且绝不拿用户填的其它字段去顶替。
    brand_model: (drop ? '' : clampStr(r.brand_model_guess, 80)) || clampStr(f.brand_model, 80),
    location: (drop ? '' : clampStr(r.location_guess, 80)) || clampStr(f.location, 80),
    summary: pick(r.summary, f.summary),
    placement_note: pick(r.placement_note, f.placement_note),
  };
}

/* 空值字段清单：前端拿它决定把哪几格标红 */
function listNeedsManual(autofill) {
  return AUTOFILL_FIELDS.filter((k) => !autofill[k]);
}

// 未接入视觉模型时的兜底：明确标注「没看图」，只给类别模板候选
function templateFromCategory(category) {
  const T = {
    家电: {
      device_guess: '家电控制面板（按类别推断）',
      controls: [
        { name: '电源 / 开关', kind: 'button', panel_hint: '通常在面板最右端或左上角，待人工核对' },
        { name: '开始 / 暂停', kind: 'button', panel_hint: '面板中央附近，待人工核对' },
        { name: '停止 / 取消', kind: 'button', panel_hint: '靠近开始键，待人工核对' },
        { name: '显示屏', kind: 'display', panel_hint: '面板上方一行' },
      ],
    },
    衣物: {
      device_guess: '衣物（按类别推断）',
      controls: [{ name: '触觉标签', kind: 'touch', panel_hint: '领口内侧左下角' }],
    },
    药品: {
      device_guess: '药品包装（按类别推断）',
      controls: [{ name: '触觉标签', kind: 'touch', panel_hint: '盒盖内侧中央' }],
    },
    食品: {
      device_guess: '食品包装（按类别推断）',
      controls: [
        { name: '袋口夹子', kind: 'touch', panel_hint: '袋口顶部' },
        { name: '保质期位置', kind: 'display', panel_hint: '袋身右上角' },
      ],
    },
    娱乐: {
      device_guess: '道具（按类别推断）',
      controls: [{ name: '触觉标签', kind: 'touch', panel_hint: '道具背面中央' }],
    },
    易丢物品: {
      device_guess: '小物件（按类别推断）',
      controls: [{ name: '触觉标签', kind: 'touch', panel_hint: '物品背面下半部' }],
    },
  };
  return T[category] || T['家电'];
}

function suggestActions(name, category) {
  const keyword = `${name || ''}`;
  if (/微波炉/.test(keyword)) {
    return [
      {
        action_name: '加热一杯牛奶 60 秒',
        steps: ['把杯子放在转盘中央，关门到底', '按开始键一次', '按加时键两下，加起来 60 秒', '再按开始键开始加热'],
        source: '候选步骤（待确认）',
        verified: false,
      },
    ];
  }
  if (/洗衣/.test(keyword)) {
    return [
      {
        action_name: '洗一次日常衣物',
        steps: ['放入衣物并关好舱门', '旋钮转到日常档', '按开始键'],
        source: '候选步骤（待确认）',
        verified: false,
      },
    ];
  }
  if (/饭煲|电饭/.test(keyword)) {
    return [
      {
        action_name: '煮两杯米的白饭',
        steps: ['放两杯米，加水到刻度 2', '按功能键选精煮', '按开始键'],
        source: '候选步骤（待确认）',
        verified: false,
      },
    ];
  }
  if (category === '药品' || /药|片|胶囊/.test(keyword)) {
    return [
      {
        action_name: '每天的服用方式',
        steps: ['待填写：请让医生或药师确认剂量与次数', '待填写：请确认是否随餐服用'],
        source: '候选（必须由专业人员确认）',
        verified: false,
      },
    ];
  }
  return [
    {
      action_name: '待填写：最常用的一个操作',
      steps: ['待填写第一句：用户马上能做的动作', '待填写第二句：按键在标签的什么方位', '待填写第三句：如何确认成功'],
      source: '候选步骤（待确认）',
      verified: false,
    },
  ];
}

/* 配置端主入口：可选带照片。返回结构始终包含 needs_confirmation: true。 */
async function candidates({ image, name, category, notes, intent } = {}) {
  const rawImage = typeof image === 'string' && image.startsWith('data:image/') ? image : '';
  const hasImage = Boolean(rawImage);
  const meta = hasImage ? dataUrlToParts(rawImage) : null;
  const risk = category === '药品' || HIGH_RISK.test(`${name || ''} ${notes || ''}`);
  // 用户自己已经敲进表单的值：模型没把握时沿用它，而不是清空
  const userFallback = { name, category, summary: notes };
  const baseAutofill = buildAutofill(null, userFallback);
  const base = {
    needs_confirmation: true,
    category: category || '家电',
    safety_level: risk ? 'high' : 'normal',
    image_seen: false,
    tag_shape: suggestShape(name, category),
    actions: suggestActions(name, category),
    safety_notes: risk
      ? ['高风险类别：档案里没有写到的操作，助手不会给建议。', '请补充本机特有的事故预防事项。']
      : ['请补充本物品特有的事故预防事项。'],
    autofill: baseAutofill,
    needs_manual: listNeedsManual(baseAutofill),
  };

  if (hasImage && vlmEnabled()) {
    try {
      const { parsed: r } = await callVLM(
        VLM_PROMPT +
          `\n\n背景信息：\n` +
          `- 物品名（用户自填，可能为空；为空时完全按照片判断）= ${name || '（空）'}\n` +
          `- 类别（用户自选，仅供参考）= ${category || '未填'}\n` +
          `- 想用它做什么 = ${intent || '（空）'}　⚠️ 这一项只决定起草哪几件操作，绝不能用来推断这是什么物品\n` +
          `- 其它备注 = ${notes || '无'}`,
        rawImage
      );
      const controls = (Array.isArray(r.controls) ? r.controls : [])
        .slice(0, 12)
        .map((c) => ({
          name: clampStr(c && c.name, 60),
          kind: ['button', 'knob', 'display', 'touch'].includes(c && c.kind) ? c.kind : 'button',
          // 表单要的是「以标签为基准」的说法，优先用 tag_hint；
          // 模型只给了 panel_hint 时，前面补上「标签附近」，别让这句读起来像没有参照物。
          position: clampStr(c && c.tag_hint, 200)
            || withTagAnchor(clampStr(c && (c.panel_hint || c.position), 200)),
        }))
        .filter((c) => c.name);
      const modelNotes = Array.isArray(r.safety_notes)
        ? r.safety_notes.slice(0, 6).map((s) => clampStr(s, 200)).filter(Boolean)
        : [];
      const modelActions = sanitizeActions(r.suggested_actions, base.actions);
      const generatedSteps = modelActions.some((a) => a.source.indexOf('视觉模型候选') === 0);
      const panelVisible = typeof r.panel_visible === 'boolean' ? r.panel_visible : controls.length > 0;
      const noActionsReason = generatedSteps
        ? null
        : !panelVisible || !controls.length
        ? 'no_panel'
        : 'needs_professional';
      const notice = generatedSteps
        ? '上面这些是照着照片填的，还需要你对照实物核对一遍。'
        : noActionsReason === 'no_panel'
        ? '这张照片里没有看到按钮或控制面板，所以没生成按钮清单，也没写操作步骤。请对准按钮那一面重拍一张，或直接在下面手动补。'
        : '照片里的按钮已经列出来了，但这类东西涉及专业判断（用药、剂量、燃气等），AI 不会替你写操作步骤，需要你或专业人员填。';
      // 模型给的自动填写表 + 用户已填值兜底
      const autofill = buildAutofill(r, userFallback, { dropPhysical: !panelVisible });
      return {
        ...base,
        source: 'vlm',
        image_seen: true,
        confidence: clampStr(r.confidence, 12) || 'medium',
        panel_visible: panelVisible,
        device_guess: clampStr(r.device_guess, 60),
        visible_text: Array.isArray(r.visible_text) ? r.visible_text.slice(0, 12).map((s) => clampStr(s, 80)) : [],
        summary_candidate: autofill.summary,
        autofill,
        needs_manual: listNeedsManual(autofill),
        tag_shape: clampStr(r.tag_shape_guess, 20),
        controls,
        actions: modelActions,
        safety_notes: modelNotes.length
          ? risk
            ? ['高风险类别：档案里没有写到的操作，助手不会给建议。', ...modelNotes].slice(0, 6)
            : modelNotes
          : base.safety_notes,
        actions_generated_by_model: generatedSteps,
        no_actions_reason: noActionsReason,
        notice,
        image_bytes: meta.bytes,
      };
    } catch (e) {
      console.error('[vision] 视觉模型失败，回退模板候选:', e.message);
      return {
        ...base,
        source: 'template',
        device_guess: '',
        controls: templateFromCategory(category || '家电').controls,
        notice: `AI 这次没能看成照片（${e.message}），下面是一些通用的内容，请全部核对，或者稍后重试。`,
        vlm_error: e.message,
      };
    }
  }

  const tpl = templateFromCategory(category || '家电');
  return {
    ...base,
    source: 'template',
    device_guess: tpl.device_guess,
    controls: tpl.controls,
    notice: hasImage
      ? '照片会正常存进档案。这台服务器暂时没接上 AI 看图能力，所以下面这些是按「类别」给的通用内容，不是照着你的照片认出来的，请逐条核对。'
      : '这些是按名称和类别给的通用内容，请逐条核对后再保存。',
  };
}

// ---------------------------------------------------------------- B. 使用端「看一眼」（第三层）

const LOOK_PROMPT = `你在为一位盲人或低视力用户描述「TA 正在摸的那件物品」此刻的样子。
用户已经通过 NFC 标签知道这是什么物品（档案在下面）。现在 TA 用手机摄像头拍了一张照片，想知道**此刻的实时信息**。

请只输出一个 JSON 对象（不要 Markdown 代码块），字段如下：
{
  "matches_item": true 或 false（照片里的东西和档案里的物品是否对得上）,
  "summary": "第一句话：用户最需要知道的那个此刻状态（30 字以内，直接可念）",
  "details": ["此刻可见的实时信息，每条 40 字以内，最多 6 条，按重要性排序"],
  "confidence": "high|medium|low"
}

实时信息举例（只描述照片里真实可见的，不要编）：
- 家电：屏幕上的数字/模式、亮起的指示灯、门/盖是否关好、里面有没有东西、旋钮位置；
- 食品：包装上的保质期文字、是否已开封、内容物状态；
- 衣物：颜色、款式细节、穿着/搭配效果、有没有污渍；
- 通用：物品的摆放位置、朝向、新旧程度。

规则：
1. 只描述看得到的，看不清就写「看不清，待确认」。
2. 如果照片里的东西和档案物品明显不符，matches_item 填 false，并在 summary 里如实说「照片里看起来不是档案里的那件物品」。
3. 这类物品涉及药品、剂量、燃气或加热时：只描述事实（例如「屏幕显示 200 度」），**绝不给出操作指令**（例如「请把温度调到…」），也绝不给剂量建议。
4. 不要做任何安全保证。
5. 直接输出 JSON，不要解释思考过程。`;

function buildLookContext(item) {
  const lines = [];
  lines.push('【物品档案】');
  lines.push(`名称：${item.name}`);
  if (item.brand_model) lines.push(`型号：${item.brand_model}`);
  lines.push(`类别：${item.category}`);
  lines.push(`安全等级：${item.safety_level === 'high' ? '高风险' : '普通'}`);
  if (item.summary) lines.push(`说明：${item.summary}`);
  return lines.join('\n');
}

/* 第三层入口：用户拍下此刻的样子，AI 结合档案回答实时信息。
 * 没接入视觉模型时，返回明确说明（不假装看过图）。
 */
async function look(item, image) {
  const rawImage = typeof image === 'string' && image.startsWith('data:image/') ? image : '';
  if (!rawImage) {
    const err = new Error('还没有拍到照片');
    err.statusCode = 400;
    throw err;
  }
  const meta = dataUrlToParts(rawImage);

  if (!vlmEnabled()) {
    return {
      ok: false,
      source: 'unavailable',
      answer:
        '这一版还没有接入视觉模型，暂时帮不了「看一眼」。' +
        '可以先摸一摸标签，或用「听一听」「问一问」获取档案里已经录好的信息。',
      details: [],
      matches_item: null,
      confidence: null,
    };
  }

  try {
    const { parsed: r } = await callVLM(LOOK_PROMPT + '\n\n' + buildLookContext(item), rawImage, 4000);
    return {
      ok: true,
      source: 'vlm',
      matches_item: typeof r.matches_item === 'boolean' ? r.matches_item : null,
      summary: clampStr(r.summary, 120),
      details: Array.isArray(r.details) ? r.details.slice(0, 6).map((s) => clampStr(s, 120)).filter(Boolean) : [],
      confidence: clampStr(r.confidence, 12) || 'medium',
      image_bytes: meta.bytes,
    };
  } catch (e) {
    console.error('[vision] 看一眼失败:', e.message);
    return {
      ok: false,
      source: 'vlm-error',
      answer: `AI 这次没能看成（${e.message}）。可以再拍一张试试，或者先用「问一问」。`,
      details: [],
      matches_item: null,
      confidence: null,
    };
  }
}

module.exports = { candidates, look, vlmStatus, vlmEnabled, dataUrlToParts };
