import { useEffect, useRef, useSyncExternalStore } from 'react';
import { tinykeys } from 'tinykeys';

export type ShortcutGroup = 'General' | 'Navigate' | 'Queue' | 'Pull request' | 'Appearance';

export interface Shortcut {
  /** tinykeys syntax: 'j', 'Shift+s', '$mod+k', 'g i', '[Shift]+?'. */
  keys: string;
  label: string;
  group: ShortcutGroup;
  run: (event: KeyboardEvent) => void;
  /** Fire even while typing in an input (e.g. ⌘K, Escape). */
  allowInInput?: boolean;
  /** Fire while a dialog, popover or menu is open. */
  allowInOverlay?: boolean;
  /** Keep out of the cheat sheet (aliases, internal). */
  hidden?: boolean;
}

const registry = new Map<symbol, Shortcut[]>();
const listeners = new Set<() => void>();
let snapshot: Shortcut[] = [];

function publish() {
  snapshot = [...registry.values()].flat().filter((shortcut) => !shortcut.hidden);

  for (const listener of listeners) listener();
}

function isEditable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.matches('input, textarea, select, [contenteditable]'))
  );
}

/** Enter and Space belong to a focused button or link, not to a global shortcut. */
function activatesFocusedControl(event: KeyboardEvent): boolean {
  return (
    (event.key === 'Enter' || event.key === ' ') &&
    event.target instanceof HTMLElement &&
    event.target.matches('button, a[href], [role="button"], [role="menuitem"], summary')
  );
}

export function overlayOpen(): boolean {
  return Boolean(document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]'));
}

/**
 * Binds keyboard shortcuts for as long as the calling component is mounted, and lists them in the
 * cheat sheet and command palette. The latest `run` callbacks are always used without rebinding.
 */
export function useShortcuts(shortcuts: Shortcut[], enabled = true): void {
  const latest = useRef(shortcuts);
  const id = useRef(Symbol('shortcuts'));
  const signature = enabled
    ? shortcuts.map((shortcut) => `${shortcut.keys}|${shortcut.label}`).join('\n')
    : '';

  latest.current = shortcuts;

  useEffect(() => {
    if (!enabled) return;

    const key = id.current;
    const bindings = Object.fromEntries(
      latest.current.map((shortcut, index) => [
        shortcut.keys,
        (event: KeyboardEvent) => {
          const current = latest.current[index] ?? shortcut;

          // A dialog, popover or menu already handled this key (e.g. Escape closing it).
          if (event.defaultPrevented) return;
          if (!current.allowInInput && isEditable(event.target)) return;
          if (activatesFocusedControl(event)) return;
          if (!current.allowInOverlay && overlayOpen()) return;

          event.preventDefault();
          current.run(event);
        },
      ]),
    );
    const unbind = tinykeys(window, bindings, { ignore: (event) => event.isComposing });

    registry.set(key, latest.current);
    publish();

    return () => {
      unbind();
      registry.delete(key);
      publish();
    };
  }, [signature, enabled]);
}

export function useRegisteredShortcuts(): Shortcut[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
    () => snapshot,
  );
}

const isMac = typeof navigator === 'object' && /Mac|iPhone|iPad/.test(navigator.platform);

const symbols: Record<string, string> = {
  $mod: isMac ? '⌘' : 'Ctrl',
  Meta: '⌘',
  Control: 'Ctrl',
  Shift: '⇧',
  Alt: isMac ? '⌥' : 'Alt',
  Enter: '↵',
  Escape: 'Esc',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Backspace: '⌫',
  Space: 'Space',
};

/** Splits a binding into displayable key caps: '$mod+k' → [['⌘','K']], 'g i' → [['G'],['I']]. */
export function keyCaps(keys: string): string[][] {
  return keys.split(' ').map((press) =>
    press
      .split(/(?<=\w|\])\+/)
      .map((part) => part.replace(/^\[(.*)\]$/, ''))
      .filter(Boolean)
      .map((part) => symbols[part] ?? (part.length === 1 ? part.toUpperCase() : part)),
  );
}
