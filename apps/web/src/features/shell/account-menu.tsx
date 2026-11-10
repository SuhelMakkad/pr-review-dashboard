import { useState, useSyncExternalStore, type ReactNode } from 'react';
import { DropdownMenu } from 'radix-ui';
import { Check } from 'lucide-react';
import { toast } from 'sonner';
import { useAccounts, useStatus, useSwitchAccount } from '@/lib/queries';
import { Avatar } from '@/ui/avatar';

const menuItemClass =
  'flex h-8 cursor-default items-center gap-2 rounded-sm px-2 outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-selected';

/**
 * Whether a switch is in progress, shared by the sidebar, Settings and the command palette. A
 * plain store rather than `useIsMutating`, which re-renders on every mutation in the app.
 */
let switchPending = false;
const switchListeners = new Set<() => void>();

function setSwitchPending(value: boolean) {
  switchPending = value;

  for (const listener of switchListeners) listener();
}

function subscribeSwitch(listener: () => void) {
  switchListeners.add(listener);

  return () => switchListeners.delete(listener);
}

/** True while Review Desk is switching GitHub accounts, wherever the switch started. */
export function useSwitchingAccount(): boolean {
  return useSyncExternalStore(subscribeSwitch, () => switchPending);
}

/** Switches the GitHub account Review Desk works as, announcing the outcome. */
export function useAccountSwitcher() {
  const status = useStatus();
  const mutation = useSwitchAccount();
  const switching = useSwitchingAccount();
  const current = status.data?.account?.login ?? null;

  const switchTo = (login: string) => {
    if (login === current || switchPending) return;

    setSwitchPending(true);
    mutation
      .mutateAsync({ from: current, to: login })
      .then(
        () => toast.success(`Switched to ${login}`),
        (error: Error) => toast.error(error.message),
      )
      .finally(() => setSwitchPending(false));
  };

  return { current, switching, switchTo };
}

/**
 * Lists the accounts signed in to the GitHub CLI and switches between them. `children` is the
 * trigger. The GitHub CLI's own active account, used in terminals, never changes.
 */
export function AccountMenu({
  children,
  side = 'top',
  align = 'start',
}: {
  children: ReactNode;
  side?: 'top' | 'bottom';
  align?: 'start' | 'end';
}) {
  const [open, setOpen] = useState(false);
  const accounts = useAccounts(open);
  const { current, switching, switchTo } = useAccountSwitcher();

  return (
    // Not modal, so the rest of the page stays reachable for assistive technology while it is open.
    <DropdownMenu.Root open={open} onOpenChange={setOpen} modal={false}>
      <DropdownMenu.Trigger asChild>{children}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side={side}
          align={align}
          sideOffset={6}
          className="z-50 w-64 rounded-md border border-line bg-elevated p-1 text-sm text-fg shadow-popover"
        >
          <DropdownMenu.Label className="px-2 pt-1.5 pb-1 text-2xs font-medium tracking-wide text-fg-subtle uppercase">
            GitHub accounts
          </DropdownMenu.Label>

          {accounts.isPending ? (
            <p className="px-2 py-1.5 text-xs text-fg-muted">Checking GitHub CLI sign-ins…</p>
          ) : accounts.isError ? (
            <p role="alert" className="px-2 py-1.5 text-xs text-fail">
              {accounts.error.message}
            </p>
          ) : !accounts.data.switchable ? (
            <p className="px-2 py-1.5 text-xs text-fg-muted">This server cannot switch accounts.</p>
          ) : (
            <DropdownMenu.RadioGroup value={current ?? ''} onValueChange={switchTo}>
              {accounts.data.accounts.map((account) => (
                <DropdownMenu.RadioItem
                  key={account.login}
                  value={account.login}
                  disabled={!account.ok || switching}
                  className={menuItemClass}
                >
                  <span className="w-4">
                    <DropdownMenu.ItemIndicator>
                      <Check size={14} />
                    </DropdownMenu.ItemIndicator>
                  </span>
                  <Avatar login={account.login} size={18} />
                  <span className="flex-1 truncate">{account.login}</span>
                  {!account.ok ? (
                    <span className="text-xs text-fail">Sign in again</span>
                  ) : account.login !== current && account.inProgress > 0 ? (
                    <span
                      className="text-xs text-pending"
                      title="GitHub actions queued as this account send when you switch back."
                    >
                      {account.inProgress} waiting
                    </span>
                  ) : null}
                </DropdownMenu.RadioItem>
              ))}
            </DropdownMenu.RadioGroup>
          )}

          <DropdownMenu.Separator className="my-1 h-px bg-line" />
          <p className="px-2 pt-0.5 pb-1.5 text-2xs leading-relaxed text-fg-subtle">
            Each account keeps its own queue, drafts and history. Add one with{' '}
            <code>gh auth login</code>.
          </p>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
