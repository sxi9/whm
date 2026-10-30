import { describe, it, expect, vi, afterAll, beforeEach } from 'vitest';
import React from 'react';

// Error boundaries never run during static (server) rendering, so the
// boundary is exercised through react-dom/client against a DOM just large
// enough for React's host config: nodes, attributes, styles, text and the
// root's event listeners (jsdom is not a client dependency). The globals are
// installed before react-dom evaluates, as it probes `window` at load time.
const dom = vi.hoisted(() => {
  const listeners = (node) => {
    node.listeners = [];
    node.addEventListener = (type, fn, opts) => node.listeners.push({ type, fn, capture: opts === true || Boolean(opts?.capture) });
    node.removeEventListener = (type, fn) => { node.listeners = node.listeners.filter((l) => !(l.type === type && l.fn === fn)); };
    return node;
  };
  class MiniNode {
    constructor(doc, nodeType, nodeName) { this.ownerDocument = doc; this.nodeType = nodeType; this.nodeName = nodeName; this.parentNode = null; this.childNodes = []; listeners(this); }
    get firstChild() { return this.childNodes[0] || null; }
    get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
    get nextSibling() { const p = this.parentNode; return p ? p.childNodes[p.childNodes.indexOf(this) + 1] || null : null; }
    appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.childNodes.push(c); return c; }
    insertBefore(c, ref) { if (!ref) return this.appendChild(c); if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.childNodes.splice(this.childNodes.indexOf(ref), 0, c); return c; }
    removeChild(c) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); c.parentNode = null; return c; }
    contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
    get textContent() { return this.nodeType === 3 ? this.nodeValue : this.childNodes.map((c) => c.textContent).join(''); }
    set textContent(v) {
      if (this.nodeType === 3) { this.nodeValue = String(v); return; }
      for (const c of this.childNodes) c.parentNode = null;
      this.childNodes = [];
      if (v) this.appendChild(this.ownerDocument.createTextNode(v));
    }
  }
  class MiniElement extends MiniNode {
    constructor(doc, tag) { super(doc, 1, tag.toUpperCase()); this.tagName = tag.toUpperCase(); this.localName = tag; this.attributes = new Map(); this.style = { setProperty(k, v) { this[k] = v; } }; this.namespaceURI = 'http://www.w3.org/1999/xhtml'; }
    setAttribute(k, v) { this.attributes.set(k, String(v)); }
    setAttributeNS(_ns, k, v) { this.attributes.set(k, String(v)); }
    getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
    hasAttribute(k) { return this.attributes.has(k); }
    removeAttribute(k) { this.attributes.delete(k); }
    get innerHTML() { return this.childNodes.map((c) => (c.nodeType === 3 ? c.nodeValue : c.outerHTML)).join(''); }
    get outerHTML() { const attrs = [...this.attributes].map(([k, v]) => ` ${k}="${v}"`).join(''); return `<${this.localName}${attrs}>${this.innerHTML}</${this.localName}>`; }
    querySelectorAll(tag) { const out = []; const walk = (n) => { for (const c of n.childNodes) if (c.nodeType === 1) { if (c.localName === tag) out.push(c); walk(c); } }; walk(this); return out; }
  }
  class MiniText extends MiniNode { constructor(doc, v) { super(doc, 3, '#text'); this.nodeValue = String(v); } }
  const document = listeners({ nodeType: 9, nodeName: '#document' });
  document.createElement = (tag) => new MiniElement(document, tag);
  document.createElementNS = (_ns, tag) => new MiniElement(document, tag);
  document.createTextNode = (v) => new MiniText(document, v);
  document.documentElement = document.createElement('html');
  document.body = document.createElement('body');
  document.documentElement.appendChild(document.body);
  document.activeElement = document.body;
  const window = listeners({ document, HTMLIFrameElement: function HTMLIFrameElement() {}, navigator: { userAgent: 'node' }, reloads: 0 });
  window.location = { reload() { window.reloads += 1; } };
  document.defaultView = window;
  globalThis.window = window;
  globalThis.document = document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  return { window, document };
});

const { createRoot } = await import('react-dom/client');
const { ErrorBoundary, ErrorFallback, errorText } = await import('../src/components/ErrorBoundary.jsx');
const { act } = React;

afterAll(() => { delete globalThis.window; delete globalThis.document; delete globalThis.IS_REACT_ACT_ENVIRONMENT; });

