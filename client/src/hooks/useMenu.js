import { useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
import { UNSAFE_LocationContext } from 'react-router-dom';

const ITEM_SELECTOR = '[role="menuitem"]:not([disabled]):not([aria-disabled="true"])';

const itemsOf = (menu) => (menu ? Array.from(menu.querySelectorAll(ITEM_SELECTOR)) : []);

// One behaviour for every popover menu: opens on click, never closes on hover,
// closes on a press outside the trigger and the menu, on Escape (focus goes
// back to the trigger), on Tab (focus returns to the trigger first so the
// native Tab continues from there) and on a route change. Closing on scroll
// or resize is opt-in through `closeOnScroll` (default: floating); Menu.jsx
// turns it off and repositions instead. Arrow keys, Home and End move
// between the menu items.
export function useMenu({ floating = false, closeOnScroll = floating } = {}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef(null);
  const menuRef = useRef(null);
  const focusOnOpen = useRef(null);
  const reactId = useId();
  const buttonId = `menu${reactId}button`;
  const menuId = `menu${reactId}items`;

  const close = useCallback((focusButton = false) => {
    setOpen(false);
    if (focusButton) buttonRef.current?.focus();
  }, []);
  const toggle = useCallback(() => setOpen((o) => !o), []);

  // The context is read directly so the hook also works outside a router.
  const pathname = useContext(UNSAFE_LocationContext)?.location?.pathname;
  const lastPath = useRef(pathname);
  useEffect(() => {
    if (lastPath.current !== pathname) { lastPath.current = pathname; setOpen(false); }
  }, [pathname]);

  useEffect(() => {
    if (!open) return undefined;
    const inside = (target) => buttonRef.current?.contains(target) || menuRef.current?.contains(target);
    const onPointer = (e) => { if (!inside(e.target)) setOpen(false); };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); setOpen(false); buttonRef.current?.focus(); }
      else if (e.key === 'Tab') { buttonRef.current?.focus(); setOpen(false); }
    };
    const onMove = (e) => { if (e.type === 'resize' || !menuRef.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('touchstart', onPointer);
    document.addEventListener('keydown', onKey);
    if (closeOnScroll) {
      window.addEventListener('resize', onMove);
      document.addEventListener('scroll', onMove, true);
    }
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('touchstart', onPointer);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onMove);
      document.removeEventListener('scroll', onMove, true);
    };
  }, [open, closeOnScroll]);

  useEffect(() => {
    if (!open || !focusOnOpen.current) return;
    const items = itemsOf(menuRef.current);
    const target = focusOnOpen.current === 'last' ? items[items.length - 1] : items[0];
    focusOnOpen.current = null;
    target?.focus();
  }, [open]);

  const onMenuKeyDown = (e) => {
    const items = itemsOf(menuRef.current);
    if (!items.length) return;
    const index = items.indexOf(document.activeElement);
    const focusAt = (i) => { e.preventDefault(); items[(i + items.length) % items.length].focus(); };
    switch (e.key) {
      case 'ArrowDown': return focusAt(index + 1);
      case 'ArrowUp': return focusAt(index < 0 ? items.length - 1 : index - 1);
      case 'Home': return focusAt(0);
      case 'End': return focusAt(items.length - 1);
      case 'Enter':
      case ' ':
        if (index >= 0) { e.preventDefault(); items[index].click(); }
        return undefined;
      default: return undefined;
    }
  };

  const onButtonKeyDown = (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    if (open) {
      const items = itemsOf(menuRef.current);
      (e.key === 'ArrowUp' ? items[items.length - 1] : items[0])?.focus();
      return;
    }
    focusOnOpen.current = e.key === 'ArrowUp' ? 'last' : 'first';
    setOpen(true);
  };

  return {
    open, setOpen, toggle, close, buttonRef, menuRef, buttonId, menuId,
    buttonProps: { ref: buttonRef, id: buttonId, type: 'button', onClick: toggle, onKeyDown: onButtonKeyDown, 'aria-haspopup': 'menu', 'aria-expanded': open, 'aria-controls': menuId },
    menuProps: { ref: menuRef, id: menuId, role: 'menu', tabIndex: -1, 'aria-labelledby': buttonId, onKeyDown: onMenuKeyDown },
  };
}
