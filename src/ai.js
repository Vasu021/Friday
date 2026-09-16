// Talking to the model: prompt assembly, the per-provider calls, and the
// defensive parsing of whatever comes back.
//
// Providers are declared in providers.js; each one gets a `call<Name>` method
// here. Everything funnels through parseReply so the rest of the app never has
// to care which backend answered.
//
// CLAUDE.md requires that a malformed reply degrades to a text-only answer
// rather than throwing, so every failure path here ends in a usable object.

const fs = require('node:fs');
const path = require('node:path');
const coords = require('./coords');
const { resolveProvider } = require('./providers');

const VALID_ACTIONS = new Set([
  'move_pointer', 'circle', 'box', 'arrow', 'underline', 'text_label', 'clear',
]);

// Tried in order when the configured model is rejected, so a renamed or retired
// free-tier model degrades to "slower" rather than "broken".
const MODEL_FALLBACKS = ['gemini-flash-latest', 'gemini-2.5-flash', 'gemini-2.0-flash'];

const MAX_STEPS = 8;
const MAX_HISTORY = 6;

// A provider that never answers must not leave the panel saying "Thinking…"
// forever. Generous enough for a slow vision model on a big screenshot.
const REQUEST_TIMEOUT_MS = 45000;

// Listing models is a fast metadata call; it should not stall the picker.
const LIST_TIMEOUT_MS = 12000;

// Friday needs a model that reads images and writes text. These do neither.
const NOT_A_VISION_CHAT_MODEL =
  /embed|tts|whisper|dall-?e|moderation|realtime|transcribe|audio|imagen|veo|rerank|aqa|guard|sora/i;

class AI {
  constructor(options = {}) {
    this.systemPrompt = fs.readFileSync(path.join(__dirname, 'prompts', 'system.txt'), 'utf8');
    this.client = null;
    this.configure(options);
  }

  /**
   * Point Friday at a (possibly different) provider. Called at startup and
   * again every time the user changes the provider in the setup UI, so the
   * cached SDK client has to be dropped whenever anything about the
   * connection changes.
   */
  configure({ apiKey, model, provider, ollamaHost, ollamaModel } = {}) {
    const previous = `${this.provider}|${this.apiKey}|${this.ollamaHost}`;

    this.provider = provider || 'gemini';
    this.spec = resolveProvider(this.provider);
    this.apiKey = apiKey || null;
    this.ollamaHost = ollamaHost || this.spec.defaultHost || 'http://127.0.0.1:11434';

    // For Ollama these are the same thing. Keeping them in sync matters:
    // callOllama reads ollamaModel, so letting them drift would mean the
    // model picked in the UI is not the one that actually answers.
    if (this.provider === 'ollama') {
      this.model = model || ollamaModel || this.spec.defaultModel;
      this.ollamaModel = this.model;
    } else {
      this.model = model || this.spec.defaultModel;
      this.ollamaModel = ollamaModel || 'qwen2.5vl';
    }

    if (`${this.provider}|${this.apiKey}|${this.ollamaHost}` !== previous) this.client = null;
    return this;
  }

  get configured() {
    return !this.spec.needsKey || Boolean(this.apiKey);
  }

  /** Whether this provider can turn recorded audio into text by itself. */
  get supportsSTT() {
    return Boolean(this.spec.supportsSTT) && this.configured;
  }

  /** Human-readable name of what is actually answering, for the status panel. */
  get describeModel() {
    return this.provider === 'ollama' ? `ollama/${this.ollamaModel}` : this.model;
  }

  gemini() {
    if (!this.client) {
      const { GoogleGenAI } = require('@google/genai');
      this.client = new GoogleGenAI({ apiKey: this.apiKey });
    }
    return this.client;
  }

  claude() {
    if (!this.client) {
      const Anthropic = require('@anthropic-ai/sdk');
      this.client = new Anthropic({ apiKey: this.apiKey });
    }
    return this.client;
  }

