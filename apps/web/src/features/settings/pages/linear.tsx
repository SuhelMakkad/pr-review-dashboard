import { call } from '@/lib/call';
import { follow } from '@/lib/navigation';
import { routes } from '@review-desk/shared/contract';
import { useEffect } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';
import { Button } from '@/ui/button';
import { cn } from '@/ui/cn';
import { Enter } from '@/ui/motion';
import { isTicketQuery, useLinearStatus } from '@/features/linear/use-linear';
import { CardSkeleton, SettingRow, SettingsCard } from '@/features/settings/parts';

export function LinearSettings({ result }: { result?: 'connected' | 'failed' }) {
  const status = useLinearStatus();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const data = status.data;

  const connect = useMutation({
    mutationFn: () => call(routes.linearConnect, { params: {} }),
    // Linear's sign-in page sends the browser back to this page when it is done.
    onSuccess: ({ url }) => window.location.assign(url),
    onError: (error) => toast.error(error.message),
  });
  const disconnect = useMutation({
    mutationFn: () => call(routes.linearDisconnect, { params: {} }),
    onSuccess: (next) => {
      queryClient.setQueryData(['linear-status'], next);
      void queryClient.invalidateQueries({ predicate: (query) => isTicketQuery(query.queryKey) });
      toast('Disconnected from Linear');
    },
    onError: (error) => toast.error(error.message),
  });

  useEffect(() => {
    if (!result) return;

    if (result === 'connected') toast.success('Linear connected');
    else toast.error('Linear sign-in did not finish');

    void queryClient.invalidateQueries({ queryKey: ['linear-status'] });
    void queryClient.invalidateQueries({ predicate: (query) => isTicketQuery(query.queryKey) });
    follow(
      navigate({
        to: '/settings/$section',
        params: { section: 'linear' },
        search: {},
        replace: true,
      }),
    );
  }, [result, navigate, queryClient]);

  if (!data) return <CardSkeleton label="Loading the Linear connection…" rows={1} />;

  const via = data.method === 'oauth' ? 'your Linear sign-in' : 'a personal API key';

  return (
    <Enter preset="fade" className="space-y-4">
      <SettingsCard title="Connection">
        <SettingRow
          label={data.connected ? (data.workspace ?? 'Linear') : 'Linear'}
          hint={
            data.connected
              ? `Connected to ${data.workspace} with ${via}. Teams: ${data.teamKeys.join(', ')}.`
              : 'Shows the status, owner and priority of tickets your PRs reference.'
          }
        >
          {data.connected ? (
            <span className="flex shrink-0 items-center gap-3">
              <span className="inline-flex items-center gap-1.5 text-sm text-ok">
                <span className="size-1.5 rounded-full bg-ok" aria-hidden="true" />
                Connected
              </span>
              {data.method === 'oauth' && data.canSignIn && (
                <Button
                  size="sm"
                  disabled={disconnect.isPending}
                  onClick={() => disconnect.mutate()}
                >
                  Disconnect
                </Button>
              )}
            </span>
          ) : data.canSignIn ? (
            <Button
              variant="primary"
              size="sm"
              disabled={connect.isPending}
              onClick={() => connect.mutate()}
            >
              {connect.isPending ? 'Opening Linear…' : 'Connect Linear'}
            </Button>
          ) : (
            <span className={cn('text-sm', data.error ? 'text-fail' : 'text-fg-muted')}>
              {data.error ? 'Key rejected' : 'Not connected'}
            </span>
          )}
        </SettingRow>
        {!data.connected && (data.error || data.canSignIn) && (
          <div className="space-y-2 py-3.5 text-xs text-fg-muted">
            {data.error && <p className="text-fail">{data.error}</p>}
            {data.canSignIn && (
              <p className="leading-relaxed">
                Connect opens Linear, where you approve read-only access for Review Desk. It goes
                through Linear’s MCP server, so it works even where personal API keys are turned
                off. The sign-in is kept in your macOS Keychain, never in this app’s pages or data
                folder.
              </p>
            )}
          </div>
        )}
      </SettingsCard>

      {!data.connected && (
        <SettingsCard
          title={data.canSignIn ? 'Use a personal API key instead' : 'Use a personal API key'}
          description="If your workspace allows personal API keys (Linear Settings → Security & access → Personal API keys), create one and store it in your macOS Keychain by running this in a terminal and pasting the key when asked."
        >
          <div className="flex items-center gap-2 py-3.5">
            <code className="min-w-0 flex-1 truncate rounded-sm border border-line bg-sunken px-2 py-1.5 text-xs text-fg">
              {data.setupCommand}
            </code>
            <Button
              size="sm"
              onClick={() =>
                void navigator.clipboard
                  .writeText(data.setupCommand)
                  .then(() => toast('Command copied'))
              }
            >
              Copy
            </Button>
            <Button size="sm" onClick={() => void status.refetch()}>
              Check again
            </Button>
          </div>
        </SettingsCard>
      )}
    </Enter>
  );
}
