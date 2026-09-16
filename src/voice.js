// Speech to text. Recording happens in the chat renderer (it owns the mic);
// this module just turns the resulting audio buffer into text.
//
// PLAN 4.5 calls for local whisper.cpp. That needs a binary and a model file
// the user has to install separately, so Friday prefers it when configured and
// otherwise asks the chosen AI provider to transcribe -- same key, nothing
// extra to set up. Not every provider can: see `available` below.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

class Voice {
  constructor({ ai, whisperBin, whisperModel } = {}) {
    this.ai = ai;
    this.whisperBin = whisperBin || null;
    this.whisperModel = whisperModel || null;
  }

  get usingWhisper() {
    return Boolean(
      this.whisperBin &&
      this.whisperModel &&
      fs.existsSync(this.whisperBin) &&
      fs.existsSync(this.whisperModel),
    );
  }

  /**
   * Whether the mic can do anything right now. Anthropic and Ollama take
   * images but not audio, so with those Friday needs a local whisper.cpp
   * before the voice button means anything.
   */
  get available() {
    return this.usingWhisper || this.ai.supportsSTT;
  }

  get backend() {
    if (this.usingWhisper) return 'whisper.cpp (local)';
    if (this.ai.supportsSTT) return this.ai.provider;
    return 'unavailable';
  }

  /** Why the mic is disabled, for the UI to show. Null when it works. */
  get unavailableReason() {
    if (this.available) return null;
    return `${this.ai.spec.name} cannot transcribe audio. Install whisper.cpp, or switch to a provider that can.`;
  }

  /**
   * @param {Buffer} buffer  recorded audio
   * @param {string} mimeType  what the renderer's MediaRecorder produced
   * @returns {Promise<string>} the transcript, '' if nothing was said
   */
  async transcribe(buffer, mimeType) {
    if (!buffer || buffer.length === 0) return '';
    if (this.usingWhisper) return this.transcribeWithWhisper(buffer);
    if (!this.available) throw new Error(this.unavailableReason);
    return this.ai.transcribe({ data: buffer.toString('base64'), mimeType });
  }

  /**
   * whisper.cpp needs a file on disk, which is the one place audio touches it.
   * It is written to the OS temp dir and deleted in a finally block. The
   * no-disk rule in CLAUDE.md is about screenshots; audio has no other route
   * into a local binary.
   */
  async transcribeWithWhisper(buffer) {
    const stamp = `friday-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const audioPath = path.join(os.tmpdir(), `${stamp}.wav`);

    try {
      await fs.promises.writeFile(audioPath, buffer, { mode: 0o600 });
      const stdout = await run(this.whisperBin, [
        '-m', this.whisperModel,
        '-f', audioPath,
        '--output-txt', 'false',
        '--no-timestamps',
        '--language', 'en',
      ]);
      return cleanWhisperOutput(stdout);
    } finally {
      await fs.promises.rm(audioPath, { force: true });
    }
  }
}

function run(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 30000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) return reject(error);
      resolve(stdout);
    });
  });
}

/** whisper.cpp prints progress lines and bracketed timestamps around the text. */
function cleanWhisperOutput(stdout) {
  return stdout
    .split('\n')
    .map((line) => line.replace(/^\[[^\]]*\]\s*/, '').trim())
    .filter((line) => line && !line.startsWith('whisper_') && !line.startsWith('main:'))
    .join(' ')
    .trim();
}

module.exports = { Voice };
