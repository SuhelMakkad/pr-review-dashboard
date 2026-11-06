import { forwardRef, useEffect, useState } from 'react';
import { DropdownMenu } from 'radix-ui';
import { Check, ChevronRight, ListFilter, Search, X } from 'lucide-react';
import type { PullRequestItem } from '../../../shared/types';
import { cn } from '../../ui/cn';
import { Kbd } from '../../ui/kbd';
import { ciMeta, reasonMeta } from '../pulls/meta';
import { activeFilterCount, type InboxSearch } from './filters';

const menuClass =
  'z-50 min-w-[200px] rounded-md border border-line bg-elevated p-1 text-sm text-fg shadow-popover';
const menuItemClass =
  'flex h-8 cursor-default items-center gap-2 rounded-sm px-2 outline-none data-[highlighted]:bg-selected';

type FilterKey = 'repo' | 'author' | 'reason' | 'ci' | 'draft';

function Submenu({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string | undefined;
  options: { value: string; label: string }[];
  onChange: (value: string | undefined) => void;
}) {
  return (
    <DropdownMenu.Sub>
      <DropdownMenu.SubTrigger className={menuItemClass}>
        <span className="flex-1">{label}</span>
        {value && <span className="size-1.5 rounded-full bg-accent" aria-hidden="true" />}
        <ChevronRight size={14} className="text-fg-subtle" aria-hidden="true" />
      </DropdownMenu.SubTrigger>
      <DropdownMenu.Portal>
        <DropdownMenu.SubContent
          className={cn(menuClass, 'max-h-80 overflow-y-auto')}
          sideOffset={4}
        >
          <DropdownMenu.RadioGroup
            value={value ?? ''}
            onValueChange={(next) => onChange(next || undefined)}
          >
            <DropdownMenu.RadioItem value="" className={menuItemClass}>
              <span className="w-4">
                <DropdownMenu.ItemIndicator>
                  <Check size={14} />
                </DropdownMenu.ItemIndicator>
              </span>
              Any
            </DropdownMenu.RadioItem>
            {options.map((option) => (
              <DropdownMenu.RadioItem
                key={option.value}
                value={option.value}
                className={menuItemClass}
              >
                <span className="w-4">
                  <DropdownMenu.ItemIndicator>
                    <Check size={14} />
                  </DropdownMenu.ItemIndicator>
                </span>
                <span className="truncate">{option.label}</span>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.SubContent>
      </DropdownMenu.Portal>
    </DropdownMenu.Sub>
  );
}

const chipLabel = (key: FilterKey, value: string) =>
  key === 'reason'
    ? reasonMeta[value as keyof typeof reasonMeta].label
    : key === 'ci'
      ? ciMeta[value as keyof typeof ciMeta].label
      : key === 'draft'
        ? value === 'only'
          ? 'Drafts only'
          : 'Hide drafts'
        : value;

export const FilterBar = forwardRef<
  HTMLInputElement,
  {
    search: InboxSearch;
    items: PullRequestItem[];
    onChange: (next: Partial<InboxSearch>) => void;
  }
>(function FilterBar({ search, items, onChange }, ref) {
  const [text, setText] = useState(search.q ?? '');
  const repositories = [...new Set(items.map((item) => item.repository))].sort();
  const authors = [...new Set(items.map((item) => item.author.login))].sort();
  const count = activeFilterCount(search);

  useEffect(() => {
    setText(search.q ?? '');
  }, [search.q]);

  useEffect(() => {
    const timer = setTimeout(() => {
      if ((search.q ?? '') !== text) onChange({ q: text || undefined });
    }, 150);

    return () => clearTimeout(timer);
  }, [text]);

  const active = (['repo', 'author', 'reason', 'ci', 'draft'] as FilterKey[]).filter(
    (key) => search[key],
  );

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <label className="flex h-8 max-w-[320px] min-w-0 flex-1 items-center gap-2 rounded-sm border border-line bg-sunken px-2 focus-within:border-accent">
        <Search size={14} className="shrink-0 text-fg-subtle" aria-hidden="true" />
        <input
          ref={ref}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();

              if (text) setText('');
              else event.currentTarget.blur();
            }

            if (event.key === 'Enter' || event.key === 'ArrowDown') event.currentTarget.blur();
          }}
          placeholder="Filter by title, repo, author, #number"
          aria-label="Filter pull requests"
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-fg-subtle"
        />
        {text ? (
          <button
            type="button"
            onClick={() => setText('')}
            aria-label="Clear filter"
            className="text-fg-subtle hover:text-fg"
          >
            <X size={13} />
          </button>
        ) : (
          <Kbd keys="/" />
        )}
      </label>

      <DropdownMenu.Root>
        <DropdownMenu.Trigger
          className={cn(
            'inline-flex h-8 items-center gap-1.5 rounded-sm border px-2.5 text-sm',
            count
              ? 'border-accent text-accent'
              : 'border-line text-fg-muted hover:bg-hover hover:text-fg',
          )}
        >
          <ListFilter size={14} aria-hidden="true" />
          Filter
          {count > 0 && (
            <span className="rounded-xs bg-accent px-1 text-2xs text-accent-fg">{count}</span>
          )}
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className={menuClass} sideOffset={6} align="start">
            <Submenu
              label="Repository"
              value={search.repo}
              options={repositories.map((value) => ({ value, label: value }))}
              onChange={(repo) => onChange({ repo })}
            />
            <Submenu
              label="Author"
              value={search.author}
              options={authors.map((value) => ({ value, label: value }))}
              onChange={(author) => onChange({ author })}
            />
            <Submenu
              label="Attention reason"
              value={search.reason}
              options={(
                ['first_review', 'changed', 'requested_again', 'reply', 'dismissed'] as const
              ).map((value) => ({ value, label: reasonMeta[value].label }))}
              onChange={(reason) => onChange({ reason: reason as InboxSearch['reason'] })}
            />
            <Submenu
              label="Checks"
              value={search.ci}
              options={(['success', 'failure', 'pending', 'none'] as const).map((value) => ({
                value,
                label: ciMeta[value].label,
              }))}
              onChange={(ci) => onChange({ ci: ci as InboxSearch['ci'] })}
            />
            <Submenu
              label="Drafts"
              value={search.draft}
              options={[
                { value: 'hide', label: 'Hide drafts' },
                { value: 'only', label: 'Drafts only' },
              ]}
              onChange={(draft) => onChange({ draft: draft as InboxSearch['draft'] })}
            />
            {count > 0 && (
              <>
                <DropdownMenu.Separator className="my-1 h-px bg-line" />
                <DropdownMenu.Item
                  className={menuItemClass}
                  onSelect={() =>
                    onChange({
                      repo: undefined,
                      author: undefined,
                      reason: undefined,
                      ci: undefined,
                      draft: undefined,
                    })
                  }
                >
                  Clear all filters
                </DropdownMenu.Item>
              </>
            )}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      <div className="flex min-w-0 items-center gap-1 overflow-hidden">
        {active.map((key) => (
          <span
            key={key}
            className="inline-flex h-6 shrink-0 items-center gap-1 rounded-xs bg-selected pr-1 pl-2 text-xs text-fg"
          >
            {chipLabel(key, search[key]!)}
            <button
              type="button"
              aria-label={`Remove ${key} filter`}
              className="rounded-xs p-0.5 text-fg-subtle hover:bg-hover hover:text-fg"
              onClick={() => onChange({ [key]: undefined })}
            >
              <X size={11} />
            </button>
          </span>
        ))}
      </div>
    </div>
  );
});