  openai() {
    if (!this.client) {
      const OpenAI = require('openai');
      this.client = new OpenAI({ apiKey: this.apiKey });
    }
    return this.client;
  }

  /**
   * Ask about the screen.
   * @param {object} opts
   * @param {string} opts.question
   * @param {{data: string, mimeType: string}|null} opts.image  omitted in Chat Only mode
   * @param {Array<{role: string, text: string}>} opts.history
   * @param {string} opts.mode  guide | explain | chat
   * @returns {Promise<{speech: string, steps: Array, auto_clear_after_ms: number, raw?: string, degraded?: string}>}
   */
  async ask({ question, image, history = [], mode = 'guide' }) {
    if (!this.configured) {
      return degraded(`Friday needs a ${this.spec.keyLabel || 'API key'}. Open Settings to add one.`);
    }

    const call = {
      gemini: () => this.callGemini({ question, image, history, mode }),
      ollama: () => this.callOllama({ question, image, history, mode }),
      claude: () => this.callClaude({ question, image, history, mode }),
      openai: () => this.callOpenAI({ question, image, history, mode }),
    }[this.provider];

    if (!call) return degraded(`Friday does not know how to talk to "${this.provider}".`);

    return parseReply(await withTimeout(call(), REQUEST_TIMEOUT_MS, this.spec.name));
  }

  /**
   * The models this key can actually use, newest-useful first.
   *
   * Asking the provider beats a hard-coded list: model names are retired and
   * added constantly, and which ones a given account can reach varies.
   * @returns {Promise<string[]>}
   */
  async listModels() {
    const lister = {
      gemini: () => this.listGeminiModels(),
      claude: () => this.listClaudeModels(),
      openai: () => this.listOpenAIModels(),
      ollama: () => this.listOllamaModels(),
    }[this.provider];

    if (!lister || !this.configured) return [];
    return rankModels(await withTimeout(lister(), LIST_TIMEOUT_MS, this.spec.name), this.spec);
  }

