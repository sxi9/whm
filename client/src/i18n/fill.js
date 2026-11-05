// Placeholders for catalogue strings: t() only looks a key up, so pages fill
// `{name}` slots themselves and pick the singular/plural key by count.

export function fill(text, vars = {}) {
  return Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, String(v ?? '')), String(text ?? ''));
}

// `${key}_one` for exactly one, `${key}_other` otherwise; both may use {count}.
export function plural(t, key, count, one, other, vars = {}) {
  const n = Number(count) || 0;
  return fill(n === 1 ? t(`${key}_one`, one) : t(`${key}_other`, other), { count: n, ...vars });
}

// Default for pure helpers that tests call without a catalogue: the English fallback.
export const untranslated = (key, fallback) => fallback ?? key;
