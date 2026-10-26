'use strict';

// ImunifyAV: the vendor CLI is the scanner of record when it is installed;
// otherwise clamscan runs over account home directories as a plugin job
// (manual or on the cron setting). Findings of both scanners are kept in the
// "findings" collection, scan runs in "scans".

const MAX_FINDINGS = 5000;
const MAX_SCANS = 200;
const VENDOR = {
  url: 'https://docs.imunify360.com/imunifyav/',
  steps: [
    'wget https://repo.imunify360.cloudlinux.com/defence360/imav-deploy.sh -O imav-deploy.sh',
    'bash imav-deploy.sh',
    'imunify-antivirus version',
  ],
  clamav: ['apt-get install clamav clamav-freshclam   # Debian/Ubuntu', 'dnf install clamav clamav-update          # RHEL/Alma/Rocky', 'freshclam'],
};

const isCapabilityError = (err) => err && (err.status === 501 || err.code === 'CAPABILITY_MISSING' || err.code === 'BINARY_NOT_FOUND');

async function detect(ctx) {
  const out = { imunify: { installed: false, version: null }, clamav: { installed: false, version: null, signatures: null, databaseAgeSec: null, freshclam: false }, errors: {} };
  try { out.imunify = await ctx.agent.op('sec.imunify.detect', {}); } catch (err) { out.errors.imunify = err.message; }
  try { out.clamav = await ctx.agent.op('sec.clamav.detect', {}); } catch (err) { out.errors.clamav = err.message; }
  const settings = await ctx.settings.getAll();
  out.scanner = out.imunify?.installed ? 'imunifyav' : out.clamav?.installed && settings.fallbackEnabled !== false ? 'clamav' : null;
  return out;
}

function capabilityError(ctx, scanner) {
  const E = ctx.errors;
  return new E.PluginError(scanner === 'clamav' ? 'ClamAV (clamscan) is not installed on this server' : 'No malware scanner is installed: install ImunifyAV, or ClamAV for the fallback scan', { code: 'CAPABILITY_MISSING', status: 501, details: { install: VENDOR } });
}

async function recordFindings(ctx, scanner, scanId, items) {
  const findings = ctx.store.collection('findings');
  for (const f of items) await findings.insert({ at: ctx.now(), scanner, scanId, username: f.username ?? null, file: f.file, signature: f.signature });
  const total = await findings.count();
  if (total > MAX_FINDINGS) {
    const old = await findings.find({}, { sort: { at: 1 }, limit: total - MAX_FINDINGS });
    for (const o of old) await findings.remove({ id: o.id });
  }
}

async function notifyFindings(ctx, scanner, count, accounts) {
  const settings = await ctx.settings.getAll();
  if (settings.notifyOnFindings === false || count === 0) return false;
  try {
    await ctx.api.contacts.notify({ event: 'net.whm.imunifyav.findings', severity: 'critical', subject: `${count} infected file${count === 1 ? '' : 's'} found by ${scanner}`, body: `The ${scanner} scan found ${count} infected file${count === 1 ? '' : 's'}${accounts.length ? ` in the accounts ${accounts.join(', ')}` : ''}. Review them under Plugins › ImunifyAV.` });
    return true;
  } catch (err) {
    ctx.log.warn('findings notification could not be delivered', { error: err.message });
    return false;
  }
}

function ownerOf(file) {
  const m = /^\/home\d*\/([a-z][a-z0-9_-]{0,31})\//.exec(String(file || ''));
  return m ? m[1] : null;
}