  async listGeminiModels() {
    const found = [];
    const pager = await this.gemini().models.list();
    for await (const model of pager) {
      // Drop anything that cannot answer a generateContent call at all.
      const actions = model.supportedActions || model.supportedGenerationMethods || [];
      if (actions.length && !actions.includes('generateContent')) continue;
      found.push(String(model.name || '').replace(/^models\//, ''));
    }
    return found;
  }

  async listClaudeModels() {
    const page = await this.claude().models.list({ limit: 100 });
    return (page.data || []).map((model) => model.id);
  }

  async listOpenAIModels() {
    const page = await this.openai().models.list();
    return (page.data || []).map((model) => model.id);
  }

  async listOllamaModels() {
    const response = await fetch(`${this.ollamaHost}/api/tags`);
    if (!response.ok) throw new Error(`Ollama returned ${response.status}`);
    const json = await response.json();
    return (json.models || []).map((model) => model.name);
  }

  async callGemini({ question, image, history, mode }) {
    const parts = [];
    if (image) parts.push({ inlineData: { mimeType: image.mimeType, data: image.data } });
    parts.push({ text: buildUserPrompt(question, mode, Boolean(image)) });

    const contents = [...historyToContents(history), { role: 'user', parts }];

    const models = [this.model, ...MODEL_FALLBACKS.filter((m) => m !== this.model)];
    let lastError;

    for (const model of models) {
      try {
        const response = await this.gemini().models.generateContent({
          model,
          contents,
          config: {
            systemInstruction: this.systemPrompt,
            responseMimeType: 'application/json',
            temperature: 0.2,
            // Explain-mode tours run long; 1024 truncated them mid-JSON.
            maxOutputTokens: 4096,
          },
        });
        // Remember what actually worked so later calls skip the dead names.
        this.model = model;
        return response.text || '';
      } catch (error) {
        lastError = error;
        if (!shouldTryNextModel(error)) throw error;
      }
    }
    throw lastError;
  }

  async callOllama({ question, image, history, mode }) {
    const body = {
      model: this.ollamaModel,
      stream: false,
      format: 'json',
      system: this.systemPrompt,
      prompt: buildUserPrompt(question, mode, Boolean(image)),
      ...(image ? { images: [image.data] } : {}),
    };
    if (history.length) {
      body.prompt = `${historyToText(history)}\n\n${body.prompt}`;
    }

    const response = await fetch(`${this.ollamaHost}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Ollama returned ${response.status}`);
    const json = await response.json();
    return json.response || '';
  }

  /**
   * Anthropic. Uses structured outputs so the reply is schema-valid JSON
   * rather than something parseReply has to rescue -- but parseReply still
   * runs, because CLAUDE.md wants the defensive path regardless.
   *
   * Thinking is left on (adaptive) at low effort: disabling it on Opus 5 can
   * leak reasoning into the visible answer, and low effort keeps the round
   * trip fast enough for a pointer that is meant to feel live.
   */
  async callClaude({ question, image, history, mode }) {
    const content = [];
    if (image) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: image.mimeType, data: image.data },
      });
    }
    content.push({ type: 'text', text: buildUserPrompt(question, mode, Boolean(image)) });

    const response = await this.claude().messages.parse({
      model: this.model,
      max_tokens: 8192,
      system: this.systemPrompt,
      messages: [...historyToMessages(history), { role: 'user', content }],
      output_config: {
        effort: 'low',
        format: zodOutputFormat(replySchema()),
      },
    });

    if (response.parsed_output) return JSON.stringify(response.parsed_output);

    // Schema validation failed; hand the raw text to the defensive parser.
    return response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
  }

  /** OpenAI, in JSON mode. The system prompt already says "JSON", which that mode requires. */
  async callOpenAI({ question, image, history, mode }) {
    const content = [];
    if (image) {
      content.push({
        type: 'image_url',
        image_url: { url: `data:${image.mimeType};base64,${image.data}` },
      });
    }
    content.push({ type: 'text', text: buildUserPrompt(question, mode, Boolean(image)) });

    const response = await this.openai().chat.completions.create({
      model: this.model,
      max_tokens: 4096,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: this.systemPrompt },
        ...historyToMessages(history),
        { role: 'user', content },
      ],
    });

    return (response.choices[0] && response.choices[0].message.content) || '';
  }

  /**
   * Speech to text, when the provider can do it without extra installs.
   * voice.js prefers a local whisper.cpp binary when one is configured, and
   * falls back to here otherwise.
   */
  async transcribe({ data, mimeType }) {
    if (!this.supportsSTT) {
      throw new Error(`${this.spec.name} cannot transcribe audio. Set up whisper.cpp to use voice.`);
    }
    if (this.provider === 'openai') return this.transcribeWithOpenAI({ data, mimeType });
    return this.transcribeWithGemini({ data, mimeType });
  }

  async transcribeWithOpenAI({ data, mimeType }) {
    const OpenAI = require('openai');
    const extension = (mimeType.split('/')[1] || 'webm').split(';')[0];
    const file = await OpenAI.toFile(Buffer.from(data, 'base64'), `speech.${extension}`);

    const response = await this.openai().audio.transcriptions.create({
      file,
      model: 'whisper-1',
    });
    return (response.text || '').trim();
  }

  async transcribeWithGemini({ data, mimeType }) {
    const response = await this.gemini().models.generateContent({
      model: this.model,
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType, data } },
            {
              text:
                'Transcribe this audio exactly. Reply with the transcript text only, ' +
                'no punctuation cleanup beyond what is spoken, no commentary. ' +
                'If there is no discernible speech, reply with an empty string.',
            },
          ],
        },
      ],
      config: { temperature: 0, maxOutputTokens: 256 },
    });
    return (response.text || '').trim();
  }
}

/**
 * Reject if `promise` has not settled in time. The underlying request is not
 * cancelled -- the SDKs give us no handle for that -- but the caller stops
 * waiting, which is what the user actually cares about.
 */
