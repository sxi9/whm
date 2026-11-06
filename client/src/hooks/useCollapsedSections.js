import { useCallback, useEffect, useState } from 'react';

// Open/closed state of named sections (home tool groups, sidebar categories), kept
// per browser under one localStorage key as { [slug]: boolean } where false is
// collapsed and true is open; a slug with no entry takes `defaultOpen`.

export function readSections(storageKey) {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

export function writeSections(storageKey, sections) {
  try { localStorage.setItem(storageKey, JSON.stringify(sections)); } catch { /* storage unavailable */ }
}

export function isSectionOpen(sections, key, defaultOpen = true) {
  const v = sections[key];
  return typeof v === 'boolean' ? v : defaultOpen;
}

export function collapsedAll(keys) {
  return Object.fromEntries(keys.map((k) => [k, false]));
}

export function expandedAll(keys, defaultOpen = true) {
  return defaultOpen ? {} : Object.fromEntries(keys.map((k) => [k, true]));
}

export function useCollapsedSections(storageKey, { defaultOpen = true } = {}) {
  const [sections, setSections] = useState(() => readSections(storageKey));
  useEffect(() => { writeSections(storageKey, sections); }, [storageKey, sections]);
  const isOpen = useCallback((key) => isSectionOpen(sections, key, defaultOpen), [sections, defaultOpen]);
  const isCollapsed = useCallback((key) => !isSectionOpen(sections, key, defaultOpen), [sections, defaultOpen]);
  const toggle = useCallback((key) => setSections((s) => ({ ...s, [key]: !isSectionOpen(s, key, defaultOpen) })), [defaultOpen]);
  const setOpen = useCallback((key, open) => setSections((s) => (isSectionOpen(s, key, defaultOpen) === open ? s : { ...s, [key]: open })), [defaultOpen]);
  const collapseAll = useCallback((keys) => setSections(collapsedAll(keys)), []);
  const expandAll = useCallback((keys = []) => setSections(expandedAll(keys, defaultOpen)), [defaultOpen]);
  return { sections, isOpen, isCollapsed, toggle, setOpen, collapseAll, expandAll };
}
