const test = require('node:test');
const assert = require('node:assert');

const { describe, classify } = require('../src/errors');

const openai = { name: 'OpenAI', model: 'gpt-4o', provider: 'openai' };

test('describe survives every shape of thrown thing', () => {
  assert.equal(describe(null), 'unknown error');
  assert.equal(describe(new Error('boom')), 'boom');
  assert.equal(describe('plain string'), 'plain string');
  // desktopCapturer throws with an empty message when a permission is denied.
  assert.equal(describe(new Error('')), 'the system refused the request');
});

test('an exhausted account is billing advice, not "wait a minute"', () => {
  // OpenAI returns insufficient_quota as a 429, which is why this must be
  // checked before the rate-limit branch.
  const message = classify(
    '429 You exceeded your current quota, please check your plan and billing details.',
    openai,
  );
  assert.match(message, /no credits/i);
  assert.doesNotMatch(message, /wait a minute/i, 'waiting never clears a billing problem');
});

test('Anthropic low-balance wording is also billing', () => {
  const message = classify('Your credit balance is too low to access the API', { name: 'Claude' });
  assert.match(message, /no credits/i);
});

test('a real rate limit still says to wait', () => {
  const message = classify('429 Rate limit reached for gpt-4o', openai);
  assert.match(message, /wait a minute/i);
  assert.doesNotMatch(message, /no credits/i);
});

test('a bad key is reported as a bad key', () => {
  const message = classify('401 Incorrect API key provided: sk-abc***', openai);
  assert.match(message, /rejected the API key/i);
});

test('a missing model names the model that was tried', () => {
  const message = classify('404 The model `gpt-4o` does not exist', openai);
  assert.match(message, /gpt-4o/);
  assert.match(message, /different model/i);
});

test('a dead ollama points at the address it tried', () => {
  const message = classify('connect ECONNREFUSED 127.0.0.1:11434', {
    name: 'Ollama', provider: 'ollama', host: 'http://127.0.0.1:11434',
  });
  assert.match(message, /127\.0\.0\.1:11434/);
  assert.match(message, /running/i);
});

test('a network failure on a hosted provider is not blamed on ollama', () => {
  const message = classify('fetch failed', openai);
  assert.match(message, /internet connection/i);
});

test('an unrecognised error is passed through rather than swallowed', () => {
  const message = classify('something nobody predicted', openai);
  assert.match(message, /something nobody predicted/);
});