// Events reach React through the listeners it registered on the root
// container (React 17+ delegates there), so a click is a plain dispatch to
// the bubble-phase listener with the button as the target.
function click(container, node) {
  const bubble = container.listeners.filter((l) => l.type === 'click' && !l.capture);
  expect(bubble.length).toBeGreaterThan(0);
  act(() => { for (const l of bubble) l.fn({ type: 'click', target: node, timeStamp: Date.now(), button: 0, bubbles: true }); });
}

function mount(element) {
  const container = dom.document.createElement('div');
  dom.document.body.appendChild(container);
  const root = createRoot(container);
  act(() => { root.render(element); });
  return { container, root, rerender: (el) => act(() => { root.render(el); }), unmount: () => act(() => { root.unmount(); }) };
}

const state = { explode: true };
function Flaky() {
  if (state.explode) throw new Error('boom: cannot read properties of undefined');
  return <p className="recovered">page content</p>;
}

let consoleError;
beforeEach(() => { state.explode = true; consoleError = vi.spyOn(console, 'error').mockImplementation(() => {}); });

describe('ErrorBoundary', () => {
  it('catches a throwing child and shows the message with a Reload button while siblings keep rendering', () => {
    const onError = vi.fn();
    const { container, unmount } = mount(<div><h1 className="shell">WHM shell</h1><ErrorBoundary onError={onError}><Flaky /></ErrorBoundary></div>);
    const html = container.innerHTML;
    expect(html).toContain('WHM shell');
    expect(html).toContain('role="alert"');
    expect(html).toContain('This page failed to render');
    expect(html).toContain('boom: cannot read properties of undefined');
    expect(html).toContain('>Reload</button>');
    expect(html).not.toContain('page content');
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].message).toMatch(/^boom/);
    expect(onError.mock.calls[0][1].componentStack).toContain('Flaky');
    unmount();
    consoleError.mockRestore();
  });

  it('logs through console.error when no onError handler is given', () => {
    const { unmount } = mount(<ErrorBoundary><Flaky /></ErrorBoundary>);
    expect(consoleError.mock.calls.some((c) => c[0] === 'Page render failed')).toBe(true);
    unmount();
    consoleError.mockRestore();
  });

  it('Reload calls the injected handler, defaulting to window.location.reload()', () => {
    const onReload = vi.fn();
    const first = mount(<ErrorBoundary onReload={onReload}><Flaky /></ErrorBoundary>);
    click(first.container, first.container.querySelectorAll('button')[0]);
    expect(onReload).toHaveBeenCalledTimes(1);
    first.unmount();
    const second = mount(<ErrorBoundary><Flaky /></ErrorBoundary>);
    const before = dom.window.reloads;
    click(second.container, second.container.querySelectorAll('button')[0]);
    expect(dom.window.reloads).toBe(before + 1);
    second.unmount();
    consoleError.mockRestore();
  });

  it('"Try again" re-renders the children once the cause is gone', () => {
    const { container, unmount } = mount(<ErrorBoundary><Flaky /></ErrorBoundary>);
    expect(container.innerHTML).toContain('Try again');
    state.explode = false;
    click(container, container.querySelectorAll('button')[1]);
    expect(container.innerHTML).toContain('page content');
    expect(container.innerHTML).not.toContain('role="alert"');
    unmount();
    consoleError.mockRestore();
  });

  it('a new key (the shell uses the pathname) gives the next page a fresh boundary', () => {
    const { container, rerender, unmount } = mount(<ErrorBoundary key="/a"><Flaky /></ErrorBoundary>);
    expect(container.innerHTML).toContain('role="alert"');
    state.explode = false;
    rerender(<ErrorBoundary key="/b"><Flaky /></ErrorBoundary>);
    expect(container.innerHTML).toContain('page content');
    unmount();
    consoleError.mockRestore();
  });

  it('errorText and the fallback cope with non-Error values', () => {
    expect(errorText(null)).toBe('Unknown error');
    expect(errorText('plain string')).toBe('plain string');
    expect(errorText(new Error('typed'))).toBe('typed');
    expect(errorText({ toString: () => 'object-ish' })).toBe('object-ish');
    const { container, unmount } = mount(<ErrorFallback error="static failure" title="Custom title" />);
    expect(container.innerHTML).toContain('Custom title');
    expect(container.innerHTML).toContain('static failure');
    expect(container.innerHTML).not.toContain('Try again');
    unmount();
    consoleError.mockRestore();
  });
});
