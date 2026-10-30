import { notFound, unprocessable, conflict, CapabilityError } from '../lib/errors.js';
import { isRoot } from '../middleware/rbac.js';
import { STACK_COMPONENTS, STACK_PROFILES, componentByKey, componentForCapability, componentForService, profileComponents } from '../lib/stack-catalog.js';

// Server stack: what is installed, and installing it. Attached as ctx.stack.
//   stack.status()                                  -> { packageManager, family, components: [{ key, installed, active, ... }], profiles }
//   stack.install({ components | profile }, user, req) -> { job, components } (one stack.install job for the whole selection)
//   stack.capabilityInstall(cap, user, req)         -> same, for the component that provides a capability (404 when the catalog has none)
//   stack.serviceInstall(name, user, req)           -> same, for a Service Manager row
//   stack.setup.pending(user) / complete(opts, req) -> first-run wizard flag (setting setup.completed)
// Package work runs through the agent like Software does: pkg.install is asked
// not to wait and its detached run is polled, so a long install never has to fit
// in one socket round trip.
export const STACK_INSTALL_JOB = 'stack.install';
const MAX_LOG_LINES = 2000;
const PKG_QUERY_CHUNK = 50;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createSystemStackService(ctx) {
  const { db, capabilities, settings, logger } = ctx;
  const accountCount = db.prepare('SELECT COUNT(*) AS n FROM accounts');
  const poll = { ms: 2000, maxMs: 10_000 };

  async function detectPkg() {
    try {
      const d = await ctx.software?.pkg?.detect?.();
      return { manager: d?.manager ?? null, family: d?.family ?? (d?.manager === 'apt' ? 'debian' : d?.manager ? 'rhel' : null) };
    } catch (err) {
      logger.warn({ err }, 'package manager detection failed');
      return { manager: null, family: null };
    }
  }

  async function presentPackages(names) {
    if (!names.length || !ctx.software?.pkg?.isInstalled) return null;
    const present = {};
    for (let i = 0; i < names.length; i += PKG_QUERY_CHUNK) Object.assign(present, await ctx.software.pkg.isInstalled(names.slice(i, i + PKG_QUERY_CHUNK)));
    return present;
  }

  // One package manager, one installer at a time: a second apt/dnf run would
  // only fail on the lock (or wait for the whole first job) while its
  // post-install steps interleaved with the first one's.
  function activeInstall() {
    return ['running', 'queued'].flatMap((status) => ctx.jobs.list({ status, limit: 50 })).find((j) => j.type === STACK_INSTALL_JOB || j.type.startsWith('software.pkg.')) || null;
  }
  const jobSummary = (j) => (j ? { id: j.id, type: j.type, status: j.status, progress: j.progress, message: j.message, created_at: j.created_at } : null);
  // list-unit-files names a template (clamd@.service), never its instances.
  const unitPresent = (set, name) => set.has(name) || (name.includes('@') && set.has(`${name.split('@')[0]}@`));

  async function status() {
    const snapshot = await capabilities.ensureFresh();
    const pkg = await detectPkg();
    let unitsPresent = new Set();
    try { unitsPresent = new Set(await ctx.agent.op('svc.list_units')); } catch (err) { logger.warn({ err }, 'could not list units for the stack status'); }
    let packagesPresent = null;
    if (pkg.family) {
      try { packagesPresent = await presentPackages([...new Set(STACK_COMPONENTS.flatMap((c) => c.packages[pkg.family]))]); } catch (err) { logger.warn({ err }, 'installed package query failed'); }
    }
    const components = STACK_COMPONENTS.map((c) => {
      const cap = c.capability ? snapshot.capabilities[c.capability] ?? null : null;
      const unit = c.units.find((u) => unitPresent(unitsPresent, u)) || null;
      const packages = pkg.family ? c.packages[pkg.family] : [];
      const packagesInstalled = packagesPresent && packages.length ? packages.every((p) => packagesPresent[p]) : null;
      return {
        key: c.key, label: c.label, description: c.description, capability: c.capability, service: c.service, recommended: c.recommended,
        requires: pkg.family ? c.requires?.[pkg.family] ?? null : null, packages, units: c.units, unit,
        installed: Boolean(cap?.installed) || Boolean(unit) || packagesInstalled === true,
        capabilityDetected: cap ? cap.installed : null, packagesInstalled, active: null, state: null,
      };
    });
    // Activity comes from the Service Manager rows so both pages agree.
    if (components.some((c) => c.installed && c.service)) {
      try {
        const rows = Object.fromEntries((await ctx.serviceManager.list()).map((s) => [s.name, s]));
        for (const c of components) {
          const s = c.service ? rows[c.service] : null;
          if (s && s.installed) { c.active = Boolean(s.active); c.state = s.state ?? null; }
        }
      } catch (err) { logger.warn({ err }, 'service status unavailable for the stack status'); }
    }
    const active = activeInstall();
    return {
      packageManager: pkg.manager, family: pkg.family, pkgAvailable: Boolean(pkg.manager),
      profiles: STACK_PROFILES.map((p) => ({ key: p.key, label: p.label, description: p.description, components: p.components })),
      components,
      installing: Boolean(active),
      activeJob: jobSummary(active),
      lastJob: ctx.jobs.list({ type: STACK_INSTALL_JOB, limit: 1 })[0] ?? null,
    };
  }

  function install({ components, profile } = {}, user, req) {
    const keys = profile ? profileComponents(profile) : components;
    if (profile && keys === null) throw unprocessable(`Unknown stack profile "${profile}"`);
    const unknown = (keys || []).filter((k) => !componentByKey(k));
    if (unknown.length) throw unprocessable(`Unknown stack component(s): ${unknown.join(', ')}`);
    const selection = [...new Set(keys || [])];
    if (!selection.length) throw unprocessable('Choose at least one component or a profile');
    if (!ctx.software?.pkg?.install) throw unprocessable('Package installation is not available on this panel');
    capabilities.require('pkg', 'No supported package manager (apt-get, dnf or yum) was found on this server; install the software by hand');
    const active = activeInstall();
    if (active) throw conflict(`A package installation (job ${active.id}, ${active.type}) is already ${active.status}; wait for it to finish before starting another`);
    const job = ctx.jobs.enqueue(STACK_INSTALL_JOB, { components: selection, profile: profile ?? null }, { userId: user?.id ?? null });
    req?.audit?.({ action: 'stack.install', target: selection.join(','), args: { profile: profile ?? null, components: selection, jobId: job.id } });
    return { job, components: selection };
  }

  function capabilityInstall(cap, user, req) {
    const component = componentForCapability(cap);
    if (!component) throw notFound(`An installable component for capability "${cap}"`);
    return { ...install({ components: [component.key] }, user, req), component: { key: component.key, label: component.label } };
  }

  function serviceInstall(name, user, req) {
    const component = componentForService(name);
    if (!component) throw notFound(`An installable component for service "${name}"`);
    return { ...install({ components: [component.key] }, user, req), component: { key: component.key, label: component.label } };
  }

  // Mirrors Software's detached-run polling: the installer runs on the host and
  // its output is streamed into the job log.
  async function runLongOp(job, opName, args, label) {
    const started = await job.agent.op(opName, { ...args, wait: false });
    if (!started.run) { for (const line of started.output || []) job.log(line); return started; }
    job.log(`${label}: running on the host (pid ${started.run.pid}, log ${started.run.logPath})`);
    let offset = 0; let delay = poll.ms; let logged = 0; let state;
    for (;;) {
      await sleep(delay);
      state = await job.agent.op('pkg.run.status', { id: started.run.id, offset });
      for (const line of state.output || []) {
        if (logged === MAX_LOG_LINES) job.log(`… output truncated after ${MAX_LOG_LINES} lines; the full log is ${started.run.logPath}`, 'warn');
        if (logged < MAX_LOG_LINES) job.log(line);
        logged += 1;
      }
      offset = state.offset;
      if (state.done) break;
      delay = Math.min(Math.round(delay * 1.5), poll.maxMs);
    }
    if (state.status === 'finished' && state.code === 0) return { ...started, run: state };
    const reason = state.status === 'finished' ? `exited with status ${state.code}` : state.error || state.status;
    throw new Error(`${label} ${reason}`);
  }

  // The RHEL family loads modules from conf.modules.d, so a freshly installed
  // mod_security or php.conf only takes effect once the running httpd reloads.
  async function reloadApache(job, component) {
    const { unit } = await job.agent.op('svc.resolve', { candidates: ['httpd', 'apache2'], fresh: true });
    if (!unit) return { reloaded: false, unit: null };
    const state = await job.agent.op('svc.status', { unit });
    if (!state.active) { job.log(`${component.label}: ${unit} is not running; the new modules load when it starts`); return { reloaded: false, unit }; }
    await job.agent.op('svc.reload', { unit });
    job.log(`${component.label}: ${unit} reloaded so the new modules are active`);
    return { reloaded: true, unit };
  }

  async function postInstall(job, component, step, family) {
    if (step.kind === 'a2enmod') {
      if (family !== 'debian') {
        job.log(`${component.label}: Apache modules load from conf.modules.d on this family; nothing to enable`);
        return { step: 'a2enmod', skipped: true, ...(await reloadApache(job, component)) };
      }
      const r = await job.agent.op('stack.apache_enmod', { modules: step.modules });
      if (r.skipped) job.log(`${component.label}: ${r.reason}`);
      else job.log(`${component.label}: Apache modules enabled ${r.enabled.join(', ') || '(none new)'}${r.alreadyEnabled.length ? `; already on: ${r.alreadyEnabled.join(', ')}` : ''}${r.failed.length ? `; failed: ${r.failed.map((f) => f.module).join(', ')}` : ''}${r.reloaded ? '; Apache reloaded' : ''}`);
      return { step: 'a2enmod', ...r };
    }
    if (step.kind === 'enable') {
      const candidates = step.unit ? [step.unit] : step.units?.length ? step.units : component.units;
      if (!candidates.length) return { step: 'enable', skipped: true };
      const { unit } = await job.agent.op('svc.resolve', { candidates, fresh: true });
      if (!unit) { job.log(`${component.label}: no systemd unit found among ${candidates.join(', ')}; nothing enabled`, 'warn'); return { step: 'enable', skipped: true, candidates }; }
      await job.agent.op('svc.enable', { unit });
      job.log(`${component.label}: ${unit} enabled and started`);
      return { step: 'enable', unit, ok: true };
    }
    if (step.kind === 'initdb') {
      const r = await job.agent.op('stack.postgres_initdb');
      job.log(`${component.label}: ${r.skipped ? r.reason : `database cluster initialised in ${r.dataDir}`}`);
      return { step: 'initdb', ...r };
    }
    return { step: step.kind, skipped: true };
  }

  async function installJob(job) {
    const keys = (job.params.components || []).map(componentByKey).filter(Boolean);
    if (!keys.length) throw new Error('No stack components selected');
    const detect = await job.agent.op('pkg.detect');
    const family = detect.family || (detect.manager === 'apt' ? 'debian' : detect.manager ? 'rhel' : null);
    if (!family) throw new CapabilityError('pkg', 'No supported package manager (apt-get, dnf or yum) is installed on this server');
    job.log(`package manager: ${detect.manager} (${family} family); installing ${keys.length} component(s): ${keys.map((c) => c.key).join(', ')}`);
    // A stale index makes apt fetch superseded package versions (404) and fail
    // every component; the refresh is best effort so an offline mirror does
    // not stop an install that the current index can still serve.
    job.progress(2, 'Refreshing the package index');
    try { await runLongOp(job, 'pkg.update_index', {}, 'package index refresh'); } catch (err) { job.log(`package index refresh failed: ${err.message}; installing against the current index`, 'warn'); }
    const results = [];
    for (const [i, component] of keys.entries()) {
      job.progress(Math.round((i / keys.length) * 90), `Installing ${component.label}`);
      job.log(`── ${component.label} ──`);
      const packages = component.packages[family];
      if (component.requires?.[family]) job.log(`note: ${component.requires[family]}`, 'warn');
      let missing = packages;
      try {
        const { packages: present } = await job.agent.op('pkg.list_installed', { prefix: packages });
        const set = new Set(present.map((p) => p.name));
        missing = packages.filter((p) => !set.has(p));
      } catch (err) { job.log(`could not read the installed package list (${err.message}); installing every package`, 'warn'); }
      if (!missing.length) job.log(`${component.label}: packages already installed (${packages.join(', ')})`);
      else {
        job.log(`${component.label}: installing ${missing.join(' ')}`);
        try { await runLongOp(job, 'pkg.install', { packages: missing }, `${component.label} install`); } catch (err) {
          job.log(`${component.label}: ${err.message}`, 'error');
          results.push({ key: component.key, ok: false, error: err.message, packages: missing });
          continue;
        }
      }
      const steps = [];
      for (const step of component.postInstall || []) {
        try { steps.push(await postInstall(job, component, step, family)); } catch (err) {
          job.log(`${component.label}: post-install step "${step.kind}" failed: ${err.message}`, 'warn');
          steps.push({ step: step.kind, ok: false, error: err.message });
        }
      }
      // A component that stands for a Service Manager row is not installed
      // until its daemon can be enabled: packages that leave no unit behind
      // (a CLI-only package, a renamed daemon package) are a failure to act
      // on, not a warning in the log.
      const enable = component.service ? steps.find((st) => st.step === 'enable' && (st.skipped || st.ok === false)) : null;
      if (enable) {
        const error = enable.error ? `the ${component.service} service could not be enabled: ${enable.error}` : `no systemd unit found among ${(enable.candidates || component.units).join(', ')} after installing ${packages.join(', ')}; the ${component.service} service cannot start`;
        job.log(`${component.label}: ${error}`, 'error');
        results.push({ key: component.key, ok: false, error, installed: missing, steps });
        continue;
      }
      results.push({ key: component.key, ok: true, installed: missing, steps });
    }
    job.progress(95, 'Refreshing capability detection');
    await capabilities.refresh();
    const failed = results.filter((r) => !r.ok);
    if (failed.length) job.log(`${failed.length} component(s) failed: ${failed.map((f) => f.key).join(', ')}`, 'error');
    if (failed.length === results.length) throw new Error(`No component could be installed: ${failed.map((f) => f.error).join('; ')}`);
    job.progress(100, failed.length ? 'finished with errors' : 'finished');
    return { manager: detect.manager, family, results, failed: failed.map((f) => f.key) };
  }

  const setup = {
    completed: () => settings.get('setup.completed') === true,
    // A server that already hosts accounts was set up before this flag existed;
    // the wizard only greets a fresh install.
    pending(user) {
      if (!isRoot(user)) return false;
      if (setup.completed()) return false;
      if (accountCount.get().n > 0) {
        settings.setMany({ 'setup.completed': true, 'setup.completed_at': new Date().toISOString(), 'setup.completed_reason': 'existing-install' });
        return false;
      }
      return true;
    },
    complete({ skipped = false } = {}, req) {
      settings.setMany({ 'setup.completed': true, 'setup.completed_at': new Date().toISOString(), 'setup.completed_reason': skipped ? 'skipped' : 'wizard' });
      req?.audit?.({ action: 'setup.complete', args: { skipped } });
      return { completed: true, skipped };
    },
  };

  return { status, install, capabilityInstall, serviceInstall, installJob, setup, catalog: () => STACK_COMPONENTS, profiles: () => STACK_PROFILES };
}
