import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { streamSimple, type Model, type SimpleStreamOptions } from '@liyuan/ai/compat';
import { modelResponseFailure } from '../src/stage/model-failure.ts';
import { buildBaseOptions } from '@liyuan/ai/api/simple-options';

test('compiled SDK serializes provider-default omission, preserves ordinary budgets/clamp, and retains length failure', async () => {
  const payloads: any[] = [];
  let finishReason = 'stop';
  const server = createServer((req, res) => { void (async () => {
    let body = ''; for await (const chunk of req) body += chunk;
    payloads.push(JSON.parse(body));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ id: 'synthetic', object: 'chat.completion.chunk', model: 'synthetic', choices: [{ index: 0, delta: { role: 'assistant', content: 'Synthetic response' }, finish_reason: finishReason }] })}\n\ndata: [DONE]\n\n`);
  })().catch(() => { res.writeHead(500); res.end(); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const model: Model<'openai-completions'> = { api: 'openai-completions', provider: 'synthetic', id: 'synthetic', name: 'Synthetic', baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`, reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 16384, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const context = { messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Synthetic input' }], timestamp: 0 }] };
  const run = async (options: SimpleStreamOptions, selected = model) => {
    const source = streamSimple(selected, context, { ...options, apiKey: 'synthetic-only', maxRetries: 0 });
    for await (const _event of source) { /* consume the real local transport */ }
    return source.result();
  };
  try {
    await run({ useProviderDefaultMaxTokens: true });
    await run({ maxTokens: 512 });
    await run({});
    await run({ useProviderDefaultMaxTokens: false });
    await run({ maxTokens: 512 }, { ...model, contextWindow: 4200 });
    assert.equal(Object.hasOwn(payloads[0], 'max_tokens'), false);
    assert.equal(Object.hasOwn(payloads[0], 'max_completion_tokens'), false);
    assert.deepEqual(payloads.slice(1, 4).map(p => p.max_tokens), [512, 16384, 16384]);
    assert.equal(payloads[4].max_tokens, 100);
    const conflict = await run({ maxTokens: 512, useProviderDefaultMaxTokens: true });
    assert.equal(conflict.stopReason, 'error');
    const unsupported = await run({ useProviderDefaultMaxTokens: true }, { ...model, api: 'openai-responses' } as never);
    assert.equal(unsupported.stopReason, 'error');
    assert.equal(payloads.length, 5, 'unsupported or conflicting semantics never reach the endpoint');
    for (const api of ['openai-responses', 'azure-openai-responses', 'openai-codex-responses', 'google-generative-ai', 'google-vertex', 'anthropic-messages', 'bedrock-converse-stream', 'mistral-conversations']) {
      assert.throws(() => buildBaseOptions({ ...model, api }, context, { useProviderDefaultMaxTokens: true }), /requires openai-completions/);
    }
    finishReason = 'length';
    const truncated = await run({ useProviderDefaultMaxTokens: true });
    assert.equal(truncated.stopReason, 'length');
    assert.ok(modelResponseFailure(truncated, true));
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
