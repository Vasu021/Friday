// Turning a provider's error into something a person can act on.
//
// Every branch here is a guess based on pattern matching against error text
// that each provider words differently, so the UI shows the raw message
// alongside the friendly one -- a wrong guess is worse than no guess if it
// hides what actually happened.

/**
 * Pull a usable message out of whatever was thrown.
 *
 * macOS denies screen capture by throwing an Error with an *empty* message.
 * `String(new Error(''))` is the bare word "Error", which tells the user
 * nothing, so that case has to be caught explicitly rather than passed on.
 */
function describe(error) {
  if (!error) return 'unknown error';

  const message = String(error.message || '').trim();
  if (message) return message;

  const stringified = String(error).trim();
  if (!stringified || stringified === 'undefined' || stringified === 'Error') {
    return 'the system refused the request';
  }
  return stringified;
}

/**
 * @param {string} message  the raw provider error
 * @param {{name?: string, model?: string, provider?: string, host?: string}} context
 * @returns {string} advice worth showing the user
 */
function classify(message, context = {}) {
  const name = context.name || 'The AI';

  // Billing first. An exhausted account also returns 429, but waiting will
  // never fix it, so it must never be reported as rate limiting.
  if (/insufficient_quota|exceeded your current quota|billing|credit balance/i.test(message)) {
    return `Your ${name} account has no credits left. Add billing on the provider's dashboard — ` +
      'this will not clear on its own.';
  }
  if (/401|403|invalid[_ ]api[_ ]key|API key|PERMISSION_DENIED|authentication/i.test(message)) {
    return `${name} rejected the API key. Check you pasted the whole key, then re-enter it.`;
  }
  if (/404|model[_ ]not[_ ]found|does not exist|do not have access/i.test(message)) {
    return `${name} has no model called "${context.model}" for this account. Try a different model.`;
  }
  if (/429|rate limit|RESOURCE_EXHAUSTED/i.test(message)) {
    return `${name} is rate limiting you. Wait a minute and try again.`;
  }
  // The model is alive but swamped. Friday has already walked its fallback
  // chain by the time this surfaces, so every model it knows was busy.
  if (/503|502|504|UNAVAILABLE|overloaded|high demand/i.test(message)) {
    return `${name} is overloaded right now — Friday tried its fallback models too. ` +
      'Wait a moment, or name a different model above.';
  }
  if (/did not answer within/i.test(message)) {
    return `${name} did not answer in time. It may be overloaded — try again, ` +
      'or switch to a smaller model.';
  }
  if (/ECONNREFUSED/i.test(message) && context.provider === 'ollama') {
    return `Could not reach Ollama at ${context.host}. Is it running?`;
  }
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|network/i.test(message)) {
    return 'Could not reach the AI. Check your internet connection.';
  }
  return `Friday hit an error: ${message}`;
}

module.exports = { describe, classify };
