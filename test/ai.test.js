// "Model returns broken JSON" is a listed risk (PLAN.md 11) and CLAUDE.md
// requires a text-only fallback, so the parser is tested against the shapes
// models actually produce.

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseReply, extractJson, sanitizeStep } = require('../src/ai');

const GOOD = JSON.stringify({
  speech: 'Your playlists are in the left sidebar.',
  steps: [
    {
      action: 'move_pointer',
      target: { box_2d: [120, 10, 160, 90] },
      bubble: 'Click here to open your library',
      shape: 'circle',
      duration_ms: 3000,
    },
  ],
  auto_clear_after_ms: 2000,
});

test('parses a well-formed reply', () => {
  const result = parseReply(GOOD);
  assert.equal(result.speech, 'Your playlists are in the left sidebar.');
  assert.equal(result.steps.length, 1);
  assert.deepEqual(result.steps[0].box, [120, 10, 160, 90]);
  assert.equal(result.steps[0].shape, 'circle');
  assert.equal(result.auto_clear_after_ms, 2000);
  assert.equal(result.degraded, undefined);
});

test('strips markdown code fences', () => {
  const result = parseReply('```json\n' + GOOD + '\n```');
  assert.equal(result.steps.length, 1);
  assert.equal(result.degraded, undefined);
});

test('ignores prose wrapped around the JSON', () => {
  const result = parseReply(`Sure! Here you go:\n${GOOD}\nHope that helps.`);
  assert.equal(result.speech, 'Your playlists are in the left sidebar.');
});

test('falls back to a text-only answer for prose', () => {
  const result = parseReply('The playlists are on the left, under Library.');
  assert.equal(result.degraded, 'unparsable');
  assert.deepEqual(result.steps, []);
  assert.match(result.speech, /playlists are on the left/);
});

test('recovers the partial answer from truncated JSON rather than throwing', () => {
  // This used to degrade. It now repairs: a clipped sentence is still the
  // model's own words, and far better than discarding the reply.
  const result = parseReply('{"speech": "half an ans');
  assert.equal(result.speech, 'half an ans');
  assert.equal(result.steps.length, 0);
});

test('handles an empty reply', () => {
  const result = parseReply('');
  assert.equal(result.steps.length, 0);
  assert.match(result.speech, /did not return an answer/);
});

test('drops steps with an unusable box but keeps the rest', () => {
  const result = parseReply(JSON.stringify({
    speech: 'Here.',
    steps: [
      { action: 'circle', target: { box_2d: [0, 0, 100, 100] } },
      { action: 'circle', target: {} },
      { action: 'circle' },
      { action: 'circle', target: { box_2d: 'nonsense' } },
    ],
  }));
  assert.equal(result.steps.length, 1);
});

test('coerces an unknown action to move_pointer', () => {
  const step = sanitizeStep({ action: 'explode', target: { box_2d: [0, 0, 10, 10] } });
  assert.equal(step.action, 'move_pointer');
});

test('clamps a runaway duration', () => {
  const slow = sanitizeStep({ action: 'circle', target: { box_2d: [0, 0, 10, 10] }, duration_ms: 999999 });
  const fast = sanitizeStep({ action: 'circle', target: { box_2d: [0, 0, 10, 10] }, duration_ms: 1 });
  assert.equal(slow.duration_ms, 15000);
  assert.equal(fast.duration_ms, 400);
});

test('defaults a missing duration', () => {
  const step = sanitizeStep({ action: 'circle', target: { box_2d: [0, 0, 10, 10] } });
  assert.equal(step.duration_ms, 2500);
});

test('caps the number of steps', () => {
  const many = Array.from({ length: 30 }, () => ({
    action: 'circle', target: { box_2d: [0, 0, 10, 10] },
  }));
  const result = parseReply(JSON.stringify({ speech: 'ok', steps: many }));
  assert.equal(result.steps.length, 8);
});

test('supplies a speech line when the model omits one', () => {
  const result = parseReply(JSON.stringify({ steps: [] }));
  assert.ok(result.speech.length > 0);
});

test('a clear step needs no box', () => {
  assert.deepEqual(sanitizeStep({ action: 'clear' }), { action: 'clear' });
});

test('rejects a JSON array at the top level', () => {
  assert.equal(parseReply('[1,2,3]').degraded, 'unparsable');
});

test('extractJson finds the outermost object', () => {
  assert.equal(extractJson('noise {"a":{"b":1}} more'), '{"a":{"b":1}}');
  // A brace inside a string must not end the object early.
  assert.equal(extractJson('{"a":"}"}'), '{"a":"}"}');
  assert.equal(extractJson('no json here'), null);
});

// ---- replies cut off by the model's token cap ----

test('a reply truncated mid-bubble keeps the steps that did arrive', () => {
  // Exactly the shape Gemini produced when maxOutputTokens was too low.
  const result = parseReply(
    '{"speech": "I see a desktop.", "steps": [' +
    '{"action":"box","target":{"box_2d":[153,374,733,627]},"bubble":"The window","duration_ms":3000},' +
    '{"action":"box","target":{"box_2d":[196,710,830,913]},"bubble":"At',
  );
  assert.equal(result.speech, 'I see a desktop.');
  assert.equal(result.steps.length, 2, 'both complete steps survive the repair');
  assert.equal(result.degraded, undefined);
});

test('a reply cut off after a comma still parses', () => {
  const result = parseReply(
    '{"speech": "Here.", "steps": [' +
    '{"action":"circle","target":{"box_2d":[10,10,90,90]},"duration_ms":2000}, ',
  );
  assert.equal(result.speech, 'Here.');
  assert.equal(result.steps.length, 1);
});

test('a reply cut off on a half-written key still parses', () => {
  const result = parseReply('{"speech": "Hello there.", "steps": [], "auto_clear');
  assert.equal(result.speech, 'Hello there.');
  assert.deepEqual(result.steps, []);
});

test('Friday never reads raw JSON out loud', () => {
  // Unrepairable machine output must not become the spoken answer.
  const result = parseReply('{"speech": "hi", "steps": [{"action": }}}]');
  assert.doesNotMatch(result.speech, /[{}[\]]/, 'no braces in anything spoken');
  assert.doesNotMatch(result.speech, /"speech"/, 'no field names in anything spoken');
  assert.equal(result.degraded, 'unparsable');
});

test('a genuine plain-text answer is still spoken as written', () => {
  const result = parseReply('The save button is in the top right corner.');
  assert.equal(result.speech, 'The save button is in the top right corner.');
  assert.equal(result.degraded, 'unparsable');
});
