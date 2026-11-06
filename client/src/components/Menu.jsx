import { isValidElement, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { useMenu } from '../hooks/useMenu.js';

const GAP = 6;
const EDGE = 8;

// Places a floating menu against the trigger's viewport rectangle: below it,
// or above when there is no room below; aligned to its right or left edge.
function placement(button, menu, align) {
  const r = button.getBoundingClientRect();
  const h = menu?.offsetHeight || 0;
  const w = menu?.offsetWidth || 0;
  const below = r.bottom + GAP + h <= window.innerHeight || r.top - GAP - h < 0;
  const style = { position: 'fixed' };
  if (below) style.top = Math.max(EDGE, r.bottom + GAP);
  else style.bottom = Math.max(EDGE, window.innerHeight - r.top + GAP);
  if (align === 'left' && r.left + w <= window.innerWidth - EDGE) style.left = Math.max(EDGE, r.left);
  else style.right = Math.max(EDGE, window.innerWidth - r.right);
  return style;
}

function MenuItem({ item, close }) {
  const { label, icon: Icon, onClick, to, href, danger, disabled } = item;
  const className = `menu-item ${danger ? 'danger' : ''}`;
  const content = <>{Icon && (isValidElement(Icon) ? Icon : <Icon size={14} aria-hidden="true" />)}{Icon ? ' ' : null}{label}</>;
  const activate = (e) => { if (disabled) { e.preventDefault(); return; } close(); onClick?.(e); };
  if (to && !disabled) return <Link className={className} role="menuitem" to={to} onClick={activate}>{content}</Link>;
  if (href && !disabled) return <a className={className} role="menuitem" href={href} target="_blank" rel="noopener noreferrer" onClick={activate}>{content}</a>;
  return <button className={className} role="menuitem" type="button" onClick={activate} disabled={disabled}>{content}</button>;
}

// Popover menu: `trigger` receives the button props (ref, id, aria-*,
// onClick, onKeyDown) and renders the button; `items` are rendered as
// menuitems. A floating menu is portalled to <body> so a card's rounded
// clipping or a table's horizontal scroll never cuts it off.
export function Menu({ trigger, items = [], align = 'right', floating = false, header = null, className = '' }) {
  const menu = useMenu({ floating, closeOnScroll: false });
  const { open, close, buttonRef, menuRef, buttonProps, menuProps } = menu;
  const [style, setStyle] = useState(null);

  useLayoutEffect(() => {
    if (!open || !floating) { setStyle(null); return undefined; }
    const place = () => { if (buttonRef.current) setStyle(placement(buttonRef.current, menuRef.current, align)); };
    place();
    window.addEventListener('resize', place);
    document.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); document.removeEventListener('scroll', place, true); };
  }, [open, floating, align, buttonRef, menuRef]);

  const visible = items.filter(Boolean);
  const list = (
    <div {...menuProps} className={`menu-items ${align === 'left' ? '' : 'right'} ${floating ? 'menu-portal' : ''}`} style={style || undefined}>
      {header && <div className="menu-meta" role="presentation">{header}</div>}
      {visible.map((item, i) => (item.divider
        ? <div key={`divider-${i}`} className="menu-divider" role="separator" />
        : <MenuItem key={item.key || item.label} item={item} close={() => close(false)} />))}
    </div>
  );

  return (
    <div className={`menu ${className}`}>
      {trigger(buttonProps)}
      {open && (floating && typeof document !== 'undefined' ? createPortal(list, document.body) : list)}
    </div>
  );
}
