import { useSyncExternalStore } from 'react';
import { storage } from './storage';

export type ThemePreference = 'light' | 'dark' | 'system';
export type Density = 'comfortable' | 'compact';

const THEME_KEY = 'review-desk-theme';
const DENSITY_KEY = 'review-desk-density';
const listeners = new Set<() => void>();

const systemDark = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;

function readTheme(): ThemePreference {
  const value = storage.get(THEME_KEY);

  return value === 'light' || value === 'dark' ? value : 'system';
}

function readDensity(): Density {
  return storage.get(DENSITY_KEY) === 'compact' ? 'compact' : 'comfortable';
}

let state = { theme: readTheme(), density: readDensity() };

function apply() {
  const root = document.documentElement;

  root.dataset.theme = state.theme === 'system' ? (systemDark() ? 'dark' : 'light') : state.theme;
  root.dataset.density = state.density;
}

function update(next: Partial<typeof state>) {
  state = { ...state, ...next };
  storage.set(THEME_KEY, state.theme);
  storage.set(DENSITY_KEY, state.density);
  apply();

  for (const listener of listeners) listener();
}

/** Applies the saved preferences and follows the OS theme while "system" is selected. */
export function initTheme(): void {
  apply();

  if (typeof matchMedia === 'function') {
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', apply);
  }
}

export const appearance = {
  setTheme: (theme: ThemePreference) => update({ theme }),
  setDensity: (density: Density) => update({ density }),
  cycleTheme: () =>
    update({
      theme: state.theme === 'system' ? 'light' : state.theme === 'light' ? 'dark' : 'system',
    }),
  toggleDensity: () => update({ density: state.density === 'compact' ? 'comfortable' : 'compact' }),
};

export function useAppearance() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
    () => state,
  );
}
