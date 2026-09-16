// The list of AI backends Friday can talk to.
//
// This is the single source of truth for both the setup UI and the code in
// ai.js, so adding a provider means adding one entry here plus one `call*`
// method. Nothing about a provider is hard-coded in the renderer.
//
// `supportsSTT` matters: Friday's voice button sends recorded audio to the
// model. Anthropic and Ollama take images but not audio, so with those the
// mic only works when a local whisper.cpp is configured.

const PROVIDERS = [
  {
    id: 'gemini',
    name: 'Google Gemini',
    blurb: 'Has a free tier. Handles both screen questions and voice.',
    needsKey: true,
    keyLabel: 'Gemini API key',
    keyPrefix: 'AIza',
    keyUrl: 'https://aistudio.google.com/apikey',
    supportsSTT: true,
    defaultModel: 'gemini-flash-latest',
    suggestedModels: ['gemini-flash-latest', 'gemini-2.5-flash', 'gemini-2.0-flash'],
  },
  {
    id: 'ollama',
    name: 'Ollama (on this Mac)',
    blurb: 'Free and private — nothing leaves your machine. Needs a vision model pulled.',
    needsKey: false,
    needsHost: true,
    defaultHost: 'http://127.0.0.1:11434',
    supportsSTT: false,
    defaultModel: 'qwen2.5vl',
    suggestedModels: ['qwen2.5vl', 'llava', 'llama3.2-vision'],
    setupHint: 'Install Ollama, then run:  ollama pull qwen2.5vl',
  },
  {
    id: 'claude',
    name: 'Anthropic Claude',
    blurb: 'Most accurate at pointing. Paid — no free tier.',
    needsKey: true,
    keyLabel: 'Anthropic API key',
    keyPrefix: 'sk-ant-',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    supportsSTT: false,
    defaultModel: 'claude-opus-5',
    suggestedModels: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    blurb: 'Paid. Handles both screen questions and voice.',
    needsKey: true,
    keyLabel: 'OpenAI API key',
    keyPrefix: 'sk-',
    keyUrl: 'https://platform.openai.com/api-keys',
    supportsSTT: true,
    defaultModel: 'gpt-4o',
    suggestedModels: ['gpt-4o', 'gpt-4o-mini'],
  },
];

const BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]));

/** @returns {object|null} the provider descriptor, or null if the id is unknown. */
function getProvider(id) {
  return BY_ID.get(id) || null;
}

/** The descriptor for `id`, falling back to Gemini so callers always get one. */
function resolveProvider(id) {
  return BY_ID.get(id) || BY_ID.get('gemini');
}

/**
 * What the renderer needs to draw the picker. Deliberately excludes anything
 * secret -- keys never travel to the renderer, only whether one is stored.
 */
function publicProviders() {
  return PROVIDERS.map((p) => ({
    id: p.id,
    name: p.name,
    blurb: p.blurb,
    needsKey: Boolean(p.needsKey),
    needsHost: Boolean(p.needsHost),
    defaultHost: p.defaultHost || null,
    keyLabel: p.keyLabel || 'API key',
    keyUrl: p.keyUrl || null,
    keyPrefix: p.keyPrefix || null,
    supportsSTT: Boolean(p.supportsSTT),
    defaultModel: p.defaultModel,
    suggestedModels: p.suggestedModels || [],
    setupHint: p.setupHint || null,
  }));
}

module.exports = { PROVIDERS, getProvider, resolveProvider, publicProviders };
