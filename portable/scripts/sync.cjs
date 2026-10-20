#!/usr/bin/env node
'use strict';

/**
 * Portable Coopanion profile sync.
 *
 * Runtime data stays in Coopanion's normal data directory. Only an explicit
 * allowlist of settings, text memory, and the avatar is copied to profile/.
 * The profile repository is never allowed to contain binaries, provider
 * credentials, logs, caches, databases, nested repositories, or blobs.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { configureOpencodeProvider } = require('./configure-opencode-provider.cjs');

const ROOT = path.resolve(__dirname, '..');
const PROFILE_DIR = path.join(ROOT, 'profile');
const DATA_DIR = path.resolve(process.env.CORTICO_COMPANION_DATA || path.join(ROOT, 'data'));
const DEFAULT_PROFILE_URL = 'https://github.com/aaaeeezynx/coopanion-profile.git';
const BRANCH = 'main';
const REMOTE = 'origin';
const MEMORY_EXTENSIONS = new Set(['.md', '.txt']);
const BLOCKED_SEGMENTS = new Set([
  '.git',
  'blobs',
  'node_modules',
  'providers',
  'extensions',
  'models',
  'caches',
  'cache',
  'logs',
  'secrets',
  'credentials',
]);

const SHARED_SETTINGS = {
  displayName: true,
  language: true,
  web: { theme: true },
  rounds: { soft: true, hard: true },
  companion: { telemetry: true },
  worlds: {
    'desktop-pet': {
      user: true,
      roam: true,
      sound: true,
      sounds: true,
      theme: true,
      hoverButtons: true,
      doubleClickChat: true,
      statusBubble: true,
      selfAdjust: true,
      selfAdjustCustom: true,
      skin: true,
      window: {
        scale: true,
        bubbleSize: true,
        fontSize: true,
        bubbleSpeed: true,
        glow: true,
        frameRate: true,
        lockFrameRate: true,
        exportOverlay: true,
      },
      touch: {
        enabled: true,
        wakeOn: true,
        wakeKinds: true,
      },
      asr: {
        enabled: true,
        language: true,
        simplified: true,
      },
    },
  },
};

const SECRET_RULES = [
  {
    id: 'private-key',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/i,
  },
  {
    id: 'openai-key',
    pattern: /\bsk-(?:proj-|live-)?[A-Za-z0-9_-]{20,}\b/,
  },
  {
    id: 'github-token',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/,
  },
  {
    id: 'slack-token',
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  },
  {
    id: 'bearer-token',
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{24,}\b/i,
  },
  {
    id: 'assigned-secret',
    pattern:
      /\b(?:api[_-]?key|access[_-]?token|auth(?:orization)?|client[_-]?secret|password|private[_-]?key|refresh[_-]?token|secret[_-]?key)\b\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{16,}/i,
  },
];

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function pickSettings(source, schema = SHARED_SETTINGS) {
  const out = {};
  if (!isPlainObject(source)) return out;
  for (const [key, rule] of Object.entries(schema)) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    if (rule === true) {
      out[key] = cloneJson(source[key]);
      continue;
    }
    const child = pickSettings(source[key], rule);
    if (Object.keys(child).length > 0) out[key] = child;
  }
  return out;
}

function mergeSettings(target, source, schema = SHARED_SETTINGS) {
  const out = isPlainObject(target) ? { ...target } : {};
  if (!isPlainObject(source)) return out;
  for (const [key, rule] of Object.entries(schema)) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    if (rule === true) {
      out[key] = cloneJson(source[key]);
      continue;
    }
    out[key] = mergeSettings(out[key], source[key], rule);
  }
  return out;
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sameBuffer(file, content) {
  if (!fs.existsSync(file)) return false;
  const current = fs.readFileSync(file);
  const next = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return current.equals(next);
}

function writeChanged(file, content, mode) {
  if (sameBuffer(file, content)) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, content, mode ? { mode } : undefined);
  try {
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  return true;
}

function writeJsonChanged(file, value) {
  return writeChanged(file, jsonText(value));
}

function sameFile(source, target) {
  return fs.existsSync(target) && fs.readFileSync(source).equals(fs.readFileSync(target));
}

function copyChanged(source, target, mode) {
  if (sameFile(source, target)) return false;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.copyFileSync(source, temporary);
  if (mode) fs.chmodSync(temporary, mode);
  try {
    fs.renameSync(temporary, target);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  return true;
}

function safeRelativePath(value) {
  const normalized = value.replaceAll('\\', '/');
  const safe = path.posix.normalize(normalized);
  if (
    !safe ||
    safe === '.' ||
    safe.startsWith('../') ||
    safe.startsWith('/') ||
    path.posix.isAbsolute(safe)
  ) {
    throw new Error(`Unsafe profile path: ${value}`);
  }
  const segments = safe.split('/');
  for (const segment of segments) {
    if (!segment || segment === '..' || BLOCKED_SEGMENTS.has(segment.toLowerCase())) {
      throw new Error(`Blocked profile path: ${value}`);
    }
  }
  return safe;
}

function isMemoryText(relativePath) {
  const normalized = relativePath.replaceAll('\\', '/');
  const segments = normalized.split('/');
  if (segments.some((segment) => BLOCKED_SEGMENTS.has(segment.toLowerCase()))) return false;
  return MEMORY_EXTENSIONS.has(path.extname(normalized).toLowerCase());
}

function walkFiles(root) {
  const files = [];
  if (!fs.existsSync(root)) return files;
  const visit = (directory, prefix) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (BLOCKED_SEGMENTS.has(entry.name.toLowerCase())) continue;
        visit(path.join(directory, entry.name), relative);
      } else if (entry.isFile()) {
        files.push(relative);
      }
    }
  };
  visit(root, '');
  return files.sort((a, b) => a.localeCompare(b));
}

function collectMemoryFiles(workspace) {
  const paths = new Map();
  for (const relative of walkFiles(workspace)) {
    if (!isMemoryText(relative)) continue;
    paths.set(safeRelativePath(relative), path.join(workspace, ...relative.split('/')));
  }
  return paths;
}

function scanText(text) {
  for (const rule of SECRET_RULES) {
    if (rule.pattern.test(text)) return rule.id;
  }
  return null;
}

function findSecret(file) {
  const text = fs.readFileSync(file, 'utf8');
  return scanText(text);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: 'utf8',
    stdio: options.stdio || 'pipe',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (!options.allowFailure && result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
  };
}

function resolveGitExecutable(root = ROOT, platform = process.platform, env = process.env) {
  if (env.COOPANION_GIT) {
    const configured = path.isAbsolute(env.COOPANION_GIT)
      ? env.COOPANION_GIT
      : path.resolve(root, env.COOPANION_GIT);
    if (fs.existsSync(configured)) return configured;
  }
  if (platform === 'win32') {
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
    if (fs.existsSync(bundled)) return bundled;
  }
  return 'git';
}

function comparablePath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function samePath(left, right) {
  return comparablePath(left) === comparablePath(right);
}

function timestamp() {
  return new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function defaultAppExecutable(root = ROOT, platform = process.platform, env = process.env) {
  if (env.CORTICO_COMPANION_APP) return path.resolve(env.CORTICO_COMPANION_APP);
  if (platform === 'win32') return path.join(root, 'app', 'windows', 'Coopanion.exe');
  if (platform === 'darwin') {
    return path.join(root, 'app', 'macos', 'Coopanion.app', 'Contents', 'MacOS', 'Coopanion');
  }
  return path.join(root, 'app', 'linux', 'Coopanion.AppImage');
}

function installerHint(platform = process.platform) {
  if (platform === 'win32') return 'Install-Coopanion-Windows.cmd';
  if (platform === 'darwin') return 'bash "Install-Coopanion-macOS.command"';
  return 'bash "Install-Coopanion-Linux.sh"';
}

class SyncManager {
  constructor(options = {}) {
    this.root = path.resolve(options.root || ROOT);
    this.profileDir = path.resolve(options.profileDir || path.join(this.root, 'profile'));
    this.dataDir = path.resolve(
      options.dataDir || process.env.CORTICO_COMPANION_DATA || path.join(this.root, 'data'),
    );
    this.remoteUrl = options.remoteUrl || DEFAULT_PROFILE_URL;
    this.branch = options.branch || BRANCH;
    this.remote = options.remote || REMOTE;
    this.now = options.now || (() => new Date());
    this.logger = options.logger || console;
    this.gitExecutable = options.gitExecutable || resolveGitExecutable(this.root);
    this.stateDir = path.join(this.dataDir, '.portable-sync');
    this.stateFile = path.join(this.stateDir, 'state.json');
    this.statusFile = path.join(this.stateDir, 'status.json');
    this.logFile = path.join(this.stateDir, 'sync.log');
    this.lockFile = path.join(this.stateDir, 'sync.lock');
    this.configFile = path.join(this.dataDir, 'home', 'companion', 'config.json');
    this.workspaceDir = path.join(this.dataDir, 'home', 'companion', 'workspace');
    this.avatarFile = path.join(this.dataDir, 'home', 'companion', 'avatar.png');
    this.profileSettings = path.join(this.profileDir, 'settings', 'companion.shared.json');
    this.profileMemory = path.join(this.profileDir, 'memory');
    this.profileAvatar = path.join(this.profileDir, 'assets', 'avatar.png');
  }

  git(repo, args, allowFailure = false) {
    return run(this.gitExecutable, args, { cwd: repo, allowFailure });
  }

  gitOutput(repo, args, allowFailure = false) {
    return this.git(repo, args, allowFailure).stdout;
  }

  isProfileRepository() {
    const topLevel = this.git(this.profileDir, ['rev-parse', '--show-toplevel'], true);
    return topLevel.ok && samePath(topLevel.stdout, this.profileDir);
  }

  ensureDirs() {
    fs.mkdirSync(this.stateDir, { recursive: true });
    fs.mkdirSync(path.dirname(this.configFile), { recursive: true });
    fs.mkdirSync(this.workspaceDir, { recursive: true });
    fs.mkdirSync(this.profileDir, { recursive: true });
  }

  log(message) {
    const line = `[${this.now().toISOString()}] ${message}`;
    fs.mkdirSync(this.stateDir, { recursive: true });
    fs.appendFileSync(this.logFile, `${line}\n`);
    if (this.logger && typeof this.logger.log === 'function') this.logger.log(`[Coopanion Sync] ${message}`);
  }

  status(state, message, details = {}) {
    const value = {
      state,
      message,
      at: this.now().toISOString(),
      ...details,
    };
    fs.mkdirSync(this.stateDir, { recursive: true });
    writeJsonChanged(this.statusFile, value);
    return value;
  }

  acquireLock() {
    fs.mkdirSync(this.stateDir, { recursive: true });
    try {
      const descriptor = fs.openSync(this.lockFile, 'wx');
      fs.writeFileSync(
        descriptor,
        jsonText({ pid: process.pid, startedAt: this.now().toISOString() }),
      );
      fs.closeSync(descriptor);
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner = null;
      try {
        owner = readJson(this.lockFile);
      } catch {
        // A damaged lock is stale.
      }
      if (owner && processAlive(Number(owner.pid))) return false;
      fs.rmSync(this.lockFile, { force: true });
      return this.acquireLock();
    }
  }

  releaseLock() {
    try {
      const owner = readJson(this.lockFile);
      if (Number(owner.pid) === process.pid) fs.rmSync(this.lockFile, { force: true });
    } catch {
      // Nothing to release.
    }
  }

  readState() {
    const defaults = {
      version: 1,
      memoryFiles: [],
      hasAvatar: false,
      hasSettings: false,
    };
    if (!fs.existsSync(this.stateFile)) return defaults;
    const parsed = readJson(this.stateFile);
    return {
      ...defaults,
      ...parsed,
      memoryFiles: Array.isArray(parsed.memoryFiles) ? parsed.memoryFiles : [],
    };
  }

  writeState(state) {
    return writeJsonChanged(this.stateFile, {
      version: 1,
      memoryFiles: [...new Set(state.memoryFiles || [])].sort((a, b) => a.localeCompare(b)),
      hasAvatar: Boolean(state.hasAvatar),
      hasSettings: Boolean(state.hasSettings),
    });
  }

  ensureProfileRepository() {
    fs.mkdirSync(this.profileDir, { recursive: true });
    if (!this.isProfileRepository()) {
      const entries = fs.readdirSync(this.profileDir);
      if (entries.length > 0) {
        throw new Error(
          `Profile directory is not empty and is not a Git repository: ${this.profileDir}`,
        );
      }
      if (!this.remoteUrl) {
        throw new Error(`Profile repository URL is not configured for ${this.profileDir}`);
      }
      this.log(`Bootstrapping profile repository from ${this.remoteUrl}.`);
      this.git(this.root, [
        'clone',
        '--branch',
        this.branch,
        '--single-branch',
        this.remoteUrl,
        this.profileDir,
      ]);
    }
    if (!this.isProfileRepository()) {
      throw new Error(`Could not initialize profile repository: ${this.profileDir}`);
    }
    const origin = this.gitOutput(this.profileDir, ['remote', 'get-url', this.remote], true);
    if (!origin && this.remoteUrl) {
      this.git(this.profileDir, ['remote', 'add', this.remote, this.remoteUrl]);
    }
    if (!origin && !this.remoteUrl) {
      throw new Error(`Git remote "${this.remote}" is missing in ${this.profileDir}`);
    }
    const current = this.gitOutput(this.profileDir, ['symbolic-ref', '--short', 'HEAD'], true);
    if (current !== this.branch) {
      const hasHead = this.git(this.profileDir, ['rev-parse', '--verify', 'HEAD'], true).ok;
      const branchExists = this.git(
        this.profileDir,
        ['show-ref', '--verify', '--quiet', `refs/heads/${this.branch}`],
        true,
      ).ok;
      if (!hasHead && !branchExists) {
        this.git(this.profileDir, ['checkout', '-b', this.branch]);
      } else {
        this.git(this.profileDir, ['checkout', this.branch]);
      }
    }
    this.git(this.profileDir, ['config', 'core.autocrlf', 'false']);
    this.git(this.profileDir, ['config', 'core.filemode', 'false']);
  }

  assertCleanWorktree() {
    const changes = this.gitOutput(this.profileDir, [
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
    ]);
    if (changes) throw new Error('Profile repository has uncommitted changes after export.');
  }

  profileMemoryFiles() {
    const files = new Map();
    for (const relative of walkFiles(this.profileMemory)) {
      if (!isMemoryText(relative)) continue;
      files.set(safeRelativePath(relative), path.join(this.profileMemory, ...relative.split('/')));
    }
    return files;
  }

  validateInventory() {
    const unexpected = [];
    for (const relative of walkFiles(this.profileDir)) {
      const allowed =
        relative === '.gitignore' ||
        relative === '.gitattributes' ||
        relative === 'README.md' ||
        relative === 'settings/companion.shared.json' ||
        relative === 'assets/avatar.png' ||
        (relative.startsWith('memory/') && isMemoryText(relative.slice('memory/'.length)));
      if (!allowed) unexpected.push(relative);
    }
    if (unexpected.length) {
      throw new Error(`Profile contains files outside the sync allowlist: ${unexpected.join(', ')}`);
    }
  }

  privacyScan() {
    this.validateInventory();
    const textFiles = [
      path.join(this.profileDir, 'README.md'),
      path.join(this.profileDir, '.gitignore'),
      path.join(this.profileDir, '.gitattributes'),
      this.profileSettings,
      ...this.profileMemoryFiles().values(),
    ];
    for (const file of textFiles) {
      if (!fs.existsSync(file)) continue;
      const rule = findSecret(file);
      if (rule) {
        const relative = path.relative(this.profileDir, file).replaceAll('\\', '/');
        throw new Error(`Privacy guard blocked ${relative} (matched ${rule}).`);
      }
    }
  }

  exportDataToProfile() {
    fs.mkdirSync(this.profileMemory, { recursive: true });
    fs.mkdirSync(path.join(this.profileDir, 'settings'), { recursive: true });
    fs.mkdirSync(path.join(this.profileDir, 'assets'), { recursive: true });
    const previous = this.readState();
    let changed = false;

    let hasSettings = false;
    if (fs.existsSync(this.configFile)) {
      const config = readJson(this.configFile);
      const shared = pickSettings(config);
      hasSettings = Object.keys(shared).length > 0;
      if (hasSettings) changed = writeJsonChanged(this.profileSettings, shared) || changed;
    }
    if (!hasSettings && previous.hasSettings && fs.existsSync(this.profileSettings)) {
      fs.rmSync(this.profileSettings);
      changed = true;
    }

    const localMemory = collectMemoryFiles(this.workspaceDir);
    for (const [relative, source] of localMemory) {
      const target = path.join(this.profileMemory, ...relative.split('/'));
      changed = copyChanged(source, target, 0o644) || changed;
    }
    for (const stale of previous.memoryFiles || []) {
      const safe = safeRelativePath(stale);
      if (localMemory.has(safe)) continue;
      const target = path.join(this.profileMemory, ...safe.split('/'));
      if (fs.existsSync(target)) {
        fs.rmSync(target);
        changed = true;
      }
    }

    let hasAvatar = false;
    if (fs.existsSync(this.avatarFile)) {
      hasAvatar = true;
      changed = copyChanged(this.avatarFile, this.profileAvatar, 0o644) || changed;
    } else if (previous.hasAvatar && fs.existsSync(this.profileAvatar)) {
      fs.rmSync(this.profileAvatar);
      changed = true;
    }

    const managedMemory = [...localMemory.keys()];
    const stateChanged = this.writeState({
      memoryFiles: managedMemory,
      hasAvatar,
      hasSettings,
    });
    return {
      changed: changed || stateChanged,
      memoryFiles: managedMemory,
      hasAvatar,
      hasSettings,
    };
  }

  backupBeforeImport(targets) {
    const existing = [];
    for (const target of targets) {
      if (fs.existsSync(target) && fs.statSync(target).isFile()) existing.push(target);
    }
    if (!existing.length) return null;
    const backupRoot = path.join(this.stateDir, 'backups', timestamp());
    const files = [];
    for (const source of existing) {
      const relative = path.relative(this.dataDir, source).replaceAll('\\', '/');
      const destination = path.join(backupRoot, 'data', ...relative.split('/'));
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(source, destination);
      files.push(relative);
    }
    writeJsonChanged(path.join(backupRoot, 'manifest.json'), {
      createdAt: this.now().toISOString(),
      files,
    });
    return backupRoot;
  }

  backupManagedData() {
    const targets = [this.configFile, this.avatarFile];
    for (const file of collectMemoryFiles(this.workspaceDir).values()) targets.push(file);
    return this.backupBeforeImport(targets);
  }

  importProfileToData() {
    const previous = this.readState();
    const remoteMemory = this.profileMemoryFiles();
    const hasManagedContent =
      fs.existsSync(this.profileSettings) ||
      fs.existsSync(this.profileAvatar) ||
      remoteMemory.size > 0;
    if (!hasManagedContent) return { changed: false, backup: null, memoryFiles: previous.memoryFiles };

    const targets = [];
    if (fs.existsSync(this.profileSettings)) targets.push(this.configFile);
    if (fs.existsSync(this.profileAvatar)) targets.push(this.avatarFile);
    for (const relative of remoteMemory.keys()) {
      targets.push(path.join(this.workspaceDir, ...relative.split('/')));
    }
    for (const previousRelative of previous.memoryFiles || []) {
      targets.push(path.join(this.workspaceDir, ...safeRelativePath(previousRelative).split('/')));
    }
    const backup = this.backupBeforeImport([...new Set(targets)]);
    let changed = false;

    if (fs.existsSync(this.profileSettings)) {
      const shared = readJson(this.profileSettings);
      if (!isPlainObject(shared)) throw new Error('Shared settings must be a JSON object.');
      const local = fs.existsSync(this.configFile) ? readJson(this.configFile) : {};
      const merged = mergeSettings(local, shared);
      changed = writeJsonChanged(this.configFile, merged) || changed;
    }

    for (const [relative, source] of remoteMemory) {
      const destination = path.join(this.workspaceDir, ...relative.split('/'));
      changed = copyChanged(source, destination, 0o644) || changed;
    }

    for (const previousRelative of previous.memoryFiles || []) {
      const safe = safeRelativePath(previousRelative);
      if (remoteMemory.has(safe)) continue;
      const destination = path.join(this.workspaceDir, ...safe.split('/'));
      if (fs.existsSync(destination)) {
        fs.rmSync(destination);
        changed = true;
      }
    }

    let hasAvatar = false;
    if (fs.existsSync(this.profileAvatar)) {
      hasAvatar = true;
      changed = copyChanged(this.profileAvatar, this.avatarFile, 0o644) || changed;
    }

    this.writeState({
      memoryFiles: [...remoteMemory.keys()],
      hasAvatar,
      hasSettings: fs.existsSync(this.profileSettings),
    });
    return { changed, backup, memoryFiles: [...remoteMemory.keys()] };
  }

  commitIfNeeded(message) {
    this.privacyScan();
    this.git(this.profileDir, ['add', '--all', '--', '.']);
    const staged = !this.git(this.profileDir, ['diff', '--cached', '--quiet'], true).ok;
    if (!staged) return false;
    this.privacyScan();
    const name = this.gitOutput(this.profileDir, ['config', 'user.name'], true);
    const email = this.gitOutput(this.profileDir, ['config', 'user.email'], true);
    const author = [];
    if (!name) author.push('-c', 'user.name=Coopanion Sync');
    if (!email) author.push('-c', 'user.email=coopanion-sync@localhost');
    this.git(this.profileDir, [...author, 'commit', '-m', message]);
    this.log(`Committed profile changes: ${message}`);
    return true;
  }

  hasHead() {
    return this.git(this.profileDir, ['rev-parse', '--verify', 'HEAD'], true).ok;
  }

  remoteHead() {
    const result = this.git(
      this.profileDir,
      ['rev-parse', '--verify', `refs/remotes/${this.remote}/${this.branch}`],
      true,
    );
    return result.ok ? result.stdout : null;
  }

  isAncestor(ancestor, descendant) {
    return this.git(
      this.profileDir,
      ['merge-base', '--is-ancestor', ancestor, descendant],
      true,
    ).ok;
  }

  fetch() {
    return this.git(this.profileDir, ['fetch', '--prune', this.remote]);
  }

  push() {
    if (!this.hasHead()) return false;
    const remote = this.remoteHead();
    const local = this.gitOutput(this.profileDir, ['rev-parse', 'HEAD']);
    if (remote === local) return false;
    this.git(this.profileDir, [
      'push',
      '--set-upstream',
      this.remote,
      `${this.branch}:${this.branch}`,
    ]);
    this.log(`Pushed ${local.slice(0, 12)} to ${this.remote}/${this.branch}.`);
    return true;
  }

  reconcile(message) {
    this.commitIfNeeded(message);
    this.fetch();
    const local = this.hasHead() ? this.gitOutput(this.profileDir, ['rev-parse', 'HEAD']) : null;
    const remote = this.remoteHead();

    if (!local) throw new Error('Profile branch has no commit.');
    if (!remote) {
      this.push();
      return { action: 'pushed-initial', imported: false };
    }
    if (local === remote) {
      const imported = this.importProfileToData();
      return { action: 'unchanged', imported: imported.changed };
    }
    if (this.isAncestor(remote, local)) {
      this.push();
      this.importProfileToData();
      return { action: 'pushed', imported: true };
    }
    if (this.isAncestor(local, remote)) {
      this.git(this.profileDir, ['merge', '--ff-only', `${this.remote}/${this.branch}`]);
      const imported = this.importProfileToData();
      return { action: 'fast-forwarded', imported: imported.changed };
    }

    this.backupManagedData();
    this.log('Local and remote history diverged; rebasing local profile changes.');
    const rebase = this.git(this.profileDir, ['rebase', `${this.remote}/${this.branch}`], true);
    if (!rebase.ok) {
      this.git(this.profileDir, ['rebase', '--abort'], true);
      throw new Error(
        'Profile histories conflict. Local changes are preserved; resolve the conflict before syncing again.',
      );
    }
    this.push();
    const imported = this.importProfileToData();
    return { action: 'rebased', imported: imported.changed };
  }

  syncOnce(reason = 'manual') {
    this.ensureDirs();
    if (!this.acquireLock()) {
      const message = 'Another Coopanion sync is already running.';
      this.log(message);
      return this.status('busy', message);
    }
    try {
      this.status('syncing', `Synchronizing (${reason})...`);
      this.ensureProfileRepository();
      const exported = this.exportDataToProfile();
      const result = this.reconcile('chore: sync Coopanion memory and settings');
      this.privacyScan();
      this.assertCleanWorktree();
      const message =
        result.action === 'unchanged'
          ? 'Profile is up to date.'
          : `Profile synchronized (${result.action}).`;
      this.log(message);
      return this.status('ok', message, {
        reason,
        action: result.action,
        exported: exported.changed,
        imported: result.imported,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`Sync failed: ${message}`);
      return this.status('error', message, { reason });
    } finally {
      this.releaseLock();
    }
  }

  fingerprint() {
    const hash = crypto.createHash('sha256');
    const add = (label, file) => {
      hash.update(label);
      if (!fs.existsSync(file)) {
        hash.update('\0missing\0');
        return;
      }
      hash.update('\0');
      hash.update(fs.readFileSync(file));
      hash.update('\0');
    };
    add('config', this.configFile);
    add('avatar', this.avatarFile);
    for (const [relative, file] of collectMemoryFiles(this.workspaceDir)) add(relative, file);
    return hash.digest('hex');
  }

  async launch() {
    this.ensureDirs();
    const executable = defaultAppExecutable(this.root);
    if (!fs.existsSync(executable)) {
      throw new Error(
        `Coopanion executable not found: ${executable}. Run ${installerHint()} first.`,
      );
    }
    const provider = configureOpencodeProvider({ dataDir: this.dataDir });
    if (provider.changed) this.log('Configured OpenCodeGo compatibility for this machine.');
    this.syncOnce('startup');
    let fingerprint = this.fingerprint();
    let syncing = false;
    let stopping = false;

    const environment = { ...process.env, CORTICO_COMPANION_DATA: this.dataDir };
    delete environment.ELECTRON_RUN_AS_NODE;
    const child = spawn(executable, [], {
      cwd: this.root,
      env: environment,
      stdio: 'ignore',
      windowsHide: false,
    });

    const periodic = setInterval(() => {
      if (syncing || stopping) return;
      const next = this.fingerprint();
      if (next === fingerprint) return;
      syncing = true;
      try {
        fingerprint = next;
        this.syncOnce('file-change');
        fingerprint = this.fingerprint();
      } finally {
        syncing = false;
      }
    }, 3_000);

    const finish = (code) => {
      if (stopping) return;
      stopping = true;
      clearInterval(periodic);
      this.syncOnce('exit');
      this.log(`Coopanion exited with code ${code ?? 0}.`);
      process.exitCode = Number.isInteger(code) ? code : 0;
    };

    child.once('error', (error) => {
      this.log(`Could not start Coopanion: ${error.message}`);
      finish(1);
    });
    child.once('exit', finish);

    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      process.once(signal, () => {
        if (!child.killed) child.kill(signal);
        finish(0);
      });
    }
  }
}

async function main(argv = process.argv.slice(2)) {
  const command = argv[0] || 'launch';
  const manager = new SyncManager();
  if (command === 'launch') {
    await manager.launch();
    return;
  }
  if (command === 'sync') {
    const result = manager.syncOnce('manual');
    if (result.state === 'error') process.exitCode = 1;
    return;
  }
  if (command === 'export') {
    manager.ensureDirs();
    manager.ensureProfileRepository();
    manager.exportDataToProfile();
    manager.privacyScan();
    return;
  }
  if (command === 'import') {
    manager.ensureDirs();
    manager.ensureProfileRepository();
    manager.importProfileToData();
    return;
  }
  if (command === 'status') {
    manager.log(JSON.stringify(fs.existsSync(manager.statusFile) ? readJson(manager.statusFile) : {}));
    return;
  }
  throw new Error(`Unknown command: ${command}. Use launch, sync, export, import, or status.`);
}

if (require.main === module) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[Coopanion Sync] ${message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_PROFILE_URL,
  DATA_DIR,
  PROFILE_DIR,
  SHARED_SETTINGS,
  SECRET_RULES,
  SyncManager,
  collectMemoryFiles,
  defaultAppExecutable,
  installerHint,
  isMemoryText,
  jsonText,
  mergeSettings,
  pickSettings,
  resolveGitExecutable,
  safeRelativePath,
  scanText,
};