module.exports = {
  async activate(ctx) {
    ctx.log.info('ImunifyAV plugin active', { version: ctx.plugin.version });
  },

  jobs: {
    async clamscan(job, ctx) {
      const settings = await ctx.settings.getAll();
      const d = await detect(ctx);
      if (d.imunify.installed && !job.params.force) { job.log('ImunifyAV is installed and keeps its own schedule; the ClamAV fallback is skipped'); return { skipped: true, reason: 'imunifyav-installed' }; }
      if (!d.clamav.installed) throw capabilityError(ctx, 'clamav');
      if (settings.fallbackEnabled === false && job.params.trigger !== 'manual') { job.log('ClamAV fallback is disabled in the settings'); return { skipped: true, reason: 'fallback-disabled' }; }
      const wanted = Array.isArray(job.params.usernames) && job.params.usernames.length ? job.params.usernames : null;
      const page = await ctx.api.accounts.list({ pageSize: 500 });
      const usernames = page.data.map((a) => a.username).filter((u) => !wanted || wanted.includes(u));
      const scans = ctx.store.collection('scans');
      const started = ctx.now();
      const scan = await scans.insert({ scanner: 'clamav', startedAt: started, finishedAt: null, status: 'running', accounts: usernames.length, infected: 0, errors: 0, trigger: job.params.trigger || 'manual' });
      job.log(`scanning ${usernames.length} account home director${usernames.length === 1 ? 'y' : 'ies'} with clamscan`);
      const infected = [];
      let errors = 0;
      let scanned = 0;
      try {
        for (const username of usernames) {
          if (job.cancelled || job.signal.aborted) throw new ctx.errors.PluginError('scan cancelled', { code: 'JOB_CANCELLED', status: 409 });
          job.progress(Math.round((scanned / Math.max(1, usernames.length)) * 100), username);
          const r = await ctx.agent.op('sec.clamav.scan', { usernames: [username], maxFileMb: settings.maxFileMb || 25 });
          scanned++;
          errors += (r.errors || []).length;
          for (const f of r.infected || []) { infected.push({ ...f, username }); job.log(`INFECTED ${f.file}: ${f.signature}`); }
        }
      } catch (err) {
        await scans.update({ id: scan.id }, { finishedAt: ctx.now(), status: err.code === 'JOB_CANCELLED' ? 'cancelled' : 'failed', infected: infected.length, errors, error: err.message });
        if (infected.length) await recordFindings(ctx, 'clamav', scan.id, infected);
        throw err;
      }
      await recordFindings(ctx, 'clamav', scan.id, infected);
      await scans.update({ id: scan.id }, { finishedAt: ctx.now(), status: 'done', infected: infected.length, errors });
      const total = await scans.count();
      if (total > MAX_SCANS) for (const o of await scans.find({}, { sort: { startedAt: 1 }, limit: total - MAX_SCANS })) await scans.remove({ id: o.id });
      await ctx.store.set('lastScan', { scanner: 'clamav', at: started, infected: infected.length, accounts: usernames.length });
      const notified = await notifyFindings(ctx, 'ClamAV', infected.length, [...new Set(infected.map((f) => f.username))]);
      await ctx.api.audit.record({ action: 'scan.clamav', target: wanted ? wanted.join(',') : 'all-accounts', details: { accounts: usernames.length, infected: infected.length, errors } });
      job.progress(100, 'finished');
      return { scanner: 'clamav', accounts: usernames.length, infected: infected.length, errors, notified, scanId: scan.id };
    },
  },

  routes(http, ctx) {
    http.get('/status', async (req, res) => {
      const d = await detect(ctx);
      let status = null;
      if (d.imunify.installed) { try { status = await ctx.agent.op('sec.imunify.status', {}); } catch (err) { d.errors.status = err.message; } }
      const lastScan = await ctx.store.get('lastScan');
      const running = (await ctx.store.collection('scans').find({ status: 'running' }, { sort: { startedAt: -1 }, limit: 1 }))[0] || null;
      res.json({ ...d, imunifyStatus: status, lastScan: lastScan || null, running, install: VENDOR, findings: await ctx.store.collection('findings').count() });
    });

    http.post('/scan', async (req, res) => {
      const body = req.body || {};
      const d = await detect(ctx);
      if (d.imunify.installed && body.scanner !== 'clamav') {
        const target = typeof body.path === 'string' && body.path ? body.path : '/home';
        const r = await ctx.agent.op('sec.imunify.scan', { path: target });
        await ctx.api.audit.record({ action: 'scan.imunify', target, details: { by: req.user.username } });
        await ctx.store.set('lastScan', { scanner: 'imunifyav', at: ctx.now(), path: target });
        res.status(202).json({ scanner: 'imunifyav', started: true, path: target, result: r.result ?? null });
        return;
      }
      if (!d.clamav.installed) throw capabilityError(ctx, d.imunify.installed ? 'clamav' : null);
      const usernames = Array.isArray(body.usernames) ? body.usernames.filter((u) => typeof u === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(u)) : [];
      const jobId = await ctx.jobs.run('clamscan', { usernames, force: true, trigger: 'manual' });
      res.status(202).json({ scanner: 'clamav', jobId });
    });

    http.get('/results', async (req, res) => {
      const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
      const d = await detect(ctx);
      if (d.imunify.installed) {
        const r = await ctx.agent.op('sec.imunify.results', { limit });
        res.json({ scanner: 'imunifyav', total: r.total ?? r.items.length, items: r.items.map((i) => ({ ...i, username: i.user || ownerOf(i.file) })) });
        return;
      }
      const rows = await ctx.store.collection('findings').find({}, { sort: { at: -1 }, limit });
      res.json({ scanner: 'clamav', total: await ctx.store.collection('findings').count(), items: rows.map((f) => ({ id: f.id, file: f.file, signature: f.signature, username: f.username, detected: f.at, status: 'found', quarantined: false })) });
    });

    http.get('/quarantine', async (req, res) => {
      const d = await detect(ctx);
      if (!d.imunify.installed) { res.json({ scanner: d.scanner, items: [], note: 'Quarantine requires ImunifyAV; the ClamAV fallback only reports infected files.' }); return; }
      const r = await ctx.agent.op('sec.imunify.quarantine', { limit: 200 });
      res.json({ scanner: 'imunifyav', items: r.items });
    });

    http.get('/scans', async (req, res) => {
      res.json(await ctx.store.collection('scans').find({}, { sort: { startedAt: -1 }, limit: 50 }));
    });

    http.get('/findings', async (req, res) => {
      const rows = await ctx.store.collection('findings').find({}, { sort: { at: -1 }, limit: 500 });
      res.json(rows.map((f) => ({ id: f.id, at: new Date(f.at).toISOString(), scanner: f.scanner, username: f.username, file: f.file, signature: f.signature })));
    });

    http.delete('/findings', async (req, res) => {
      const n = await ctx.store.collection('findings').remove({});
      await ctx.api.audit.record({ action: 'findings.clear', target: 'all', details: { removed: n, by: req.user.username } });
      res.json({ removed: n });
    });
  },
};

module.exports.__test = { detect, ownerOf, VENDOR };
