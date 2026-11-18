import { useState, useSyncExternalStore, type ReactNode } from 'react';
import { Check } from 'lucide-react';
import { toast } from 'sonner';
import { accountHandle } from '@review-desk/shared/accounts';
import { useAccounts, useStatus, useSwitchAccount } from '@/lib/queries';
import { Avatar } from '@/ui/avatar';
import { FadeSwap } from '@/ui/motion';
import { Skeleton, SkeletonRegion } from '@/ui/skeleton';
import {
  Menu,
  MenuContent,
  MenuItemIndicator,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
  menuItemClass,
  menuLabelClass,
} from '@/ui/menu';

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

/** True while Review Desk is switching accounts, wherever the switch started. */
export function useSwitchingAccount(): boolean {
  return useSyncExternalStore(subscribeSwitch, () => switchPending);
}

/** Switches the GitHub or GitLab account Review Desk works as, announcing the outcome. */
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
 * Lists the accounts signed in to the GitHub CLI and the GitLab CLI (one per GitLab host) and
 * switches between them. `children` is the trigger. The CLIs' own accounts, used in terminals,
 * never change.
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
    <Menu open={open} onOpenChange={setOpen} modal={false}>
      <MenuTrigger asChild>{children}</MenuTrigger>
      <MenuContent side={side} align={align} sideOffset={6} className="w-64">
        <MenuLabel className={menuLabelClass}>Accounts</MenuLabel>

        {/* The menu eases to the size of whatever the CLI checks return. */}
        <FadeSwap
          swapKey={
            accounts.isPending
              ? 'loading'
              : accounts.isError
                ? 'error'
                : accounts.data.switchable
                  ? 'accounts'
                  : 'fixed'
          }
          smoothHeight
        >
          {accounts.isPending ? (
            <SkeletonRegion label="Checking GitHub and GitLab CLI sign-ins…">
              {[0, 1].map((index) => (
                <div key={index} className="flex h-8 items-center gap-2 px-2">
                  <span className="w-4" />
                  <Skeleton className="size-[18px] rounded-full" />
                  <Skeleton className={index ? 'h-3 w-20' : 'h-3 w-28'} />
                </div>
              ))}
            </SkeletonRegion>
          ) : accounts.isError ? (
            <p role="alert" className="px-2 py-1.5 text-xs text-fail">
              {accounts.error.message}
            </p>
          ) : !accounts.data.switchable ? (
            <p className="px-2 py-1.5 text-xs text-fg-muted">This server cannot switch accounts.</p>
          ) : (
            <MenuRadioGroup value={current ?? ''} onValueChange={switchTo}>
              {accounts.data.accounts.map((account) => (
                <MenuRadioItem
                  key={account.login}
                  value={account.login}
                  disabled={!account.ok || switching}
                  className={menuItemClass}
                >
                  <span className="w-4">
                    <MenuItemIndicator>
                      <Check size={14} />
                    </MenuItemIndicator>
                  </span>
                  <Avatar login={accountHandle(account.login)} size={18} />
                  <span className="min-w-0 flex-1 truncate">
                    {accountHandle(account.login)}
                    {account.forge === 'gitlab' && (
                      <span className="ml-1.5 text-2xs text-fg-subtle">{account.host}</span>
                    )}
                  </span>
                  {!account.ok ? (
                    <span className="text-xs text-fail">Sign in again</span>
                  ) : account.login !== current && account.inProgress > 0 ? (
                    <span
                      className="text-xs text-pending"
                      title="Actions queued as this account send when you switch back."
                    >
                      {account.inProgress} waiting
                    </span>
                  ) : null}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          )}
        </FadeSwap>

        <MenuSeparator />
        <p className="px-2 pt-0.5 pb-1.5 text-2xs leading-relaxed text-fg-subtle">
          Each account keeps its own queue, drafts and history. Add one with{' '}
          <code>gh auth login</code> or <code>glab auth login</code>.
        </p>
      </MenuContent>
    </Menu>
  );
}