function withTimeout(promise, ms, label) {
  let timer = null;
  const expiry = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} did not answer within ${Math.round(ms / 1000)} seconds.`)),
      ms,
    );
  });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}

/**
 * Drop the models Friday cannot use, then put the ones we recommend at the
 * top so the first entry in the dropdown is a sensible default.
 */
function rankModels(names, spec) {
  const suggested = (spec && spec.suggestedModels) || [];
  const usable = [...new Set(names.filter((n) => n && !NOT_A_VISION_CHAT_MODEL.test(n)))];

  const rank = (name) => {
    const index = suggested.indexOf(name);
    return index === -1 ? suggested.length : index;
  };

  return usable.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

function buildUserPrompt(question, mode, hasImage) {
  const lines = [];
  if (mode === 'explain') {
    lines.push(
      'EXPLAIN MODE: give a guided tour. Use several steps in the order you speak ' +
      'about them, each pointing at the exact region it describes.',
    );
  } else if (mode === 'chat' || !hasImage) {
    lines.push(
      'CHAT ONLY MODE: you have no screenshot. Answer from the conversation alone ' +
      'and return an empty steps list.',
    );
  }
  lines.push(`User question: ${question}`);
  return lines.join('\n\n');
}

function historyToContents(history) {
  return history.slice(-MAX_HISTORY).map((turn) => ({
    role: turn.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: turn.text }],
  }));
}

/** The plain user/assistant shape Anthropic and OpenAI both take. */
function historyToMessages(history) {
  return history.slice(-MAX_HISTORY).map((turn) => ({
    role: turn.role === 'assistant' ? 'assistant' : 'user',
    content: turn.text,
  }));
}

/**
 * The reply contract from PLAN 4.3, as a schema Anthropic's structured
 * outputs can enforce. Fields are nullable rather than optional because a
 * strict schema requires every key to be present; sanitizeStep does the
 * clamping and the dropping of unusable steps either way.
 */
function replySchema() {
  const { z } = require('zod');
  return z.object({
    speech: z.string(),
    steps: z.array(
      z.object({
        action: z.enum([...VALID_ACTIONS]),
        target: z.object({ box_2d: z.array(z.number()) }).nullable(),
        shape: z.string().nullable(),
        bubble: z.string().nullable(),
        label: z.string().nullable(),
        duration_ms: z.number().nullable(),
      }),
    ),
    auto_clear_after_ms: z.number(),
  });
}

function zodOutputFormat(schema) {
  return require('@anthropic-ai/sdk/helpers/zod').zodOutputFormat(schema);
}

function historyToText(history) {
  return history
    .slice(-MAX_HISTORY)
    .map((t) => `${t.role === 'assistant' ? 'Friday' : 'User'}: ${t.text}`)
    .join('\n');
}

/**
 * Turn whatever the model said into a usable response object.
 * Handles: clean JSON, JSON in code fences, JSON with prose wrapped around it,
 * and plain prose (which becomes a text-only answer).
 */
function parseReply(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return degraded('Friday did not return an answer. Try asking again.');

  const json = extractJson(trimmed);
  if (!json) return unreadable(trimmed);

  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    return unreadable(trimmed);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return unreadable(trimmed);
  }

  const speech =
    typeof parsed.speech === 'string' && parsed.speech.trim()
      ? parsed.speech.trim()
      : 'I looked, but I do not have anything to say about that.';

  const steps = Array.isArray(parsed.steps)
    ? parsed.steps.map(sanitizeStep).filter(Boolean).slice(0, MAX_STEPS)
    : [];

  const autoClear = Number(parsed.auto_clear_after_ms);

  return {
    speech,
    steps,
    auto_clear_after_ms: Number.isFinite(autoClear) ? coords.clamp(autoClear, 0, 30000) : 2000,
  };
}

/** Strip code fences and pull out the outermost {...} block. */
function extractJson(text) {
  let body = text;

  const fence = body.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) body = fence[1].trim();

  const start = body.indexOf('{');
  if (start === -1) return null;

  // Walk to the matching brace so trailing prose does not break the parse.
  // The stack tracks what is still open, so a cut-off reply can be repaired.
  const open = [];
  let inString = false;
  let escaped = false;

  for (let i = start; i < body.length; i += 1) {
    const char = body[i];
    if (escaped) { escaped = false; continue; }
    if (char === '\\') { escaped = true; continue; }
    if (char === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (char === '{' || char === '[') open.push(char);
    else if (char === '}' || char === ']') {
      open.pop();
      // Closed the object we started on; anything after is trailing prose.
      if (!open.length) return body.slice(start, i + 1);
    }
  }

  if (!open.length) return null;
  return repairTruncatedJson(body.slice(start), open, inString);
}

/**
 * Close a reply that stopped mid-sentence, so the steps that *did* arrive
 * survive. Models hit their output cap on long guided tours routinely, and
 * throwing away a good answer because its last step was clipped is worse
 * than showing the first few steps.
 */
function repairTruncatedJson(body, open, inString) {
  let repaired = inString ? `${body}"` : body;

  // A half-written key or a dangling comma would make the closed object
  // invalid, so drop them before sealing it up. Order matters: the more
  // specific tail is stripped first.
  repaired = repaired
    .replace(/\s*"[^"]*"\s*:\s*$/, '')    // "key": with no value yet
    .replace(/,\s*"[^"]*"\s*$/, '')       // , "key  -- cut before the colon
    .replace(/,\s*$/, '');                // a bare trailing comma

  // Innermost first: the stack already holds them in the right order.
  while (open.length) repaired += open.pop() === '{' ? '}' : ']';

  return repaired;
}

