import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { uiDistDir } from '../src/app.js';

test('uiDistDir honours hub.conf ui_dist, lets WHM_HUB_UI_DIST override it and falls back to the shipped build', () => {
  const saved = process.env.WHM_HUB_UI_DIST;
  delete process.env.WHM_HUB_UI_DIST;
  try {
    assert.equal(uiDistDir({ ui_dist: '/srv/hub-ui' }), '/srv/hub-ui');
    assert.ok(uiDistDir({}).endsWith(path.join('hub', 'ui', 'dist')));
    process.env.WHM_HUB_UI_DIST = '/opt/hub-ui-override';
    assert.equal(uiDistDir({ ui_dist: '/srv/hub-ui' }), '/opt/hub-ui-override');
  } finally {
    if (saved === undefined) delete process.env.WHM_HUB_UI_DIST; else process.env.WHM_HUB_UI_DIST = saved;
  }
});
