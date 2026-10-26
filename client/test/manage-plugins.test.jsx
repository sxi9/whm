import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../src/components/Toast.jsx';
import { ConfirmProvider } from '../src/components/Modal.jsx';
import { PluginNavContext } from '../src/hooks/usePluginNav.js';
import { FUNCTION_BY_KEY } from '../src/nav.js';
import ManagePlugins, { TrustNotice, SignaturePolicy } from '../src/pages/fn/cpanel/manage-plugins.jsx';

React.useLayoutEffect = React.useEffect;

const nav = { plugins: [], entries: [], loading: false, error: null, reload() {} };
const render = (el) => renderToStaticMarkup(
  <PluginNavContext.Provider value={nav}>
    <ToastProvider><ConfirmProvider><MemoryRouter>{el}</MemoryRouter></ConfirmProvider></ToastProvider>
  </PluginNavContext.Provider>,
);

describe('Manage Plugins page', () => {
  it('is registered for the cPanel › Manage Plugins function and renders its sections', () => {
    const fn = FUNCTION_BY_KEY['cpanel/manage-plugins'];
    expect(fn).toBeTruthy();
    const html = render(<ManagePlugins fn={fn} />);
    expect(html).toContain('Manage Plugins');
    expect(html).toContain('Plugins run inside the panel process');
    expect(html).toContain('Signature policy');
    expect(html).toContain('Install a plugin');
    expect(html).toContain('Installed plugins');
  });

  it('warns while unsigned packages are accepted and not once signatures are required', () => {
    expect(render(<SignaturePolicy required={false} onChange={() => {}} />)).toContain('Unsigned packages are accepted');
    expect(render(<SignaturePolicy required onChange={() => {}} />)).not.toContain('Unsigned packages are accepted');
    expect(render(<TrustNotice />)).toContain('not a security boundary');
  });
});
