// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { act } = React;

vi.mock('../src/auth/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 1, username: 'root', role: 'root' }, hostname: 'srv1.example', ready: true, logout: async () => {} }) }));
vi.mock('../src/hooks/usePluginNav.js', () => ({ useSearch: () => () => [] }));
vi.mock('../src/pages/cpanel/branding.js', () => ({
  useBranding: () => ({ companyName: 'Keel', helpUrl: 'https://help.example', docsUrl: '', supportUrl: 'https://support.example' }),
  logoSrc: () => null,
}));

const { Menu } = await import('../src/components/Menu.jsx');
const { RowActions } = await import('../src/components/DataTable.jsx');
const { TopBar } = await import('../src/components/TopBar.jsx');

let container; let root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); });

const render = (el) => act(() => root.render(h(MemoryRouter, null, el)));
const fire = (el, type, init = {}) => act(() => { el.dispatchEvent(new (type.startsWith('key') ? KeyboardEvent : MouseEvent)(type, { bubbles: true, cancelable: true, ...init })); });
const click = (el) => act(() => el.click());
const menu = () => document.querySelector('[role="menu"]');
const items = () => Array.from(document.querySelectorAll('[role="menuitem"]'));

const trigger = (props) => h('button', { ...props, className: 'btn' }, 'More');
const basic = (extra = {}) => h(Menu, { trigger, items: [{ label: 'Edit', onClick: extra.onEdit || (() => {}) }, { label: 'Delete', danger: true, onClick: () => {} }], ...extra });

describe('Menu', () => {
  it('opens on click and stays open when the pointer leaves the trigger', () => {
    render(basic());
    const button = container.querySelector('button');
    expect(menu()).toBeNull();
    click(button);
    expect(menu()).not.toBeNull();
    fire(button, 'mouseleave');
    fire(button.parentElement, 'mouseleave');
    fire(menu(), 'mouseenter');
    expect(menu()).not.toBeNull();
  });

  it('closes on a mousedown outside the trigger and the menu, not on one inside', () => {
    render(basic());
    click(container.querySelector('button'));
    fire(menu(), 'mousedown');
    expect(menu()).not.toBeNull();
    fire(document.body, 'mousedown');
    expect(menu()).toBeNull();
  });

  it('closes on Escape and returns focus to the trigger', () => {
    render(basic());
    const button = container.querySelector('button');
    click(button);
    fire(document, 'keydown', { key: 'Escape' });
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('runs an item onClick and closes', () => {
    const onEdit = vi.fn();
    render(basic({ onEdit }));
    click(container.querySelector('button'));
    click(items()[0]);
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(menu()).toBeNull();
  });

  it('moves focus between items with ArrowDown/ArrowUp/Home/End', () => {
    render(basic());
    click(container.querySelector('button'));
    fire(menu(), 'keydown', { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items()[0]);
    fire(menu(), 'keydown', { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items()[1]);
    fire(menu(), 'keydown', { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items()[0]);
    fire(menu(), 'keydown', { key: 'End' });
    expect(document.activeElement).toBe(items()[1]);
    fire(menu(), 'keydown', { key: 'Home' });
    expect(document.activeElement).toBe(items()[0]);
    fire(menu(), 'keydown', { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items()[1]);
  });

  it('ArrowDown on the closed trigger opens the menu with the first item focused', () => {
    render(basic());
    fire(container.querySelector('button'), 'keydown', { key: 'ArrowDown' });
    expect(menu()).not.toBeNull();
    expect(document.activeElement).toBe(items()[0]);
  });

  it('ArrowDown on the trigger of an already open menu focuses the first item', () => {
    render(basic());
    const button = container.querySelector('button');
    click(button);
    expect(document.activeElement).not.toBe(items()[0]);
    fire(button, 'keydown', { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items()[0]);
    fire(button, 'keydown', { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items()[1]);
  });

  it('Tab out of a floating menu closes it and returns focus to the trigger', () => {
    render(basic({ floating: true }));
    const button = container.querySelector('button');
    fire(button, 'keydown', { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items()[0]);
    fire(menu(), 'keydown', { key: 'Tab' });
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('carries the WAI-ARIA menu button attributes', () => {
    render(basic());
    const button = container.querySelector('button');
    expect(button.getAttribute('aria-haspopup')).toBe('menu');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.getAttribute('aria-controls')).toBe(menu().id);
    expect(menu().getAttribute('aria-labelledby')).toBe(button.id);
    expect(items().map((i) => i.textContent)).toEqual(['Edit', 'Delete']);
    expect(items()[1].className).toContain('danger');
  });

  it('a floating menu is portalled to <body> and positioned against the trigger', () => {
    render(basic({ floating: true }));
    click(container.querySelector('button'));
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(menu().parentElement).toBe(document.body);
    expect(menu().className).toContain('menu-portal');
    expect(menu().style.position).toBe('fixed');
  });
});

describe('DataTable RowActions', () => {
  it('renders primary buttons inline and the rest behind the ⋯ menu', () => {
    const onDrop = vi.fn();
    render(h(RowActions, { actions: [{ label: 'Edit', primary: true, onClick: () => {} }, { label: 'Rename', onClick: () => {} }, null, { label: 'Delete', danger: true, onClick: onDrop }] }));
    const inline = Array.from(container.querySelectorAll('.row-actions > .btn')).map((b) => b.textContent);
    expect(inline).toEqual(['Edit']);
    const more = container.querySelector('[aria-label="More actions"]');
    expect(more.getAttribute('aria-haspopup')).toBe('menu');
    click(more);
    expect(items().map((i) => i.textContent)).toEqual(['Rename', 'Delete']);
    fire(more.parentElement, 'mouseleave');
    expect(menu()).not.toBeNull();
    click(items()[1]);
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(menu()).toBeNull();
  });
});

describe('TopBar user menu', () => {
  it('keeps the same entries and closes on outside press', () => {
    render(h(TopBar, { onMenu: () => {} }));
    const button = container.querySelector('.user-menu');
    expect(button.getAttribute('aria-haspopup')).toBe('menu');
    click(button);
    expect(menu().querySelector('.menu-meta').textContent).toBe('rootroot');
    expect(items().map((i) => i.textContent.trim())).toEqual(['Change password', 'Two-factor authentication', 'Help', 'Support', 'Log out']);
    expect(items()[0].getAttribute('href')).toBe('/change-password');
    expect(items()[1].getAttribute('href')).toBe('/security-center/two-factor-authentication');
    expect(items()[2].getAttribute('href')).toBe('https://help.example');
    expect(items()[2].getAttribute('target')).toBe('_blank');
    fire(button, 'mouseleave');
    expect(menu()).not.toBeNull();
    fire(document.body, 'mousedown');
    expect(menu()).toBeNull();
  });
});