function sanitizeStep(step) {
  if (!step || typeof step !== 'object') return null;

  const action = VALID_ACTIONS.has(step.action) ? step.action : 'move_pointer';
  if (action === 'clear') return { action: 'clear' };

  const box = coords.normalizeBox(step.target && step.target.box_2d);
  // Every drawable action needs somewhere to be drawn.
  if (!box) return null;

  const duration = Number(step.duration_ms);
  return {
    action,
    box,
    // `shape` lets one step both move the pointer and draw a highlight.
    shape: VALID_ACTIONS.has(step.shape) ? step.shape : null,
    bubble: typeof step.bubble === 'string' ? step.bubble.slice(0, 220) : '',
    label: typeof step.label === 'string' ? step.label.slice(0, 60) : '',
    duration_ms: Number.isFinite(duration) ? coords.clamp(duration, 400, 15000) : 2500,
  };
}

/**
 * A reply Friday could not parse. When the text still looks like machine
 * output, say something human instead: reading braces and field names aloud
 * is worse than admitting the answer was unusable.
 */
function unreadable(text) {
  const looksStructured = /^[\s`]*[[{]/.test(text) || /"speech"\s*:/.test(text);
  if (looksStructured) {
    return degraded(
      'That answer came back malformed — the model was probably cut off mid-reply. Ask me again.',
      'unparsable',
    );
  }
  return degraded(text, 'unparsable');
}

/** A usable response when there is nothing structured to work with. */
function degraded(speech, reason = 'no-key') {
  return { speech, steps: [], auto_clear_after_ms: 2000, degraded: reason };
}

/**
 * Whether it is worth trying the next model in the chain.
 *
 * Two different situations, same remedy: the model name is dead (renamed or
 * retired), or the model is alive but overloaded. Gemini answers the second
 * with a 503 UNAVAILABLE, which is exactly when falling back to a less
 * popular model is most likely to work.
 */
function shouldTryNextModel(error) {
  const message = String((error && error.message) || error);
  return (
    /not found|not supported|does not exist|404|unsupported/i.test(message) ||
    /503|502|504|UNAVAILABLE|overloaded|high demand/i.test(message)
  );
}

module.exports = {
  AI, parseReply, extractJson, sanitizeStep,
  shouldTryNextModel, withTimeout, rankModels, MODEL_FALLBACKS,
};
