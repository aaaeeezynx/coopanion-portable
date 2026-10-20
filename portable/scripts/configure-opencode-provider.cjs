#!/usr/bin/env node
'use strict';

/**
 * Keep the local OpenCodeGo provider compatible with its Go endpoint.
 *
 * Coopanion's built-in "coo" provider cannot send arbitrary HTTP headers.
 * The Responses-compatible provider can, so this migration preserves the
 * existing model configuration and supplies the required session header.
 * This script intentionally never reads or modifies the provider's .env file.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PROVIDER_NAME = 'opencode';
const COMPAT_KIND = 'openai-responses-compat';
const SESSION_HEADER = 'x-opencode-session';
const SUPPORTED_KINDS = new Set(['coo', COMPAT_KIND]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function providerConfigPath(dataDir) {
  return path.join(path.resolve(dataDir), 'home', 'providers', PROVIDER_NAME, 'config.json');
}

function defaultSessionId(platform = process.platform) {
  if (platform === 'win32') return 'coopanion-windows';
  if (platform === 'darwin') return 'coopanion-macos';
  if (platform === 'linux') return 'coopanion-linux';
  return 'coopanion-portable';
}

function writeJsonAtomic(file, value) {
  const mode = fs.statSync(file).mode & 0o777;
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, jsonText(value), { encoding: 'utf8', mode });
  try {
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function configureOpencodeProvider(options = {}) {
  const dataDir = path.resolve(
    options.dataDir || process.env.CORTICO_COMPANION_DATA || path.join(ROOT, 'data'),
  );
  const file = providerConfigPath(dataDir);
  if (!fs.existsSync(file)) {
    return { changed: false, reason: 'not-configured', file };
  }

  const original = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!isPlainObject(original)) {
    throw new Error(`OpenCode provider config must be a JSON object: ${file}`);
  }
  if (!SUPPORTED_KINDS.has(original.kind)) {
    return { changed: false, reason: 'unsupported-kind', file };
  }

  const currentOptions = original.options === undefined ? {} : original.options;
  if (!isPlainObject(currentOptions)) {
    throw new Error(`OpenCode provider options must be a JSON object: ${file}`);
  }
  const currentHeaders =
    currentOptions.extraHeaders === undefined ? {} : currentOptions.extraHeaders;
  if (
    !isPlainObject(currentHeaders) ||
    Object.values(currentHeaders).some((value) => typeof value !== 'string')
  ) {
    throw new Error(`OpenCode provider extraHeaders must be a string-to-string object: ${file}`);
  }

  const sessionId =
    options.sessionId || defaultSessionId(options.platform || process.platform);
  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    throw new Error('OpenCode session identifier must be a non-empty string.');
  }

  const updated = {
    ...original,
    kind: COMPAT_KIND,
    options: {
      ...currentOptions,
      extraHeaders: {
        ...currentHeaders,
        [SESSION_HEADER]: sessionId,
      },
    },
  };
  const before = jsonText(original);
  const after = jsonText(updated);
  if (before === after) {
    return { changed: false, reason: 'current', file };
  }

  writeJsonAtomic(file, updated);
  return { changed: true, reason: 'migrated', file };
}

function main() {
  const result = configureOpencodeProvider();
  if (result.changed) {
    console.log(`[Coopanion Setup] Configured OpenCodeGo compatibility: ${result.file}`);
    return;
  }
  if (result.reason === 'not-configured') {
    console.log('[Coopanion Setup] OpenCodeGo provider is not configured yet; skipped.');
    return;
  }
  if (result.reason === 'unsupported-kind') {
    console.log('[Coopanion Setup] OpenCodeGo provider kind is not managed; left unchanged.');
    return;
  }
  console.log('[Coopanion Setup] OpenCodeGo provider is already configured.');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[Coopanion Setup] ${message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  COMPAT_KIND,
  PROVIDER_NAME,
  SESSION_HEADER,
  configureOpencodeProvider,
  defaultSessionId,
  providerConfigPath,
};
