'use strict';
/**
 * OpenAI-compatible streaming client (runs in the renderer, talks directly
 * to the local inference server — the app never proxies model traffic).
 *
 * Features: SSE parsing, abort (stop generation), thinking/reasoning channel
 * separation (llama.cpp `reasoning_content`, Ollama `reasoning`, <think> tags),
 * token usage from the final chunk, first-token latency, wall-clock tok/s.
 *
 * Environment-agnostic: also loadable from Node for unit tests.
 */
class StreamClient {
  /**
   * @param {object} opts { baseUrl, model, messages, params (sampling),
   *   signal (AbortSignal), onDelta(text), onReasoning(text), onUsage(usage),
   *   fetchImpl }
   * @returns {Promise<{content, reasoning, usage, firstTokenMs, elapsedMs, tps, stopped}>}
   */
  static async chat(opts) {
    const fetchImpl = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    if (!fetchImpl) throw new Error('No fetch implementation available');
    const started = Date.now();
    let firstTokenAt = null;
    let content = '';
    let reasoning = '';
    let usage = null;
    let stopped = false;
    let serverDone = false;

    const thinking = opts.thinking
      || (opts.params && opts.params.thinkingMode)
      || 'auto';
    const body = {
      model: opts.model || 'default',
      messages: opts.messages || [],
      stream: true,
      ...buildSampling(opts.params)
    };
    // Thinking tri-state: 'on' requests reasoning; 'off' EXPLICITLY disables
    // it (required for Ollama models that think by default, and for llama.cpp
    // chat templates that accept enable_thinking). 'auto'/undefined leaves
    // the engine default untouched.
    // llama.cpp streams include usage only when explicitly requested.
    if (opts.engineFamily === 'llama.cpp') body.stream_options = { include_usage: true };
    if (thinking === 'on') {
      body.think = true;
      body.chat_template_kwargs = { enable_thinking: true };
    } else if (thinking === 'off') {
      body.think = false;
      body.chat_template_kwargs = { enable_thinking: false };
      // llama.cpp: zero reasoning budget forces end-thinking for templates
      // that still open a think block when kwargs are ignored.
      body.reasoning_budget = 0;
    }

    const res = await fetchImpl(`${opts.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: opts.signal
    });

    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try { detail += ' — ' + (await res.text()).slice(0, 300); } catch (_) { /* ignore */ }
      throw new Error(`Inference request failed: ${detail}`);
    }
    if (!res.body) throw new Error('Streaming not supported by this response');

    // <think> tag state (some models emit raw DeepSeek-style tags)
    let inThink = false;
    let sawThinkClose = false;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') { serverDone = true; continue; }
          let j;
          try { j = JSON.parse(payload); } catch (_) { continue; }
          if (j.usage) usage = normalizeUsage(j.usage);
          if (j.error) throw new Error(j.error.message || 'engine error');
          const choice = (j.choices && j.choices[0]) || {};
          const delta = choice.delta || {};
          // reasoning channel: llama.cpp deepseek format / ollama
          const rChunk = delta.reasoning_content !== undefined ? delta.reasoning_content
            : (delta.reasoning !== undefined ? delta.reasoning : null);
          if (rChunk) {
            if (firstTokenAt === null) firstTokenAt = Date.now();
            reasoning += rChunk;
            if (opts.onReasoning) opts.onReasoning(rChunk);
          }
          if (typeof delta.content === 'string' && delta.content.length) {
            let text = delta.content;
            // strip <think>…</think> when the engine didn't separate it
            while (text.length) {
              if (inThink) {
                const close = text.indexOf('</think>');
                if (close >= 0) {
                  inThink = false; sawThinkClose = true;
                  const seg = text.slice(0, close);
                  if (seg) {
                    if (firstTokenAt === null) firstTokenAt = Date.now();
                    reasoning += seg; if (opts.onReasoning) opts.onReasoning(seg);
                  }
                  text = text.slice(close + 8);
                }
                else {
                  if (firstTokenAt === null) firstTokenAt = Date.now();
                  reasoning += text; if (opts.onReasoning) opts.onReasoning(text); text = '';
                }
              } else {
                const open = text.indexOf('<think>');
                if (open >= 0) {
                  if (open > 0) {
                    if (firstTokenAt === null) firstTokenAt = Date.now();
                    content += text.slice(0, open); if (opts.onDelta) opts.onDelta(text.slice(0, open));
                  }
                  inThink = true;
                  text = text.slice(open + 7);
                } else {
                  content += text;
                  if (firstTokenAt === null) firstTokenAt = Date.now();
                  if (opts.onDelta) opts.onDelta(text);
                  text = '';
                }
              }
            }
          }
        }
      }
    } catch (e) {
      if (opts.signal && opts.signal.aborted) stopped = true;
      else if (e && (e.name === 'AbortError')) stopped = true;
      else throw e;
    }
    const elapsedMs = Date.now() - started;
    usage = normalizeUsage(usage);
    // Prefer measured completion_tokens. Do not invent counts from character length.
    // When reasoning_tokens is reported separately and completion excludes it,
    // use the larger of completion vs (completion + reasoning) only if both present
    // and completion already includes reasoning (typical llama.cpp): use completion once.
    const genTokens = usage && Number.isFinite(usage.completion_tokens)
      ? usage.completion_tokens
      : null;
    // Prefer generation window (first token → end); fall back to full elapsed.
    // Clamp to at least 1ms so instantaneous mock streams still yield a finite tps.
    const rawGenMs = firstTokenAt ? (Date.now() - firstTokenAt) : elapsedMs;
    const genElapsedMs = Math.max(rawGenMs > 0 ? rawGenMs : elapsedMs, 1);
    return {
      content,
      reasoning: reasoning || null,
      usage,
      firstTokenMs: firstTokenAt ? firstTokenAt - started : null,
      elapsedMs,
      tps: genTokens != null ? genTokens / (genElapsedMs / 1000) : null,
      stopped,
      serverDone,
      thinkingMode: thinking
    };
  }

  /** Non-streaming helper (benchmarks, connection tests). */
  static async complete(opts) {
    const fetchImpl = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    const res = await fetchImpl(`${opts.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: opts.model || 'default', messages: opts.messages || [], stream: false, ...buildSampling(opts.params) }),
      signal: opts.signal
    });
    if (!res.ok) throw new Error(`Request failed: HTTP ${res.status}`);
    return res.json();
  }
}

function buildSampling(p) {
  const out = {};
  if (!p) return out;
  if (p.temperature !== undefined) out.temperature = p.temperature;
  if (p.topP !== undefined) out.top_p = p.topP;
  if (p.topK !== undefined) out.top_k = p.topK;
  if (p.repeatPenalty !== undefined) out.repeat_penalty = p.repeatPenalty;
  if (p.maxTokens !== undefined) out.max_tokens = p.maxTokens;
  return out;
}

/** Coerce usage fields; never invent zeros for missing measurements. */
function normalizeUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
  const prompt = num(u.prompt_tokens);
  const completion = num(u.completion_tokens);
  const reasoning = num(u.reasoning_tokens != null ? u.reasoning_tokens : u.reasoning_completion_tokens);
  const total = num(u.total_tokens);
  const out = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    reasoning_tokens: reasoning,
    total_tokens: total
  };
  // Drop the object entirely if every field is unavailable.
  if (prompt == null && completion == null && reasoning == null && total == null) return null;
  return out;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { StreamClient, normalizeUsage, buildSampling };
}
