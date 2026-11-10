// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactNode } from 'react';
import { MotionGlobalConfig } from 'motion/react';
import { DialogClose, DialogTitle, Modal } from '@/ui/dialog';
import { EmptyState } from '@/ui/empty-state';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/ui/menu';
import {
  ActiveIndicator,
  Enter,
  FadeSwap,
  IndicatorGroup,
  initReducedMotion,
  ListItem,
  ListPresence,
  MotionProvider,
  Reveal,
  SmoothHeight,
} from '@/ui/motion';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const withMotion = (node: ReactNode) => <MotionProvider>{node}</MotionProvider>;

function list(resetKey: string, items: string[]) {
  return withMotion(
    <div role="listbox" aria-label="Items">
      <ListPresence resetKey={resetKey}>
        {items.map((item) => (
          <ListItem key={item}>
            <div role="option" aria-selected={false}>
              {item}
            </div>
          </ListItem>
        ))}
      </ListPresence>
    </div>,
  );
}

describe('Reveal', () => {
  it('shows content at first paint and removes it after its exit', async () => {
    const { rerender } = render(withMotion(<Reveal show>Details</Reveal>));

    expect(screen.getByText('Details')).toBeInTheDocument();

    rerender(withMotion(<Reveal show={false}>Details</Reveal>));
    await waitFor(() => expect(screen.queryByText('Details')).toBeNull());
  });
});

describe('ListPresence', () => {
  it('lets a removed item exit before it unmounts', async () => {
    const { rerender } = render(list('inbox', ['one', 'two']));

    rerender(list('inbox', ['two']));
    expect(screen.getByText('one')).toBeInTheDocument();

    // While it leaves it is still drawn, but no longer an option anyone can reach or count.
    expect(screen.queryByRole('option', { name: 'one' })).toBeNull();
    expect(screen.getByText('one').closest('[inert]')).not.toBeNull();

    await waitFor(() => expect(screen.queryByText('one')).toBeNull());
    expect(screen.getByText('two')).toBeInTheDocument();
  });

  it('removes a selected item, whose indicator must not hold its exit open', async () => {
    const rows = (items: string[], selected: string) =>
      withMotion(
        <IndicatorGroup>
          <ListPresence>
            {items.map((item) => (
              <ListItem key={item}>
                <div className="relative">
                  {item === selected && <ActiveIndicator variant="bar" />}
                  {item}
                </div>
              </ListItem>
            ))}
          </ListPresence>
        </IndicatorGroup>,
      );
    const { rerender } = render(rows(['one', 'two'], 'one'));

    // Like marking a PR done: the row leaves and the selection moves to the next one.
    rerender(rows(['two'], 'two'));

    await waitFor(() => expect(screen.queryByText('one')).toBeNull());
  });

  it('swaps the whole list at once when the view changes', () => {
    const { rerender } = render(list('inbox', ['one', 'two']));

    rerender(list('waiting', ['three']));

    expect(screen.queryByText('one')).toBeNull();
    expect(screen.queryByText('two')).toBeNull();
    expect(screen.getByText('three')).toBeInTheDocument();
  });

  it('keeps list semantics: items are presentational wrappers around options', () => {
    render(list('inbox', ['one']));

    expect(screen.getByRole('option', { name: 'one' })).toBeInTheDocument();
    expect(screen.getByText('one').parentElement).toHaveAttribute('role', 'none');
  });
});

describe('FadeSwap', () => {
  it('ends with only the current state rendered', async () => {
    const view = (state: string) =>
      withMotion(
        <FadeSwap swapKey={state}>
          <p>{state}</p>
        </FadeSwap>,
      );
    const { rerender } = render(view('loading'));

    rerender(view('ready'));

    expect(await screen.findByText('ready')).toBeInTheDocument();
    expect(screen.queryByText('loading')).toBeNull();
  });
});

