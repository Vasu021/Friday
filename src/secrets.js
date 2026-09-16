// API keys, encrypted at rest.
//
// PLAN 7 asks for the key to live in the keychain rather than a plain file.
// Electron's safeStorage does exactly that on macOS: encryptString hands the
// blob to the OS keychain, so what lands on disk is ciphertext that only this
// user on this machine can read.
//
// Keys are never sent to the renderer. The UI only ever learns whether a key
// exists (`hasKey`), never what it is.

const fs = require('node:fs');
const path = require('node:path');
const { app, safeStorage } = require('electron');

const FILE = 'credentials.enc';

let cache = null;

function file() {
  return path.join(app.getPath('userData'), FILE);
}

/** safeStorage needs a logged-in desktop session; without it we refuse to store. */
function available() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function readAll() {
  if (cache) return cache;
  cache = {};
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
    if (raw && typeof raw === 'object') cache = raw;
  } catch {
    // No file yet, or it is unreadable. Either way: start empty.
  }
  return cache;
}

function writeAll(all) {
  cache = all;
  try {
    fs.writeFileSync(file(), JSON.stringify(all, null, 2), { mode: 0o600 });
    return true;
  } catch (error) {
    console.error('Could not save credentials:', error.message);
    return false;
  }
}

/** @returns {string|null} the decrypted key for a provider. */
function getKey(providerId) {
  const stored = readAll()[providerId];
  if (!stored) return null;
  try {
    return safeStorage.decryptString(Buffer.from(stored, 'base64')) || null;
  } catch {
    // Wrong machine, wrong user, or a corrupted blob.
    return null;
  }
}

/**
 * Store (or with an empty value, clear) a provider's key.
 * @returns {{ok: boolean, error?: string}}
 */
function setKey(providerId, key) {
  const all = { ...readAll() };

  if (!key) {
    delete all[providerId];
    return writeAll(all) ? { ok: true } : { ok: false, error: 'Could not write the credential file.' };
  }

  if (!available()) {
    return { ok: false, error: 'This Mac will not let Friday encrypt the key, so it was not saved.' };
  }

  try {
    all[providerId] = safeStorage.encryptString(key).toString('base64');
  } catch (error) {
    return { ok: false, error: `Could not encrypt the key: ${error.message}` };
  }

  return writeAll(all) ? { ok: true } : { ok: false, error: 'Could not write the credential file.' };
}

function hasKey(providerId) {
  return Boolean(readAll()[providerId]);
}

module.exports = { getKey, setKey, hasKey, available };
