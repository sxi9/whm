import path from 'node:path';
import { z } from 'zod';
import { hasBinary } from '../exec.js';
import { defineOp, arg, OpError } from './registry.js';
import { accountPath, asUser, failureOf, lstatOrNull } from './as-user.js';

// Git Version Control for the account panel (P3-1). Every git command runs
// under the account's own uid through as-user.js with a HOME of its own, no
// terminal prompt (a credential prompt fails instead of hanging), no system
// git config, and only the https and ssh transports (file:, ext:: and the
// like are refused by the URL schema and again by git's protocol.allow). The
// repository directory is pinned under the home (lexically and through
// symlinks); the deployment step runs the tasks of .keel.yml one program at a
// time from a pinned set, never a shell.

const MiB = 1024 * 1024;
export const CLONE_TIMEOUT_MS = 900_000;
export const PULL_TIMEOUT_MS = 600_000;
export const TASK_TIMEOUT_MS = 300_000;
export const KEEL_FILE = '.keel.yml';
export const KEEL_MAX_BYTES = 64 * 1024;
export const MAX_TASKS = 50;
// Every task has its own limit; the op's limit covers the whole plan, so a long
// but well-behaved deployment is never cut short without its `results`.
export const DEPLOY_TIMEOUT_MS = TASK_TIMEOUT_MS * MAX_TASKS + 60_000;
// https://host[:port]/path, ssh://git@host[:port]/path or git@host:path.
// No userinfo but "git" (a password in a URL would land in the job log and
// the audit), no "-" at the start of anything git might read as an option.
const HOST = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*';
const URL_PATH = '[A-Za-z0-9][A-Za-z0-9._~/-]*';
export const GIT_URL_RE = new RegExp(`^(?:https://${HOST}(?::\\d{1,5})?/${URL_PATH}|ssh://git@${HOST}(?::\\d{1,5})?/${URL_PATH}|git@${HOST}:${URL_PATH})$`);
export const GIT_URL_MESSAGE = 'An https:// URL, an ssh://git@host/path URL or git@host:path, without a user name or password';
export const gitUrl = z.string().max(512).regex(GIT_URL_RE, GIT_URL_MESSAGE).refine((u) => !/(^|\/)\.\.(\/|$)/.test(u), GIT_URL_MESSAGE);
// Environment of every git command: no prompts, no /etc/gitconfig, no
// transport other than https and ssh (submodules included), ssh in batch mode.
export const GIT_ENV = Object.freeze({
  GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_ASKPASS: '/bin/true', SSH_ASKPASS: '/bin/true',
  GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new',
  GIT_CONFIG_COUNT: '3',
  GIT_CONFIG_KEY_0: 'protocol.allow', GIT_CONFIG_VALUE_0: 'never',
  GIT_CONFIG_KEY_1: 'protocol.https.allow', GIT_CONFIG_VALUE_1: 'always',
  GIT_CONFIG_KEY_2: 'protocol.ssh.allow', GIT_CONFIG_VALUE_2: 'always',
});

// The deployment task grammar: one of five programs, options from the
// program's own short list, every other argument a path that stays inside
// the home. A path is read relative to the repository, "~/" relative to the
// home, and an absolute path must already be under the home.
export const TASK_PROGRAMS = Object.freeze({
  cp: { options: ['-r', '-R', '-p', '-a', '-f', '-v', '-n', '-u', '-T', '--'], minPaths: 2 },
  rsync: { options: ['-a', '-r', '-v', '-q', '-z', '-u', '-c', '--delete', '--delete-after', '--exclude=', '--'], minPaths: 2 },
  mkdir: { options: ['-p', '-v', '--'], minPaths: 1 },
  rm: { options: ['-r', '-R', '-f', '-v', '--'], minPaths: 1 },
  chmod: { options: ['-R', '-v', '--'], minPaths: 1, mode: true },
});
export const TASK_MODE_RE = /^(?:0?[0-7]{3,4}|[ugoa]*[+=-][rwxX]+(?:,[ugoa]*[+=-][rwxX]+)*)$/;

