const test = require('node:test');
const assert = require('node:assert');

const { AI } = require('../src/ai');
const { getProvider, resolveProvider, publicProviders, PROVIDERS } = require('../src/providers');

// ---- the registry ----

test('every provider declares what the setup UI needs to draw it', () => {
  for (const provider of PROVIDERS) {
    assert.ok(provider.id, 'needs an id');
    assert.ok(provider.name, `${provider.id} needs a name`);
    assert.ok(provider.blurb, `${provider.id} needs a blurb`);
    assert.ok(provider.defaultModel, `${provider.id} needs a default model`);
    assert.equal(typeof provider.supportsSTT, 'boolean', `${provider.id} must state STT support`);
    if (provider.needsKey) assert.ok(provider.keyUrl, `${provider.id} should say where to get a key`);
  }
});

test('unknown provider ids fall back to gemini rather than throwing', () => {
  assert.equal(getProvider('nope'), null);
  assert.equal(resolveProvider('nope').id, 'gemini');
  assert.equal(resolveProvider(undefined).id, 'gemini');
});

test('publicProviders leaks nothing secret to the renderer', () => {
  for (const provider of publicProviders()) {
    // No field may carry a credential itself. keyUrl/keyLabel/keyPrefix only
    // describe where to get one and what it looks like.
    const carriers = Object.keys(provider).filter((field) =>
      /^(apiKey|key|secret|token|password)$/i.test(field));
    assert.deepEqual(carriers, [], `${provider.id} exposes ${carriers.join(', ')}`);

    // And no value may look like a live key.
    for (const value of Object.values(provider)) {
      if (typeof value !== 'string') continue;
      assert.ok(!/^(sk-|AIza)\S{12,}/.test(value), `${provider.id} has a key-shaped value`);
    }

    assert.equal(typeof provider.needsKey, 'boolean');
    assert.ok(Array.isArray(provider.suggestedModels));
  }
});

// ---- configuring the AI ----

test('a provider needing no key is configured without one', () => {
  assert.equal(new AI({ provider: 'ollama' }).configured, true);
});

test('a provider needing a key is not configured until it has one', () => {
  assert.equal(new AI({ provider: 'claude' }).configured, false);
  assert.equal(new AI({ provider: 'claude', apiKey: 'sk-ant-test' }).configured, true);
});

test('supportsSTT follows the provider, not the key alone', () => {
  assert.equal(new AI({ provider: 'gemini', apiKey: 'k' }).supportsSTT, true);
  assert.equal(new AI({ provider: 'openai', apiKey: 'k' }).supportsSTT, true);
  // Anthropic takes images but not audio.
  assert.equal(new AI({ provider: 'claude', apiKey: 'k' }).supportsSTT, false);
  assert.equal(new AI({ provider: 'ollama' }).supportsSTT, false);
  // A key-less provider cannot transcribe even if the API could.
  assert.equal(new AI({ provider: 'gemini' }).supportsSTT, false);
});

test('each provider defaults to its own model', () => {
  assert.equal(new AI({ provider: 'claude', apiKey: 'k' }).model, 'claude-opus-5');
  assert.equal(new AI({ provider: 'gemini', apiKey: 'k' }).model, 'gemini-flash-latest');
  assert.equal(new AI({ provider: 'openai', apiKey: 'k' }).model, 'gpt-4o');
});

test('an explicit model survives configure', () => {
  const ai = new AI({ provider: 'claude', apiKey: 'k', model: 'claude-haiku-4-5' });
  assert.equal(ai.model, 'claude-haiku-4-5');
});

test('switching provider drops the cached SDK client', () => {
  const ai = new AI({ provider: 'gemini', apiKey: 'one' });
  ai.client = { sentinel: true };

  ai.configure({ provider: 'claude', apiKey: 'two' });
  assert.equal(ai.client, null, 'a stale client would talk to the wrong service');
  assert.equal(ai.provider, 'claude');
});

test('reconfiguring with identical settings keeps the client', () => {
  const ai = new AI({ provider: 'gemini', apiKey: 'one' });
  const client = { sentinel: true };
  ai.client = client;

  ai.configure({ provider: 'gemini', apiKey: 'one' });
  assert.equal(ai.client, client, 'needless reconnects cost a round trip');
});

test('changing only the key still drops the client', () => {
  const ai = new AI({ provider: 'gemini', apiKey: 'one' });
  ai.client = { sentinel: true };

  ai.configure({ provider: 'gemini', apiKey: 'two' });
  assert.equal(ai.client, null);
});

