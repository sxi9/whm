// Sidebar definitions per portal area. Paths are the router paths in
// ../router.jsx; `end` marks index routes so "Dashboard" is not active everywhere.
export const ADMIN_NAV = [
  { title: 'Licensing', items: [
    { to: '/admin', label: 'Dashboard', end: true },
    { to: '/admin/licenses', label: 'Licenses' },
    { to: '/admin/customers', label: 'Customers' },
    { to: '/admin/resellers', label: 'Resellers' },
    { to: '/admin/products', label: 'Products' },
    { to: '/admin/trials', label: 'Trials' },
    { to: '/admin/integrations', label: 'Integrations' },
    { to: '/admin/reports', label: 'Reports' },
    { to: '/admin/audit', label: 'Audit log' },
  ] },
  { title: 'Marketplace', items: [
    { to: '/admin/market/verifications', label: 'Verification queue' },
    { to: '/admin/market/developers', label: 'Developers' },
    { to: '/admin/market/reviews', label: 'Review queue' },
    { to: '/admin/market/catalog', label: 'Catalog' },
    { to: '/admin/market/revocations', label: 'Revocations' },
    { to: '/admin/market/entitlements', label: 'Entitlements & purchases' },
    { to: '/admin/market/payouts', label: 'Payouts' },
    { to: '/admin/market/plugin-reviews', label: 'Review moderation' },
    { to: '/admin/signing-keys', label: 'Signing keys' },
  ] },
];

export const RESELLER_NAV = [
  { title: 'Reseller', items: [
    { to: '/reseller', label: 'Dashboard', end: true },
    { to: '/reseller/licenses', label: 'My licenses' },
    { to: '/reseller/customers', label: 'My customers' },
    { to: '/reseller/activations', label: 'Activations' },
    { to: '/reseller/api-keys', label: 'API keys & webhooks' },
    { to: '/reseller/statement', label: 'Statement' },
  ] },
];

export const DEV_NAV = [
  { title: 'Account', items: [
    { to: '/dev', label: 'Profile', end: true },
    { to: '/dev/security', label: 'Security & 2FA' },
    { to: '/dev/verification', label: 'Verification' },
    { to: '/dev/keys', label: 'Signing keys' },
  ] },
  { title: 'Publishing', items: [
    { to: '/dev/plugins', label: 'Plugins' },
    { to: '/dev/upload', label: 'Upload a version' },
    { to: '/dev/stats', label: 'Stats' },
    { to: '/dev/payouts', label: 'Payouts' },
  ] },
  { title: 'Integration', items: [
    { to: '/dev/api-keys', label: 'API keys' },
    { to: '/dev/webhooks', label: 'Webhooks' },
  ] },
];

export const NAV_BY_AREA = { admin: ADMIN_NAV, reseller: RESELLER_NAV, dev: DEV_NAV };
export const AREA_LABELS = { admin: 'Vendor admin', reseller: 'Reseller portal', dev: 'Developer portal' };
