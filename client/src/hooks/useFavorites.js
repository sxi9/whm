import { useCallback, useEffect, useState } from 'react';

const KEY = 'whm.favorites';

function read() {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; }
}

export function useFavorites() {
  const [favorites, setFavorites] = useState(read);
  useEffect(() => { try { localStorage.setItem(KEY, JSON.stringify(favorites)); } catch { /* private mode */ } }, [favorites]);
  const toggle = useCallback((key) => setFavorites((f) => (f.includes(key) ? f.filter((k) => k !== key) : [...f, key])), []);
  const isFavorite = useCallback((key) => favorites.includes(key), [favorites]);
  return { favorites, toggle, isFavorite, set: setFavorites };
}
