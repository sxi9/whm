// Human descriptions for plugin permission scopes, mirroring PERMISSIONS in
// plugins/sdk/validate-manifest.js (the SDK is CommonJS and is not bundled into
// the client). Keep both lists in step.
export const PERMISSION_DESCRIPTIONS = {
  'accounts:read': 'Read hosting accounts (ctx.api.accounts.list / get)',
  'accounts:write': 'Suspend / unsuspend accounts and cancel pre-stage account hooks',
  'packages:read': 'Read hosting packages (ctx.api.packages.list)',
  'dns:read': 'Read DNS zones and records (ctx.api.dns.zones.*)',
  'backups:read': 'List and verify backup artefacts and destinations',
  'backups:write': 'Create, upload and delete backup artefacts',
  'backups:restore': 'Restore a backup artefact over an account (admin confirm token required)',
  'settings:own': "Read and write the plugin's own settings (ctx.settings)",
  'store:own': "Read and write the plugin's own key/value store and collections (ctx.store)",
  schedule: "Register cron schedules for the plugin's jobs (ctx.schedule)",
  jobs: 'Run background jobs and query their status (ctx.jobs)',
  'events:emit': "Emit events in the plugin's own namespace (ctx.events.emit)",
  'ui:sidebar': 'Add entries to the WHM sidebar and register UI pages (ctx.ui)',
  'api:routes': 'Expose HTTP routes under /api/plugins/<id>/ (ctx.http)',
  'contacts:notify': 'Send notifications through the Contact Manager (ctx.api.contacts.notify)',
  'system:read': 'Read host/system information and service status (ctx.api.system / services)',
  'audit:write': 'Write entries to the panel audit log (ctx.api.audit.record)',
  'crypto:own': 'Encrypt / decrypt with a plugin-scoped key, hashes and random tokens (ctx.crypto)',
  'fs:own': 'Read and write files inside the plugin data directory (ctx.fs)',
};

// Scopes that reach outside the plugin: flagged so reviewers look twice.
const SENSITIVE = /^(accounts:write|backups:(write|restore)|agent:op:|net:outbound:)/;

export function describePermission(scope) {
  if (PERMISSION_DESCRIPTIONS[scope]) return { text: PERMISSION_DESCRIPTIONS[scope], sensitive: SENSITIVE.test(scope) };
  const op = /^agent:op:(.+)$/.exec(scope);
  if (op) return { text: `Run the privileged agent operation "${op[1]}" as root (ctx.agent.op)`, sensitive: true };
  const net = /^net:outbound:(.+)$/.exec(scope);
  if (net) return { text: `Make outbound HTTPS requests to ${net[1]} (ctx.net.fetch)`, sensitive: true };
  return { text: 'Unknown scope (not in the SDK catalog)', sensitive: true };
}