const base = { username: arg.username };
const dirArg = arg.absPath;
const toIso = (epoch) => (Number.isFinite(epoch) && epoch > 0 ? new Date(epoch * 1000).toISOString() : null);

function requireGit() {
  if (!hasBinary('git')) throw new OpError('capability_missing', 'git is not installed on this server; it is required for Git Version Control');
}

function assertRepoDir(target, home) {
  if (target === home) throw new OpError('refused', 'the home directory itself cannot be a repository');
}

function repoState(target) {
  const st = lstatOrNull(target);
  if (!st) return 'missing';
  if (st.isSymbolicLink()) throw new OpError('refused', `${target} is a symbolic link; Git Version Control does not follow links`);
  if (!st.isDirectory()) throw new OpError('refused', `${target} is not a directory`);
  return lstatOrNull(path.join(target, '.git')) ? 'repo' : 'dir';
}

async function git(info, dir, argv, { timeoutMs = 60_000, maxBuffer = 4 * MiB } = {}) {
  return asUser(info, 'git', dir ? ['-C', dir, ...argv] : argv, { allowFailure: true, timeoutMs, maxBuffer, env: GIT_ENV });
}

export function parseRemotes(stdout) {
  const out = new Map();
  for (const line of String(stdout || '').split('\n')) {
    const m = /^(\S+)\t(\S+)\s+\((fetch|push)\)$/.exec(line.trim());
    if (!m) continue;
    const r = out.get(m[1]) || { name: m[1], url: null, push: null };
    if (m[3] === 'fetch') r.url = m[2]; else r.push = m[2];
    out.set(m[1], r);
  }
  return [...out.values()];
}

export function parseHead(stdout) {
  const line = String(stdout || '').trim().split('\n')[0];
  if (!line) return null;
  const [sha, subject, date] = line.split('\t');
  if (!/^[0-9a-f]{40}$/.test(sha || '')) return null;
  return { sha, short: sha.slice(0, 12), subject: subject || '', date: date || null };
}

// Tolerant output of `git status --porcelain`: the count of changed entries.
export const countDirty = (stdout) => String(stdout || '').split('\n').filter((l) => l.trim()).length;

