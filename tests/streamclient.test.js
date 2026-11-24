'use strict';
/**
 * StreamClient tests — runs the renderer's streaming client in Node against
 * a local HTTP server emitting real SSE format, covering: delta accumulation,
 * reasoning channel (both field names), <think> tag stripping, usage capture,
 * abort mid-stream, and non-2xx error handling.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { StreamClient } = require('../renderer/js/streamclient');

function sseServer(handler) {
  return new Promise(resolve => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

function chunk(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

describe('StreamClient (SSE parsing)', () => {
  test('accumulates content, reasoning, usage and computes tps', async () => {
    const { srv, port } = await sseServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      chunk(res, { choices: [{ delta: { reasoning_content: 'pondering… ' } }] });
      chunk(res, { choices: [{ delta: { content: 'Hello' } }] });
      chunk(res, { choices: [{ delta: { content: ' world' } }] });
      chunk(res, { choices: [{ delta: { reasoning: 'more thoughts' } }] });
      chunk(res, { choices: [{ delta: { content: '!' } }] });
      chunk(res, { choices: [], usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 } });
      res.write('data: [DONE]\n\n');
      res.end();
    });
    const deltas = [];
    const result = await StreamClient.chat({
      baseUrl: `http://127.0.0.1:${port}`,
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      onDelta: d => deltas.push(d)
    });
    assert.equal(result.content, 'Hello world!');
    assert.equal(result.reasoning, 'pondering… more thoughts');
    assert.equal(result.usage.completion_tokens, 4);
    assert.ok(result.tps > 0);
    assert.equal(result.serverDone, true);
    assert.deepEqual(deltas.join(''), result.content);
    srv.close();
    await new Promise(r => srv.on('close', r));
  });

  test('strips raw <think> tags into the reasoning channel', async () => {
    const { srv, port } = await sseServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      chunk(res, { choices: [{ delta: { content: '<think>private chain</think>Answer' } }] });
      res.write('data: [DONE]\n\n');
      res.end();
    });
    const result = await StreamClient.chat({ baseUrl: `http://127.0.0.1:${port}`, messages: [] });
    assert.equal(result.content, 'Answer');
    assert.equal(result.reasoning, 'private chain');
    srv.close();
    await new Promise(r => srv.on('close', r));
  });

  test('abort mid-stream returns stopped with partial content', async () => {
    const { srv, port } = await sseServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      chunk(res, { choices: [{ delta: { content: 'partial' } }] });
      // never ends — client must abort
    });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 150);
    const result = await StreamClient.chat({
      baseUrl: `http://127.0.0.1:${port}`, messages: [], signal: ac.signal
    });
    assert.equal(result.stopped, true);
    assert.equal(result.content, 'partial');
    srv.close();
    await new Promise(r => srv.on('close', r));
  });

  test('HTTP errors surface a readable message', async () => {
    const { srv, port } = await sseServer((req, res) => {
      res.writeHead(503);
      res.end('{"error":{"message":"model is loading"}}');
    });
    await assert.rejects(
      () => StreamClient.chat({ baseUrl: `http://127.0.0.1:${port}`, messages: [] }),
      /503.*model is loading/s
    );
    srv.close();
    await new Promise(r => srv.on('close', r));
  });

  test('complete() returns the full non-streaming body', async () => {
    const { srv, port } = await sseServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'pong' } }], usage: {} }));
    });
    const j = await StreamClient.complete({ baseUrl: `http://127.0.0.1:${port}`, messages: [] });
    assert.equal(j.choices[0].message.content, 'pong');
    srv.close();
    await new Promise(r => srv.on('close', r));
  });
});
