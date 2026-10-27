'use strict';

/**
 * WHM Plugin SDK — public entry point (zero dependencies).
 *
 *   const sdk = require('whm/plugins/sdk');
 *   sdk.validateManifest(require('./plugin.json'));
 *   const host = sdk.createMockHost({ manifest });
 */

const validate = require('./validate-manifest');
const errors = require('./errors');
const { createMockHost, MOCK_MASTER_KEY, MAX_STORE_VALUE_BYTES, MAX_FS_BYTES } = require('./mock-host');
const semver = require('./semver');
const cron = require('./cron');

module.exports = {
  ...validate,
  ...errors,
  createMockHost,
  MOCK_MASTER_KEY,
  MAX_STORE_VALUE_BYTES,
  MAX_FS_BYTES,
  semver,
  cron,
  SDK_VERSION: '1.0.0',
};

// `pack` is the build-time packer (node:fs backed: it reads and writes arbitrary
// directories). It is reachable as `require('plugins/sdk').pack` for tooling,
// but it is deliberately not enumerable: the panel hands plugins a frozen copy
// of the enumerable exports (`{ ...sdk.index }`), so a sandboxed plugin never
// receives a filesystem escape through `require('whm/plugins/sdk')`.
Object.defineProperty(module.exports, 'pack', {
  enumerable: false,
  configurable: false,
  get: () => require('./pack'),
});
