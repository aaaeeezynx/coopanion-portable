'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const {
  SyncManager,
  defaultAppExecutable,
  installerHint,
  mergeSettings,
  pickSettings,
  resolveGitExecutable,
  scanText,
} = require('../scripts/sync.cjs');

const quiet = { log() {} };
const TEST_TMP = path.join(__dirname, '..', '.tmp');

function temporaryRoot(t) {
  fs.mkdirSync(TEST_TMP, { recursive: true });
  const root = fs.mkdtempSync(path.join(TEST_TMP, 'coopanion-sync-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return (result.stdout || '').trim();
}

function git(cwd, ...args) {
  return run('git', args, cwd);
}

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}

function seedProfile(profile, remoteUrl) {
  fs.mkdirSync(profile, { recursive: true });
  git(profile, 'init', '-b', 'main');
  git(profile, 'config', 'user.name', 'Sync Test');
  git(profile, 'config', 'user.email', 'sync-test@example.invalid');
  write(path.join(profile, '.gitignore'), '.env\n*.log\n');
  write(path.join(profile, '.gitattributes'), '* text=auto eol=lf\n*.png binary\n');
  write(path.join(profile, 'README.md'), '# Test profile\n');
  git(profile, 'add', '.');
  git(profile, 'commit', '-m', 'seed');
  git(profile, 'remote', 'add', 'origin', remoteUrl);
}

function createManager(root, profile, data) {
  return new SyncManager({
    root,
    profileDir: profile,
    dataDir: data,
    logger: quiet,
    now: () => new Date('2026-10-20T00:00:00.000Z'),
  });
}

test('shared settings use a narrow allowlist and keep local-only values', () => {
  const config = {
    language: 'zh-Hant',
    activeProvider: 'private-provider',
    providers: { coo: { apiKey: 'must-not-sync' } },
    web: { theme: 'light', port: 17788 },
    worlds: {
      'desktop-pet': {
        user: 'Alex',
        petX: 0.42,
        window: {
          scale: 1.2,
          enabled: false,
          electronFile: '/private/electron',
        },
        asr: {
          enabled: true,
          language: 'zh',
          simplified: false,
          segment: 1200,
          engine: 'whisper',
          mic: { hotkey: 'private-hotkey' },
        },
        cua: {
          enabled: true,
          permission: 'granted',
          grantMinutes: 30,
          screenshot: {
            maxWidth: 1920,
            quality: 80,
          },
        },
      },
      console: { private: true },
    },
  };

  const shared = pickSettings(config);
  assert.equal(shared.language, 'zh-Hant');
  assert.equal(shared.web.theme, 'light');
  assert.equal(shared.web.port, undefined);
  assert.equal(shared.worlds['desktop-pet'].user, 'Alex');
  assert.equal(shared.worlds['desktop-pet'].window.scale, 1.2);
  assert.equal(shared.worlds['desktop-pet'].window.enabled, undefined);
  assert.equal(shared.worlds['desktop-pet'].asr.enabled, true);
  assert.equal(shared.worlds['desktop-pet'].asr.language, 'zh');
  assert.equal(shared.worlds['desktop-pet'].asr.simplified, false);
  assert.equal(shared.worlds['desktop-pet'].asr.segment, undefined);
  assert.equal(shared.worlds['desktop-pet'].asr.engine, undefined);
  assert.equal(shared.worlds['desktop-pet'].cua, undefined);
  assert.equal(shared.worlds.console, undefined);
  assert.equal(shared.providers, undefined);

  const merged = mergeSettings(config, {
    language: 'en',
    worlds: {
      'desktop-pet': {
        window: { scale: 0.8 },
      },
    },
  });
  assert.equal(merged.language, 'en');
  assert.equal(merged.worlds['desktop-pet'].window.scale, 0.8);
  assert.equal(merged.worlds['desktop-pet'].window.enabled, false);
  assert.equal(merged.worlds['desktop-pet'].petX, 0.42);
  assert.equal(merged.activeProvider, 'private-provider');
  assert.equal(merged.providers.coo.apiKey, 'must-not-sync');
});

test('export and import copy only memory text, the avatar, and shared settings', (t) => {
  const root = temporaryRoot(t);
  const profile = path.join(root, 'profile');
  const remote = path.join(root, 'remote.git');
  fs.mkdirSync(remote);
  git(remote, 'init', '--bare');
  seedProfile(profile, remote);

  const dataA = path.join(root, 'data-a');
  const managerA = createManager(root, profile, dataA);
  managerA.ensureDirs();
  write(
    managerA.configFile,
    JSON.stringify({
      language: 'zh-Hant',
      activeProvider: 'keep-local',
      web: { theme: 'dark', port: 10001 },
    }),
  );
  write(path.join(managerA.workspaceDir, 'CONSTITUTION.md'), 'persona\n');
  write(path.join(managerA.workspaceDir, 'PARTNER.md'), 'partner\n');
  write(path.join(managerA.workspaceDir, 'partner', 'notes.md'), 'notes\n');
  write(path.join(managerA.workspaceDir, 'blobs', 'private.md'), 'never sync\n');
  write(path.join(managerA.workspaceDir, '.git', 'private.md'), 'never sync\n');
  write(path.join(managerA.workspaceDir, 'private.exe'), 'never sync\n');
  write(
    managerA.avatarFile,
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );

  const first = managerA.exportDataToProfile();
  assert.equal(first.hasSettings, true);
  assert.equal(first.hasAvatar, true);
  assert.equal(fs.existsSync(path.join(profile, 'memory', 'CONSTITUTION.md')), true);
  assert.equal(fs.existsSync(path.join(profile, 'memory', 'PARTNER.md')), true);
  assert.equal(fs.existsSync(path.join(profile, 'memory', 'partner', 'notes.md')), true);
  assert.equal(fs.existsSync(path.join(profile, 'memory', 'blobs', 'private.md')), false);
  assert.equal(fs.existsSync(path.join(profile, 'memory', '.git', 'private.md')), false);
  assert.equal(fs.existsSync(path.join(profile, 'memory', 'private.exe')), false);
  managerA.privacyScan();

  const dataB = path.join(root, 'data-b');
  const managerB = createManager(root, profile, dataB);
  managerB.ensureDirs();
  write(
    managerB.configFile,
    JSON.stringify({
      language: 'en',
      activeProvider: 'machine-local-provider',
      web: { port: 20002 },
    }),
  );
  const imported = managerB.importProfileToData();
  assert.equal(imported.changed, true);
  const importedConfig = JSON.parse(fs.readFileSync(managerB.configFile, 'utf8'));
  assert.equal(importedConfig.language, 'zh-Hant');
  assert.equal(importedConfig.activeProvider, 'machine-local-provider');
  assert.equal(importedConfig.web.port, 20002);
  assert.equal(fs.readFileSync(path.join(managerB.workspaceDir, 'PARTNER.md'), 'utf8'), 'partner\n');
  assert.deepEqual(fs.readFileSync(managerB.avatarFile), fs.readFileSync(managerA.avatarFile));

  fs.rmSync(path.join(managerA.workspaceDir, 'PARTNER.md'));
  write(path.join(managerA.workspaceDir, 'handoffs', 'new.txt'), 'new handoff\n');
  managerA.exportDataToProfile();
  assert.equal(fs.existsSync(path.join(profile, 'memory', 'PARTNER.md')), false);
  assert.equal(fs.existsSync(path.join(profile, 'memory', 'handoffs', 'new.txt')), true);

  fs.rmSync(path.join(profile, 'memory', 'partner', 'notes.md'));
  managerB.importProfileToData();
  assert.equal(fs.existsSync(path.join(managerB.workspaceDir, 'partner', 'notes.md')), false);
});

test('privacy scanner blocks common credentials but allows ordinary memory text', () => {
  assert.equal(scanText('A normal partner note about deployment.'), null);
  assert.equal(scanText(`github token ghp_${'a'.repeat(24)}`), 'github-token');
  assert.equal(scanText(`sk-proj-${'b'.repeat(24)}`), 'openai-key');
  assert.equal(scanText('password = "a-long-test-secret-value"'), 'assigned-secret');
  assert.equal(scanText('Bearer abcdefghijklmnopqrstuvwxyz012345'), 'bearer-token');
});

test('empty remote is initialized and later file changes are pushed', (t) => {
  const root = temporaryRoot(t);
  const remote = path.join(root, 'remote.git');
  const profile = path.join(root, 'profile');
  const data = path.join(root, 'data');
  fs.mkdirSync(remote);
  git(remote, 'init', '--bare');
  seedProfile(profile, remote);
  const manager = createManager(root, profile, data);
  manager.ensureDirs();
  write(path.join(manager.workspaceDir, 'CONSTITUTION.md'), 'first persona\n');
  write(manager.configFile, JSON.stringify({ language: 'zh-Hant' }));

  const initial = manager.syncOnce('test-initial');
  assert.equal(initial.state, 'ok', initial.message);
  assert.equal(git(remote, 'rev-parse', '--verify', 'refs/heads/main').length, 40);

  write(path.join(manager.workspaceDir, 'PARTNER.md'), 'new memory\n');
  const update = manager.syncOnce('test-update');
  assert.equal(update.state, 'ok', update.message);
  const file = git(remote, 'show', 'main:memory/PARTNER.md');
  assert.equal(file, 'new memory');
});

test('missing profile directory is cloned from the configured remote on first sync', (t) => {
  const root = temporaryRoot(t);
  const remote = path.join(root, 'remote.git');
  const seed = path.join(root, 'seed-profile');
  const profile = path.join(root, 'profile');
  const data = path.join(root, 'data');
  fs.mkdirSync(remote);
  git(remote, 'init', '--bare');
  seedProfile(seed, remote);
  write(path.join(seed, 'memory', 'CONSTITUTION.md'), 'remote persona\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-m', 'add remote persona');
  git(seed, 'push', '-u', 'origin', 'main');

  const manager = new SyncManager({
    root,
    profileDir: profile,
    dataDir: data,
    remoteUrl: remote,
    logger: quiet,
    now: () => new Date('2026-10-20T00:00:00.000Z'),
  });
  write(path.join(manager.workspaceDir, 'PARTNER.md'), 'local memory\n');

  const result = manager.syncOnce('first-launch');
  assert.equal(result.state, 'ok', result.message);
  assert.equal(git(profile, 'remote', 'get-url', 'origin'), remote);
  assert.equal(
    fs.readFileSync(path.join(manager.workspaceDir, 'CONSTITUTION.md'), 'utf8'),
    'remote persona\n',
  );
  assert.equal(git(remote, 'show', 'main:memory/PARTNER.md'), 'local memory');
});

test('nested profile is cloned even when the portable root is already a Git repository', (t) => {
  const root = temporaryRoot(t);
  const remote = path.join(root, 'remote.git');
  const seed = path.join(root, 'seed-profile');
  const profile = path.join(root, 'profile');
  const data = path.join(root, 'data');
  fs.mkdirSync(remote);
  git(remote, 'init', '--bare');
  seedProfile(seed, remote);
  write(path.join(seed, 'memory', 'CONSTITUTION.md'), 'remote persona\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-m', 'add remote persona');
  git(seed, 'push', '-u', 'origin', 'main');

  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Portable Root');
  git(root, 'config', 'user.email', 'portable-root@example.invalid');
  write(path.join(root, '.gitignore'), 'profile/\ndata/\n');
  fs.mkdirSync(profile);

  const manager = new SyncManager({
    root,
    profileDir: profile,
    dataDir: data,
    remoteUrl: remote,
    logger: quiet,
    now: () => new Date('2026-10-20T00:00:00.000Z'),
  });

  const result = manager.syncOnce('nested-root-repository');
  assert.equal(result.state, 'ok', result.message);
  assert.equal(fs.existsSync(path.join(profile, '.git')), true);
  assert.equal(
    path.resolve(git(profile, 'rev-parse', '--show-toplevel')).toLowerCase(),
    path.resolve(profile).toLowerCase(),
  );
  assert.equal(
    fs.readFileSync(path.join(manager.workspaceDir, 'CONSTITUTION.md'), 'utf8'),
    'remote persona\n',
  );
});

test('Windows portable Git is preferred when bundled', (t) => {
  const root = temporaryRoot(t);
  const bundled = path.join(
    root,
    'app',
    'windows',
    'resources',
    'app',
    'mingit',
    'cmd',
    'git.exe',
  );
  write(bundled, '');
  assert.equal(resolveGitExecutable(root, 'win32', {}), bundled);
});

test('installer hints match the supported desktop platforms', () => {
  assert.equal(installerHint('win32'), 'Install-Coopanion-Windows.cmd');
  assert.equal(installerHint('darwin'), 'bash "Install-Coopanion-macOS.command"');
  assert.equal(installerHint('linux'), 'bash "Install-Coopanion-Linux.sh"');
});

test('default executable paths match each supported platform', () => {
  const root = path.join(path.sep, 'portable');
  assert.equal(
    defaultAppExecutable(root, 'linux', {}),
    path.join(root, 'app', 'linux', 'Coopanion.AppImage'),
  );
  assert.equal(
    defaultAppExecutable(root, 'darwin', {}),
    path.join(root, 'app', 'macos', 'Coopanion.app', 'Contents', 'MacOS', 'Coopanion'),
  );
  assert.equal(
    defaultAppExecutable(root, 'win32', {}),
    path.join(root, 'app', 'windows', 'Coopanion.exe'),
  );
});

test('non-empty non-repository profile directory is never overwritten', (t) => {
  const root = temporaryRoot(t);
  const profile = path.join(root, 'profile');
  const marker = path.join(profile, 'keep-me.txt');
  write(marker, 'do not replace\n');
  const manager = createManager(root, profile, path.join(root, 'data'));

  assert.throws(
    () => manager.ensureProfileRepository(),
    /not empty and is not a Git repository/i,
  );
  assert.equal(fs.readFileSync(marker, 'utf8'), 'do not replace\n');
});

test('divergent edits preserve local work, stop without force-pushing, and create a backup', (t) => {
  const root = temporaryRoot(t);
  const remote = path.join(root, 'remote.git');
  const profileA = path.join(root, 'profile-a');
  const profileB = path.join(root, 'profile-b');
  const dataA = path.join(root, 'data-a');
  const dataB = path.join(root, 'data-b');
  fs.mkdirSync(remote);
  git(remote, 'init', '--bare');
  seedProfile(profileA, remote);

  const a = createManager(root, profileA, dataA);
  a.ensureDirs();
  write(path.join(a.workspaceDir, 'CONSTITUTION.md'), 'base\n');
  write(path.join(a.workspaceDir, 'PARTNER.md'), 'base partner\n');
  const seed = a.syncOnce('seed-remote');
  assert.equal(seed.state, 'ok', seed.message);

  git(root, 'clone', remote, profileB);
  git(profileB, 'config', 'user.name', 'Sync Test B');
  git(profileB, 'config', 'user.email', 'sync-test-b@example.invalid');
  const b = createManager(root, profileB, dataB);
  b.ensureDirs();
  const initialImport = b.syncOnce('initial-import');
  assert.equal(initialImport.state, 'ok', initialImport.message);

  write(path.join(a.workspaceDir, 'PARTNER.md'), 'change from A\n');
  const aChange = a.syncOnce('a-change');
  assert.equal(aChange.state, 'ok', aChange.message);
  const remoteBeforeB = git(remote, 'rev-parse', 'main');

  write(path.join(b.workspaceDir, 'PARTNER.md'), 'change from B\n');
  const conflict = b.syncOnce('b-change');
  assert.equal(conflict.state, 'error');
  assert.match(conflict.message, /conflict/i);
  assert.equal(git(remote, 'rev-parse', 'main'), remoteBeforeB);
  assert.equal(fs.readFileSync(path.join(b.workspaceDir, 'PARTNER.md'), 'utf8'), 'change from B\n');
  assert.match(git(profileB, 'log', '-1', '--format=%s'), /sync Coopanion memory/);
  const backups = fs.readdirSync(path.join(dataB, '.portable-sync', 'backups'));
  assert.ok(backups.length >= 1);
});
