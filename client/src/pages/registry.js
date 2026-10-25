import { lazy } from 'react';

// Maps a function key ("<category-slug>/<function-slug>") to its page component.
// Functions not listed here render the generic FunctionPage. Keys must match
// nav.js exactly — the build-time check in test/nav.test.js enforces it.
export const PAGE_REGISTRY = {
  // Account Information / Account Functions
  'account-information/list-accounts': lazy(() => import('./accounts/ListAccounts.jsx')),
  'account-information/list-suspended-accounts': lazy(() => import('./accounts/ListSuspendedAccounts.jsx')),
  'account-functions/create-a-new-account': lazy(() => import('./accounts/CreateAccount.jsx')),
  'account-functions/modify-an-account': lazy(() => import('./accounts/ModifyAccount.jsx')),
  'account-functions/manage-account-suspension': lazy(() => import('./accounts/ManageSuspension.jsx')),
  'account-functions/password-modification': lazy(() => import('./accounts/PasswordModification.jsx')),
  'account-functions/terminate-accounts': lazy(() => import('./accounts/TerminateAccounts.jsx')),
  'account-functions/upgrade-downgrade-an-account': lazy(() => import('./accounts/UpgradeDowngrade.jsx')),

  // Packages
  'packages/add-a-package': lazy(() => import('./packages/AddPackage.jsx')),
  'packages/edit-a-package': lazy(() => import('./packages/EditPackage.jsx')),
  'packages/delete-a-package': lazy(() => import('./packages/DeletePackage.jsx')),
  'packages/feature-manager': lazy(() => import('./packages/FeatureManager.jsx')),

  // Server Status / System Health / Service Configuration
  'server-status/server-information': lazy(() => import('./server/ServerInformation.jsx')),
  'server-status/service-status': lazy(() => import('./server/ServiceStatus.jsx')),
  'server-status/task-queue-monitor': lazy(() => import('./server/TaskQueueMonitor.jsx')),
  'service-configuration/service-manager': lazy(() => import('./server/ServiceManager.jsx')),
  'system-health/show-current-running-processes': lazy(() => import('./server/RunningProcesses.jsx')),
  'system-health/process-manager': lazy(() => import('./server/ProcessManager.jsx')),
  'system-health/show-current-disk-usage': lazy(() => import('./server/DiskUsage.jsx')),

  // Restart Services (all eight share one component parameterised by the route)
  'restart-services/database-server': lazy(() => import('./server/RestartService.jsx')),
  'restart-services/dns-server': lazy(() => import('./server/RestartService.jsx')),
  'restart-services/http-server-apache': lazy(() => import('./server/RestartService.jsx')),
  'restart-services/imap-server': lazy(() => import('./server/RestartService.jsx')),
  'restart-services/mail-server-exim': lazy(() => import('./server/RestartService.jsx')),
  'restart-services/mailing-list-manager-mailman': lazy(() => import('./server/RestartService.jsx')),
  'restart-services/php-fpm-service-for-apache': lazy(() => import('./server/RestartService.jsx')),
  'restart-services/ssh-server-openssh': lazy(() => import('./server/RestartService.jsx')),

  // Server Configuration / Security
  'server-configuration/basic-webhost-manager-setup': lazy(() => import('./server-configuration/BasicSetup.jsx')),
  'server-configuration/tweak-settings': lazy(() => import('./server-configuration/TweakSettings.jsx')),
  'server-configuration/configure-cpanel-cron-jobs': lazy(() => import('./server-configuration/CronJobs.jsx')),
  'server-configuration/change-root-password': lazy(() => import('./server-configuration/ChangeRootPassword.jsx')),
  'security-center/two-factor-authentication': lazy(() => import('./security/TwoFactor.jsx')),
};
