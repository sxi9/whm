import { useEffect, useState } from 'react';

// Animated disclosure body: the outer grid row goes 1fr → 0fr (theme/base.css
// .collapse) so no height is measured. `keepMounted` leaves the children in the
// tree while closed (home grids); otherwise they stay only until the close
// transition has run. The inner element is inert while closed so nothing hidden
// takes focus. `data-settled` marks a fully open body: only then does the inner
// box stop clipping, so card hover lifts, shadows and focus rings can bleed out
// while the row still clips during either transition.
const CLOSE_MS = 260;

export function Collapse({ open, id, className = '', keepMounted = true, children, ...rest }) {
  const [mounted, setMounted] = useState(open);
  const [settled, setSettled] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      const t = setTimeout(() => setSettled(true), CLOSE_MS);
      return () => clearTimeout(t);
    }
    setSettled(false);
    const t = setTimeout(() => setMounted(false), CLOSE_MS);
    return () => clearTimeout(t);
  }, [open]);
  const show = keepMounted || open || mounted;
  return (
    <div id={id} className={`collapse ${className}`.trim()} data-open={open ? 'true' : 'false'} data-settled={open && settled ? 'true' : 'false'} {...rest}>
      {/* React 18 emits `inert` only as a string attribute (the empty string); React 19 takes a boolean, so switch to inert={!open} on upgrade. */}
      <div className="collapse-inner" inert={open ? undefined : ''} aria-hidden={open ? undefined : 'true'}>
        {show ? children : null}
      </div>
    </div>
  );
}
