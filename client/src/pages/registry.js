import { lazy } from 'react';

// Pages are discovered from client/src/pages/fn/<category-slug>/<function-slug>.jsx —
// the file path IS the function key from nav.js, so adding a page never edits this
// file. Each page default-exports a component that receives { fn }.
// (test/nav.test.js checks every discovered key exists in nav.js.)
const discovered = import.meta.glob('./fn/*/*.jsx');
const AUTO = Object.fromEntries(Object.entries(discovered).map(([file, loader]) => {
  const m = file.match(/^\.\/fn\/([^/]+)\/([^/]+)\.jsx$/);
  return [`${m[1]}/${m[2]}`, lazy(loader)];
}));

// Pages built before the fn/ convention existed. New pages go in fn/ instead.
const LEGACY = {
  'account-information/list-accounts': lazy(() => import('./accounts/ListAccounts.jsx')),
  'account-information/list-suspended-accounts': lazy(() => import('./accounts/ListSuspendedAccounts.jsx')),
  'account-functions/create-a-new-account': lazy(() => import('./accounts/CreateAccount.jsx')),
  'account-functions/modify-an-account': lazy(() => import('./accounts/ModifyAccount.jsx')),
  'account-functions/manage-account-suspension': lazy(() => import('./accounts/ManageSuspension.jsx')),
  'account-functions/password-modification': lazy(() => import('./accounts/PasswordModification.jsx')),
  'account-functions/terminate-accounts': lazy(() => import('./accounts/TerminateAccounts.jsx')),
  'account-functions/upgrade-downgrade-an-account': lazy(() => import('./accounts/UpgradeDowngrade.jsx')),
  'packages/add-a-package': lazy(() => import('./packages/AddPackage.jsx')),
  'packages/edit-a-package': lazy(() => import('./packages/EditPackage.jsx')),
  'packages/delete-a-package': lazy(() => import('./packages/DeletePackage.jsx')),
  'packages/feature-manager': lazy(() => import('./packages/FeatureManager.jsx')),
  'server-status/server-information': lazy(() => import('./server/ServerInformation.jsx')),
  'server-status/service-status': lazy(() => import('./server/ServiceStatus.jsx')),
  'server-status/task-queue-monitor': lazy(() => import('./server/TaskQueueMonitor.jsx')),
  'service-configuration/service-manager': lazy(() => import('./server/ServiceManager.jsx')),
  'restart-services/database-server': lazy(() => import('./server/RestartService.jsx')),
  'restart-services/dns-server': lazy(() => import('./server/RestartService.jsx')),
  'restart-services/http-server-apache': lazy(() => import('./server/RestartService.jsx')),
  'restart-services/imap-server': lazy(() => import('./server/RestartService.jsx')),
  'restart-services/mail-server-exim': lazy(() => import('./server/RestartService.jsx')),
  'restart-services/mailing-list-manager-mailman': lazy(() => import('./server/RestartService.jsx')),
  'restart-services/php-fpm-service-for-apache': lazy(() => import('./server/RestartService.jsx')),
  'restart-services/ssh-server-openssh': lazy(() => import('./server/RestartService.jsx')),
  'server-configuration/basic-webhost-manager-setup': lazy(() => import('./server-configuration/BasicSetup.jsx')),
  'server-configuration/tweak-settings': lazy(() => import('./server-configuration/TweakSettings.jsx')),
  'server-configuration/configure-cpanel-cron-jobs': lazy(() => import('./server-configuration/CronJobs.jsx')),
  'server-configuration/change-root-password': lazy(() => import('./server-configuration/ChangeRootPassword.jsx')),
  'security-center/two-factor-authentication': lazy(() => import('./security/TwoFactor.jsx')),
};

export const PAGE_REGISTRY = { ...LEGACY, ...AUTO };