describe('Modal', () => {
  function Harness({ onExitComplete }: { onExitComplete: () => void }) {
    const [open, setOpen] = useState(false);

    return withMotion(
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Open
        </button>
        <Modal
          open={open}
          onOpenChange={setOpen}
          onExitComplete={onExitComplete}
          aria-describedby={undefined}
        >
          <DialogTitle>Settings</DialogTitle>
          <DialogClose>Close</DialogClose>
        </Modal>
      </>,
    );
  }

  it('stays mounted through its exit, then reports it', async () => {
    const user = userEvent.setup();
    const onExitComplete = vi.fn();

    // Real animations for this one test, to prove the exit plays before the dialog unmounts.
    MotionGlobalConfig.skipAnimations = false;

    try {
      render(<Harness onExitComplete={onExitComplete} />);
      await user.click(screen.getByRole('button', { name: 'Open' }));
      expect(await screen.findByRole('dialog', { name: 'Settings' })).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Close' }));
      expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
      expect(onExitComplete).not.toHaveBeenCalled();

      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(onExitComplete).toHaveBeenCalledTimes(1);
    } finally {
      MotionGlobalConfig.skipAnimations = true;
    }
  });
});

describe('Menu', () => {
  it('returns focus to its trigger once the menu has animated out', async () => {
    const user = userEvent.setup();

    render(
      withMotion(
        <Menu>
          <MenuTrigger>Actions</MenuTrigger>
          <MenuContent>
            <MenuItem>Rename</MenuItem>
          </MenuContent>
        </Menu>,
      ),
    );

    await user.click(screen.getByRole('button', { name: 'Actions' }));
    expect(await screen.findByRole('menuitem', { name: 'Rename' })).toBeInTheDocument();

    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(screen.getByRole('button', { name: 'Actions' })).toHaveFocus();
  });
});

describe('SmoothHeight', () => {
  it('eases to a new height when its trigger changes, and resizes instantly otherwise', async () => {
    // jsdom has no layout: each test block reports the height named in its data attribute.
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      return Number(this.querySelector('[data-height]')?.getAttribute('data-height') ?? 0);
    });
    MotionGlobalConfig.skipAnimations = false;

    try {
      const view = (trigger: string, height: number) =>
        withMotion(
          <SmoothHeight trigger={trigger}>
            <div data-height={height}>{trigger}</div>
          </SmoothHeight>,
        );
      const { container, rerender } = render(view('idle', 40));
      const box = container.firstElementChild as HTMLElement;

      rerender(view('idle', 60));
      expect(box.style.height).toBe('');

      rerender(view('run', 120));
      expect(box.style.overflow).toBe('hidden');

      await waitFor(() => expect(box.style.overflow).toBe(''));
      expect(box.style.height).toBe('');
    } finally {
      MotionGlobalConfig.skipAnimations = true;
      vi.restoreAllMocks();
    }
  });
});

describe('EmptyState', () => {
  it('staggers its parts in behind an Enter and leaves every one visible', async () => {
    render(
      withMotion(
        <Enter>
          <EmptyState
            stagger
            icon={<span>Icon</span>}
            title="Nothing here"
            hint="A hint"
            action={<button type="button">Act</button>}
          />
        </Enter>,
      ),
    );

    for (const text of ['Icon', 'A hint', 'Act']) {
      await waitFor(() => expect(screen.getByText(text)).toBeVisible());
    }
    expect(screen.getByRole('heading', { name: 'Nothing here' })).toBeVisible();
  });
});

describe('initReducedMotion', () => {
  it('follows the OS setting, including later changes', () => {
    const listeners = new Set<() => void>();
    const media = {
      matches: true,
      addEventListener: (_: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
    };

    vi.stubGlobal('matchMedia', () => media);

    try {
      const stop = initReducedMotion();

      expect(MotionGlobalConfig.skipAnimations).toBe(true);

      media.matches = false;
      listeners.forEach((listener) => listener());
      expect(MotionGlobalConfig.skipAnimations).toBe(false);

      stop();
      expect(listeners.size).toBe(0);
    } finally {
      MotionGlobalConfig.skipAnimations = true;
    }
  });
});
