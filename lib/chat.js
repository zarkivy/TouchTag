'use strict';

/* 触界 —— OpenAI 兼容接口的共用调用层
 *
 * 存在的理由：DeepSeek-V4.1-Flash 这类**推理模型**会先返回一大段
 * reasoning_content，而且思考 token 计入 max_tokens。预算给小了就会出现
 * 「HTTP 200 + finish_reason=length + 正文为空」——看起来成功，实际没答。
 * 这个坑如果每个调用点各写一遍，必然漏掉一处。所以统一在这里处理：
 *   1. 只取 message.content，reasoning_content 永不外泄（更不能被念出来）；
 *   2. 正文为空时抛出带诊断信息的错误，交给上层决定兜底；
 *   3. effort 只在模型方声明支持时才带上，避免不支持的厂商直接 400。
 */

const DEFAULT_TIMEOUT_MS = 60000;

async function chatCompletion({
  baseUrl,
  apiKey,
  model,
  messages,
  maxTokens = 2400,
  temperature = 0.2,
  effort,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  extraHeaders,
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const payload = { model, messages, max_tokens: maxTokens, temperature };
    if (effort && ['low', 'high', 'max'].includes(effort)) payload.effort = effort;

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        ...(extraHeaders || {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const raw = await res.text();
    if (!res.ok) {
      const err = new Error(`模型返回 ${res.status}: ${raw.slice(0, 300)}`);
      err.statusCode = 502;
      err.upstream_status = res.status;
      throw err;
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      const err = new Error(`模型返回了非 JSON 内容: ${raw.slice(0, 200)}`);
      err.statusCode = 502;
      throw err;
    }
    if (data && data.error) {
      const err = new Error(`模型返回错误: ${String(data.error.message || '').slice(0, 300)}`);
      err.statusCode = 502;
      throw err;
    }

    const choice = (data.choices && data.choices[0]) || {};
    const msg = choice.message || {};
    const content = typeof msg.content === 'string' ? msg.content.trim() : '';
    const reasoning = typeof msg.reasoning_content === 'string' ? msg.reasoning_content : '';
    const usage = data.usage || {};
    const reasoningTokens =
      (usage.completion_tokens_details && usage.completion_tokens_details.reasoning_tokens) || 0;

    const meta = {
      model: data.model || model,
      finish_reason: choice.finish_reason || null,
      elapsed_ms: Date.now() - started,
      prompt_tokens: usage.prompt_tokens || 0,
      completion_tokens: usage.completion_tokens || 0,
      reasoning_tokens: reasoningTokens,
      reasoning_chars: reasoning.length,
    };

    if (!content) {
      // 区分两种「空」：预算被思考耗尽（可修）vs 模型真的没话说（要换问法）
      const why =
        choice.finish_reason === 'length'
          ? `输出预算被思考过程耗尽（max_tokens=${maxTokens}，其中思考约 ${reasoningTokens} token）。调大 TOUCHTAG_*_MAX_TOKENS，或把 effort 调低。`
          : '模型返回了空内容';
      const err = new Error(why);
      err.statusCode = 502;
      err.diagnostic = meta;
      throw err;
    }

    return { content, meta, reasoning };
  } catch (e) {
    if (e.name === 'AbortError') {
      const err = new Error(`模型调用超时（${timeoutMs}ms）`);
      err.statusCode = 504;
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/* 模型爱把 JSON 包在 ```json 代码块里，或在前后各说一句人话。
 * 统一在这里剥掉，省得每个调用点各写一份、各漏一处。 */
function parseJsonLoose(text) {
  let t = String(text == null ? '' : text).trim();
  t = t.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('模型没有返回 JSON');
  return JSON.parse(t.slice(start, end + 1));
}

module.exports = { chatCompletion, parseJsonLoose };
