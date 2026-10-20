'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  COMPAT_KIND,
  SESSION_HEADER,
  configureOpencodeProvider,
  defaultSessionId,
  providerConfigPath,
} = require('../scripts/configure-opencode-provider.cjs');

const TEST_TMP = path.join(__dirname, '..', '.tmp');

function temporaryData(t) {
  fs.mkdirSync(TEST_TMP, { recursive: true });
  const data = fs.mkdtempSync(path.join(TEST_TMP, 'coopanion-provider-'));
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  return data;
}

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}

test('migrates the coo provider without losing local configuration', (t) => {
  const data = temporaryData(t);
  const configFile = providerConfigPath(data);
  const envFile = path.join(path.dirname(configFile), '.env');
  const original = {
    kind: 'coo',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    secret: 'OPENAI_API_KEY',
    spec: {
      model: 'deepseek-v4.1-flash',
      thinking: true,
      reasoningEffort: 'low',
      maxTokens: 8192,
      contextWindow: 512000,
      privateModelSetting: 'keep-me',
    },
    multimodal: true,
    pricing: [],
    options: {
      endpointPath: '/responses',
      extraBody: { service_tier: 'default' },
      extraHeaders: { 'x-existing-header': 'keep-me' },
      unknownOption: { enabled: true },
    },
    unknownTopLevel: ['keep-me'],
  };
  write(configFile, `${JSON.stringify(original, null, 2)}\n`);
  write(envFile, 'OPENAI_API_KEY=placeholder-not-a-real-key\n');

  const result = configureOpencodeProvider({ dataDir: data, platform: 'win32' });
  assert.equal(result.changed, true);
  assert.equal(result.reason, 'migrated');

  const migrated = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.equal(migrated.kind, COMPAT_KIND);
  assert.deepEqual(migrated.spec, original.spec);
  assert.deepEqual(migrated.pricing, original.pricing);
  assert.equal(migrated.baseUrl, original.baseUrl);
  assert.equal(migrated.secret, original.secret);
  assert.equal(migrated.multimodal, true);
  assert.deepEqual(migrated.unknownTopLevel, original.unknownTopLevel);
  assert.deepEqual(migrated.options.unknownOption, original.options.unknownOption);
  assert.deepEqual(migrated.options.extraBody, original.options.extraBody);
  assert.deepEqual(migrated.options.extraHeaders, {
    'x-existing-header': 'keep-me',
    [SESSION_HEADER]: 'coopanion-windows',
  });
  assert.equal(fs.readFileSync(envFile, 'utf8'), 'OPENAI_API_KEY=placeholder-not-a-real-key\n');
  assert.equal(fs.readFileSync(configFile, 'utf8').endsWith('\n'), true);

  const second = configureOpencodeProvider({ dataDir: data, platform: 'win32' });
  assert.equal(second.changed, false);
  assert.equal(second.reason, 'current');
});

test('adds or repairs the session header for an existing compatible provider', (t) => {
  const data = temporaryData(t);
  const configFile = providerConfigPath(data);
  write(
    configFile,
    JSON.stringify({
      kind: COMPAT_KIND,
      baseUrl: 'https://opencode.ai/zen/go/v1',
      options: {
        extraHeaders: {
          authorization_template: 'leave-other-headers-alone',
          [SESSION_HEADER]: 'outdated-session',
        },
      },
    }),
  );

  const result = configureOpencodeProvider({ dataDir: data, platform: 'darwin' });
  assert.equal(result.changed, true);
  const updated = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.deepEqual(updated.options.extraHeaders, {
    authorization_template: 'leave-other-headers-alone',
    [SESSION_HEADER]: 'coopanion-macos',
  });
});

test('does not create missing configs or alter unmanaged provider kinds', (t) => {
  const data = temporaryData(t);
  const configFile = providerConfigPath(data);

  const missing = configureOpencodeProvider({ dataDir: data });
  assert.equal(missing.changed, false);
  assert.equal(missing.reason, 'not-configured');
  assert.equal(fs.existsSync(configFile), false);

  write(configFile, '{"kind":"something-else"}\n');
  const unsupported = configureOpencodeProvider({ dataDir: data });
  assert.equal(unsupported.changed, false);
  assert.equal(unsupported.reason, 'unsupported-kind');
  assert.equal(fs.readFileSync(configFile, 'utf8'), '{"kind":"something-else"}\n');
});

test('uses stable platform session identifiers', () => {
  assert.equal(defaultSessionId('win32'), 'coopanion-windows');
  assert.equal(defaultSessionId('darwin'), 'coopanion-macos');
  assert.equal(defaultSessionId('linux'), 'coopanion-linux');
  assert.equal(defaultSessionId('freebsd'), 'coopanion-portable');
});