test('describeModel names the ollama model it is actually running', () => {
  const ai = new AI({ provider: 'ollama', model: 'llava' });
  assert.equal(ai.describeModel, 'ollama/llava');
  assert.equal(new AI({ provider: 'claude', apiKey: 'k' }).describeModel, 'claude-opus-5');
});

test('an unconfigured provider degrades instead of throwing', async () => {
  const reply = await new AI({ provider: 'claude' }).ask({ question: 'hi', image: null, history: [] });
  assert.equal(reply.degraded, 'no-key');
  assert.deepEqual(reply.steps, []);
  assert.match(reply.speech, /key/i);
});

test('an unknown provider degrades instead of throwing', async () => {
  const ai = new AI({ provider: 'gemini', apiKey: 'k' });
  ai.provider = 'wat';
  const reply = await ai.ask({ question: 'hi', image: null, history: [] });
  assert.equal(reply.degraded, 'no-key');
  assert.match(reply.speech, /wat/);
});

test('transcribe refuses clearly on a provider that cannot hear', async () => {
  const ai = new AI({ provider: 'claude', apiKey: 'k' });
  await assert.rejects(
    () => ai.transcribe({ data: '', mimeType: 'audio/webm' }),
    /cannot transcribe/i,
  );
});

// ---- falling back between models ----

const { shouldTryNextModel, withTimeout } = require('../src/ai');

test('a retired model name moves to the next model', () => {
  assert.equal(shouldTryNextModel(new Error('404 models/gemini-x is not found')), true);
  assert.equal(shouldTryNextModel(new Error('model does not exist')), true);
});

test('an overloaded model moves to the next model', () => {
  // The exact 503 Gemini returns. Before this, the fallback chain was dead
  // code for the one case it was most needed in.
  const busy = new Error(
    '{"error":{"code":503,"message":"This model is currently experiencing high demand. ' +
    'Spikes in demand are usually temporary. Please try again later.","status":"UNAVAILABLE"}}',
  );
  assert.equal(shouldTryNextModel(busy), true);
});

test('a bad key does not burn through every model', () => {
  assert.equal(shouldTryNextModel(new Error('401 Invalid API key')), false);
  assert.equal(shouldTryNextModel(new Error('429 quota exceeded')), false);
});

test('withTimeout resolves untouched when the call is quick', async () => {
  assert.equal(await withTimeout(Promise.resolve('answer'), 1000, 'Test'), 'answer');
});

test('withTimeout gives up rather than hanging the panel forever', async () => {
  const never = new Promise(() => {});
  await assert.rejects(() => withTimeout(never, 20, 'Gemini'), /Gemini did not answer within/);
});

test('withTimeout passes a real rejection through unchanged', async () => {
  await assert.rejects(
    () => withTimeout(Promise.reject(new Error('real failure')), 1000, 'Test'),
    /real failure/,
  );
});

// ---- the model list ----

const { rankModels } = require('../src/ai');

const geminiSpec = { suggestedModels: ['gemini-flash-latest', 'gemini-2.5-flash'] };

test('recommended models sort to the top of the dropdown', () => {
  const ranked = rankModels(
    ['gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-flash-latest'],
    geminiSpec,
  );
  assert.deepEqual(ranked.slice(0, 2), ['gemini-flash-latest', 'gemini-2.5-flash']);
});

test('models Friday cannot use are filtered out', () => {
  const ranked = rankModels(
    ['gpt-4o', 'text-embedding-3-large', 'whisper-1', 'dall-e-3', 'tts-1', 'omni-moderation-latest'],
    { suggestedModels: ['gpt-4o'] },
  );
  assert.deepEqual(ranked, ['gpt-4o'], 'embeddings, audio and image models cannot answer');
});

test('unrecommended models still appear, alphabetically', () => {
  const ranked = rankModels(['zeta-vision', 'alpha-vision'], { suggestedModels: [] });
  assert.deepEqual(ranked, ['alpha-vision', 'zeta-vision']);
});

test('duplicates collapse', () => {
  assert.deepEqual(rankModels(['a', 'a', 'b'], { suggestedModels: [] }), ['a', 'b']);
});

test('an empty list stays empty rather than throwing', () => {
  assert.deepEqual(rankModels([], geminiSpec), []);
});
