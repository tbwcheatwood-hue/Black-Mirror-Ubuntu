'use strict';
/**
 * Mock inference engine: a tiny Node HTTP server that emulates the
 * OpenAI-compatible surface of llama-server (health, models, chat with SSE
 * streaming) and prints llama.cpp-style timing log lines. Used by tests and
 * by the renderer preview bridge.
 *
 * Usage: node mockengine.js --port 8123 [--bind 127.0.0.1] [--speed 40]
 */
const http = require('http');
const url = require('url');

const args = process.argv.slice(2);
const getArg = (k, d) => {
  const i = args.indexOf('--' + k);
  return i >= 0 ? args[i + 1] : d;
};
const port = parseInt(getArg('port', '8123'), 10);
const bind = getArg('bind', '127.0.0.1');
const speed = parseFloat(getArg('speed', '45')); // tokens per second
const fail = getArg('fail', null); // 'health' → always 503

function llamaLogLine(kind, ms, tokens) {
  const tps = (tokens / (ms / 1000)).toFixed(2);
  if (kind === 'prompt') {
    console.log(`prompt eval time     =   ${ms.toFixed(2)} ms /   ${tokens} tokens (    ${tps} tokens per second)`);
  } else {
    console.log(`eval time            =  ${ms.toFixed(2)} ms /   ${tokens} tokens (    ${tps} tokens per second)`);
  }
}

console.log('build: 1234 (abcdef)');
console.log('system info: n_threads = 6');

const server = http.createServer((req, res) => {
  const u = url.parse(req.url, true);
  if (u.pathname === '/health') {
    if (fail === 'health') { res.writeHead(503); res.end('{"status":"loading model"}'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"status":"ok"}');
    return;
  }
  if (u.pathname === '/' && !fail) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"status":"ok","message":"Ollama is running"}');
    return;
  }
  if (u.pathname === '/v1/models' || u.pathname === '/api/tags') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      object: 'list',
      data: [{ id: 'mock-model', object: 'model' }],
      models: [{ name: 'mock-model', details: { quantization_level: 'Q4_K_M', family: 'llama', parameter_size: '7B' }, size: 4026531840 }]
    }));
    return;
  }
  if (u.pathname === '/v1/chat/completions' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let j = {};
      try { j = JSON.parse(body); } catch (_) { /* ignore */ }
      const stream = !!j.stream;
      const promptTokens = 42;
      const genTokens = Math.max(4, Math.min(64, (j.max_tokens | 0) || 24));
      const reply = 'Hello from the other side of the mirror. ';
      const words = (reply.repeat(Math.ceil(genTokens / 8))).split(' ').slice(0, genTokens);
      const started = Date.now();

      if (stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        const id = 'chatcmpl-mock';
        const writeChunk = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
        const thinking = !!j.think;
        if (thinking) {
          writeChunk({ id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { reasoning: 'The user greets the mirror. I should answer warmly. ' } }] });
        }
        let i = 0;
        let timer = null;
        // NOTE: listen on the RESPONSE close (client abort / connection end),
        // not req 'close' — in Node ≥18 the request-side 'close' fires as
        // soon as the request body is consumed, which would kill the timer.
        res.on('close', () => { if (timer) clearInterval(timer); });
        timer = setInterval(() => {
          if (i < words.length) {
            writeChunk({ id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: (i ? ' ' : '') + words[i] } }] });
            i++;
          } else {
            clearInterval(timer);
            const elapsed = (Date.now() - started) / 1000;
            writeChunk({
              id, object: 'chat.completion.chunk', choices: [],
              usage: { prompt_tokens: promptTokens, completion_tokens: words.length, total_tokens: promptTokens + words.length }
            });
            res.write('data: [DONE]\n\n');
            res.end();
            llamaLogLine('prompt', 60 + Math.random() * 30, promptTokens);
            llamaLogLine('eval', elapsed * 1000, words.length);
          }
        }, Math.max(8, 1000 / speed));
      } else {
        const elapsed = Math.max(0.2, words.length / speed);
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id: 'chatcmpl-mock', object: 'chat.completion',
            choices: [{ index: 0, message: { role: 'assistant', content: words.join(' ') }, finish_reason: 'stop' }],
            usage: { prompt_tokens: promptTokens, completion_tokens: words.length, total_tokens: promptTokens + words.length },
            timings: { prompt_n: promptTokens, prompt_ms: 70, predicted_n: words.length, predicted_ms: elapsed * 1000 }
          }));
          llamaLogLine('prompt', 70, promptTokens);
          llamaLogLine('eval', elapsed * 1000, words.length);
        }, Math.max(10, elapsed * 1000 / 10));
      }
    });
    return;
  }
  res.writeHead(404);
  res.end('{"error":"not found"}');
});

server.listen(port, bind === '0.0.0.0' ? undefined : bind, () => {
  console.log(`server is listening on http://${bind}:${port} - starting the main loop`);
});