// The minimal YAML the deployment file needs:
//   deployment:
//     tasks:
//       - cp -R index.html ~/public_html/
// Only that shape is read; anything else in the file is ignored, and a
// tasks list in another form (flow sequence, nested maps) is refused.
export function parseKeelYml(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  let inDeployment = false;
  let inTasks = false;
  let tasksIndent = -1;
  let found = false;
  const tasks = [];
  for (const raw of lines) {
    const line = raw.replace(/\s+#.*$/, '').replace(/^\s*#.*$/, '');
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    const body = line.trim();
    if (indent === 0) { inDeployment = /^deployment:\s*$/.test(body); inTasks = false; continue; }
    if (!inDeployment) continue;
    if (!inTasks) {
      if (/^tasks:\s*$/.test(body)) { inTasks = true; tasksIndent = indent; found = true; continue; }
      if (/^tasks:\s*\[/.test(body)) throw new OpError('invalid_args', `${KEEL_FILE}: write the tasks as a list of lines ("- command"), not inline`);
      continue;
    }
    if (indent <= tasksIndent) { inTasks = false; continue; }
    const item = /^-\s+(.*)$/.exec(body);
    if (!item) throw new OpError('invalid_args', `${KEEL_FILE}: every task is a line starting with "- "`);
    let value = item[1].trim();
    const quoted = /^(["'])(.*)\1$/.exec(value);
    if (quoted) value = quoted[2];
    if (value) tasks.push(value);
    if (tasks.length > MAX_TASKS) throw new OpError('invalid_args', `${KEEL_FILE}: at most ${MAX_TASKS} tasks`);
  }
  if (!found) throw new OpError('not_found', `${KEEL_FILE} has no "deployment: tasks:" list`);
  return tasks;
}

// Splits one task line into words: whitespace separated, with double or
// single quotes around a word that holds spaces. No escapes, no variables,
// no operators: a "$", "`", ";", "|", "&", "<", ">" or newline anywhere
// refuses the task, since nothing here is a shell.
export function splitTask(line) {
  if (/[$`;|&<>\n\r\0]/.test(line)) throw new OpError('invalid_args', `task "${line}": shell characters are not allowed; one program with its arguments per task`);
  const words = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(line))) words.push(m[1] ?? m[2] ?? m[3]);
  return words;
}

export function resolveTaskPath(word, { home, repo, program = 'cp' }) {
  if (!word || word.includes('\0') || word.startsWith('-')) throw new OpError('invalid_args', `"${word}" is not a path`);
  if (/(^|\/)\.\.(\/|$)/.test(word)) throw new OpError('invalid_args', `"${word}" leaves its folder with ".."`);
  const trailing = word.length > 1 && word.endsWith('/') ? '/' : '';
  let abs;
  if (word === '~' || word.startsWith('~/')) abs = path.resolve(home, word.slice(2));
  else if (path.isAbsolute(word)) abs = path.resolve(word);
  else abs = path.resolve(repo, word);
  if (abs !== home && !abs.startsWith(`${home}/`)) throw new OpError('path_not_allowed', `"${word}" is outside your home directory`);
  if (abs === home && ['rm', 'chmod'].includes(program)) throw new OpError('refused', `"${word}" is the home directory itself`);
  return abs + (abs.endsWith('/') ? '' : trailing);
}

// [{ program, argv }] for every task, fully resolved: the panel shows the
// plan before anything runs and the agent executes exactly this.
export function planTasks(tasks, { home, repo }) {
  return tasks.map((line) => {
    const words = splitTask(line);
    const program = words[0];
    const spec = TASK_PROGRAMS[program];
    if (!spec) throw new OpError('invalid_args', `task "${line}": "${program || ''}" is not one of ${Object.keys(TASK_PROGRAMS).join(', ')}`);
    const argv = [];
    let paths = 0;
    let modeSeen = false;
    let optionsDone = false;
    for (const w of words.slice(1)) {
      if (!optionsDone && w.startsWith('-')) {
        if (w === '--') { optionsDone = true; argv.push(w); continue; }
        const combined = /^-[A-Za-z]{2,}$/.test(w) && [...w.slice(1)].every((c) => spec.options.includes(`-${c}`));
        const ok = combined || spec.options.includes(w) || spec.options.some((o) => o.endsWith('=') && w.startsWith(o) && w.length > o.length && !/[\0]/.test(w));
        if (!ok) throw new OpError('invalid_args', `task "${line}": option "${w}" is not allowed for ${program}`);
        argv.push(w);
        continue;
      }
      if (spec.mode && !modeSeen) {
        if (/^[ugoa]*[+=-][rwxXst]*[st]/.test(w) || /[+=-][^,]*[st]/.test(w)) throw new OpError('refused', `task "${line}": setuid/setgid/sticky bits are never granted`);
        if (!TASK_MODE_RE.test(w)) throw new OpError('invalid_args', `task "${line}": "${w}" is not a file mode`);
        if (/^0?[0-7]{4}$/.test(w) && (parseInt(w, 8) & 0o6000)) throw new OpError('refused', `task "${line}": setuid/setgid modes are never granted`);
        if (/[st]/.test(w)) throw new OpError('refused', `task "${line}": setuid/setgid modes are never granted`);
        modeSeen = true;
        argv.push(w);
        continue;
      }
      argv.push(resolveTaskPath(w, { home, repo, program }));
      paths += 1;
    }
    if (spec.mode && !modeSeen) throw new OpError('invalid_args', `task "${line}": chmod needs a mode`);
    if (paths < spec.minPaths) throw new OpError('invalid_args', `task "${line}": ${program} needs ${spec.minPaths} path${spec.minPaths === 1 ? '' : 's'}`);
    if (!argv.includes('--')) argv.splice(argv.length - paths, 0, '--');
    return { program, argv, line };
  });
}

async function readKeelYml(info, repo) {
  const file = path.join(repo, KEEL_FILE);
  const st = lstatOrNull(file);
  if (!st) throw new OpError('not_found', `${KEEL_FILE} is missing from the repository`);
  if (st.isSymbolicLink() || !st.isFile()) throw new OpError('refused', `${KEEL_FILE} must be a regular file`);
  if (st.size > KEEL_MAX_BYTES) throw new OpError('refused', `${KEEL_FILE} is larger than ${KEEL_MAX_BYTES} bytes`);
  const r = await asUser(info, 'cat', ['--', file], { allowFailure: true, timeoutMs: 30_000, maxBuffer: KEEL_MAX_BYTES + 1024 });
  if (r.code !== 0) throw failureOf(r, `read ${KEEL_FILE}`);
  return r.stdout;
}

const tail = (text, n = 20) => String(text || '').trim().split('\n').filter(Boolean).slice(-n).join('\n');

async function infoOf(info, home, target) {
  const [branch, head, remotes, status] = await Promise.all([
    git(info, target, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(info, target, ['log', '-1', '--format=%H%x09%s%x09%cI']),
    git(info, target, ['remote', '-v']),
    git(info, target, ['status', '--porcelain', '--untracked-files=normal'], { maxBuffer: 16 * MiB }),
  ]);
  if (remotes.code !== 0 && status.code !== 0) throw failureOf(status, `read ${path.relative(home, target)}`);
  const fetchHead = lstatOrNull(path.join(target, '.git', 'FETCH_HEAD'));
  return {
    path: target, rel: path.relative(home, target),
    branch: branch.code === 0 ? branch.stdout.trim() || null : null,
    head: head.code === 0 ? parseHead(head.stdout) : null,
    remotes: parseRemotes(remotes.stdout),
    dirty: status.code === 0 ? countDirty(status.stdout) : null,
    lastPullAt: fetchHead ? fetchHead.mtime.toISOString() : null,
    hasKeelYml: Boolean(lstatOrNull(path.join(target, KEEL_FILE))),
  };
}

defineOp('git.init', {
  description: 'Create an empty git repository in an account home as the account',
  schema: z.object({ ...base, dir: dirArg }).strict(),
  run: async ({ username, dir }, ctx) => {
    const { info, home, target } = accountPath(username, dir, ctx, 'write', { protectSshDir: true });
    assertRepoDir(target, home);
    requireGit();
    const state = repoState(target);
    if (state === 'repo') throw new OpError('exists', `${path.relative(home, target)} already is a git repository`);
    const mk = await asUser(info, 'mkdir', ['-p', '--', target], { allowFailure: true, timeoutMs: 30_000 });
    if (mk.code !== 0) throw failureOf(mk, `create ${path.relative(home, target)}`);
    const r = await git(info, null, ['init', '--', target], { timeoutMs: 60_000 });
    if (r.code !== 0) throw failureOf(r, `git init ${path.relative(home, target)}`);
    return { ...(await infoOf(info, home, target)), created: state === 'missing' };
  },
});

defineOp('git.clone', {
  description: 'Clone a repository over https or ssh into an account home as the account (no prompts; the directory must not exist yet)',
  timeoutMs: CLONE_TIMEOUT_MS + 60_000,
  schema: z.object({ ...base, dir: dirArg, url: gitUrl }).strict(),
  run: async ({ username, dir, url }, ctx) => {
    const { info, home, target } = accountPath(username, dir, ctx, 'write', { protectSshDir: true });
    assertRepoDir(target, home);
    requireGit();
    if (repoState(target) !== 'missing') throw new OpError('exists', `${path.relative(home, target)} already exists; choose another folder`);
    const parent = path.dirname(target);
    const mk = await asUser(info, 'mkdir', ['-p', '--', parent], { allowFailure: true, timeoutMs: 30_000 });
    if (mk.code !== 0) throw failureOf(mk, `create ${path.relative(home, parent)}`);
    const r = await git(info, null, ['clone', '--', url, target], { timeoutMs: CLONE_TIMEOUT_MS, maxBuffer: 16 * MiB });
    if (r.code !== 0) {
      await asUser(info, 'rm', ['-rf', '--', target], { allowFailure: true, timeoutMs: 120_000 }).catch(() => {});
      const line = tail(r.stderr, 1);
      if (/Authentication failed|could not read Username|Permission denied \(publickey\)|terminal prompts disabled/i.test(r.stderr)) throw new OpError('refused', `git clone needs credentials the panel cannot supply: ${line}`, { stderr: tail(r.stderr) });
      if (/not found|does not appear to be a git repository|Could not resolve host|unable to access/i.test(r.stderr)) throw new OpError('not_found', `git clone: ${line}`, { stderr: tail(r.stderr) });
      throw new OpError('command_failed', `git clone failed: ${line}`, { stderr: tail(r.stderr) });
    }
    return { ...(await infoOf(info, home, target)), url, output: tail(r.stderr) };
  },
});

defineOp('git.list', {
  description: 'List the git repositories directly under one folder of an account home as the account',
  schema: z.object({ ...base, root: dirArg }).strict(),
  run: async ({ username, root }, ctx) => {
    const { info, home, target } = accountPath(username, root, ctx, 'read');
    const state = lstatOrNull(target);
    if (!state) return { root: target, rel: path.relative(home, target) || '.', repos: [], exists: false };
    if (state.isSymbolicLink() || !state.isDirectory()) throw new OpError('refused', `${path.relative(home, target)} is not a directory`);
    const r = await asUser(info, 'find', ['-P', target, '-mindepth', '2', '-maxdepth', '2', '-name', '.git', '-printf', '%h\\0'], { allowFailure: true, timeoutMs: 120_000, maxBuffer: 16 * MiB });
    if (r.code !== 0 && !r.stdout) throw failureOf(r, `list ${path.relative(home, target) || '.'}`);
    const repos = r.stdout.split('\0').filter(Boolean).sort().map((p) => ({ path: p, rel: path.relative(home, p), name: path.basename(p) }));
    return { root: target, rel: path.relative(home, target) || '.', repos, exists: true };
  },
});

defineOp('git.info', {
  description: 'Branch, HEAD, remotes, change count and last fetch time of a repository in an account home, read as the account',
  schema: z.object({ ...base, dir: dirArg }).strict(),
  run: async ({ username, dir }, ctx) => {
    const { info, home, target } = accountPath(username, dir, ctx, 'read');
    assertRepoDir(target, home);
    requireGit();
    const state = repoState(target);
    if (state === 'missing') throw new OpError('not_found', `${path.relative(home, target)} does not exist`);
    if (state === 'dir') throw new OpError('not_found', `${path.relative(home, target)} is not a git repository`);
    return infoOf(info, home, target);
  },
});

defineOp('git.pull', {
  description: 'git pull --ff-only in a repository of an account home as the account',
  timeoutMs: PULL_TIMEOUT_MS + 60_000,
  schema: z.object({ ...base, dir: dirArg }).strict(),
  run: async ({ username, dir }, ctx) => {
    const { info, home, target } = accountPath(username, dir, ctx, 'write', { protectSshDir: true });
    assertRepoDir(target, home);
    requireGit();
    if (repoState(target) !== 'repo') throw new OpError('not_found', `${path.relative(home, target)} is not a git repository`);
    const before = await infoOf(info, home, target);
    if (!before.remotes.length) throw new OpError('refused', `${before.rel} has no remote to pull from`);
    const r = await git(info, target, ['pull', '--ff-only', '--no-rebase'], { timeoutMs: PULL_TIMEOUT_MS, maxBuffer: 16 * MiB });
    const output = tail(`${r.stdout}\n${r.stderr}`);
    if (r.code !== 0) {
      const line = tail(r.stderr, 1) || tail(r.stdout, 1);
      if (/Not possible to fast-forward|diverg|would be overwritten|local changes/i.test(`${r.stdout}\n${r.stderr}`)) throw new OpError('refused', `git pull cannot fast-forward: ${line}`, { stderr: output });
      if (/Authentication failed|could not read Username|Permission denied \(publickey\)|terminal prompts disabled/i.test(r.stderr)) throw new OpError('refused', `git pull needs credentials the panel cannot supply: ${line}`, { stderr: output });
      throw new OpError('command_failed', `git pull failed: ${line}`, { stderr: output });
    }
    const after = await infoOf(info, home, target);
    return { ...after, from: before.head?.sha ?? null, updated: (before.head?.sha ?? null) !== (after.head?.sha ?? null), output };
  },
});

defineOp('git.deploy', {
  description: 'Run the deployment tasks of .keel.yml (cp, rsync, mkdir, rm, chmod on paths inside the home) one by one as the account, never through a shell',
  timeoutMs: DEPLOY_TIMEOUT_MS,
  schema: z.object({ ...base, dir: dirArg, dryRun: z.boolean().default(false) }).strict(),
  run: async ({ username, dir, dryRun }, ctx) => {
    const { info, home, target } = accountPath(username, dir, ctx, 'write', { protectSshDir: true });
    assertRepoDir(target, home);
    if (repoState(target) !== 'repo') throw new OpError('not_found', `${path.relative(home, target)} is not a git repository`);
    const tasks = parseKeelYml(await readKeelYml(info, target));
    if (!tasks.length) throw new OpError('not_found', `${KEEL_FILE} lists no tasks`);
    const plan = planTasks(tasks, { home, repo: target });
    const results = [];
    for (const [i, step] of plan.entries()) {
      if (dryRun) { results.push({ index: i, line: step.line, program: step.program, argv: step.argv, ran: false }); continue; }
      const r = await asUser(info, step.program, step.argv, { allowFailure: true, timeoutMs: TASK_TIMEOUT_MS, cwd: target, maxBuffer: 4 * MiB });
      results.push({ index: i, line: step.line, program: step.program, argv: step.argv, ran: true, code: r.code, output: tail(`${r.stdout}\n${r.stderr}`, 10) });
      if (r.code !== 0) {
        const err = failureOf(r, `task ${i + 1} (${step.line})`);
        err.details = { ...(err.details || {}), results };
        throw err;
      }
    }
    return { path: target, rel: path.relative(home, target), tasks: results, dryRun };
  },
});

defineOp('git.remove', {
  description: 'Remove a repository directory from an account home as the account (nothing else)',
  destructive: true,
  schema: z.object({ ...base, dir: dirArg }).strict(),
  run: async ({ username, dir }, ctx) => {
    const { info, home, target } = accountPath(username, dir, ctx, 'write', { protectSshDir: true });
    assertRepoDir(target, home);
    const state = repoState(target);
    if (state === 'missing') return { path: target, rel: path.relative(home, target), removed: false };
    if (state === 'dir') throw new OpError('refused', `${path.relative(home, target)} is not a git repository; remove it from the file manager instead`);
    const r = await asUser(info, 'rm', ['-rf', '--', target], { allowFailure: true, timeoutMs: 600_000 });
    if (r.code !== 0) throw failureOf(r, `remove ${path.relative(home, target)}`);
    return { path: target, rel: path.relative(home, target), removed: true };
  },
});
