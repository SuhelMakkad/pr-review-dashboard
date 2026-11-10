import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import { AnimatePresence, m } from 'motion/react';
import { useLeavingProps } from '@/ui/motion/leaving';
import { collapse, pop, presence, staggered } from '@/ui/motion/presets';
import { spring } from '@/ui/motion/tokens';

const tags = {
  div: m.div,
  span: m.span,
  li: m.li,
  ol: m.ol,
  ul: m.ul,
  section: m.section,
  article: m.article,
};

type Tag = keyof typeof tags;

/** Plain HTML attributes, minus the handlers Motion redefines for gestures and animations. */
type Attributes = Omit<
  HTMLAttributes<HTMLElement>,
  'onDrag' | 'onDragStart' | 'onDragEnd' | 'onAnimationStart' | 'children'
>;

const itemPresets = { collapse, pop };

/**
 * Animates items joining and leaving a list. Changing `resetKey` (a different queue or filter)
 * swaps the whole list at once, so only changes within one view animate. `popLayout` takes a
 * leaving item out of the flow at once so its neighbours can glide into its place (pair it with
 * `layout` items inside a `relative` parent).
 */
export function ListPresence({
  resetKey,
  mode = 'sync',
  children,
}: {
  resetKey?: string;
  mode?: 'sync' | 'popLayout';
  children: ReactNode;
}) {
  return (
    <AnimatePresence key={resetKey} mode={mode} initial={false}>
      {children}
    </AnimatePresence>
  );
}

/** Tags that only wrap another element, and so must stay invisible to assistive technology. */
const wrappers = new Set<Tag>(['div', 'span']);

/**
 * One item in a `ListPresence`. Rows `collapse` (height); inline items such as chips `pop`. As a
 * `div` or `span` it only wraps the real item and is semantically invisible (`role="none"`), so
 * the element inside keeps its own role, id and ARIA state for the list that owns it. As an `li`
 * it is the list item itself. `layout` lets it glide when neighbours come and go. A leaving item
 * is unreachable at once, so a triaged row is never still counted, focused or clicked.
 */
export const ListItem = forwardRef<
  HTMLElement,
  {
    as?: Tag;
    preset?: keyof typeof itemPresets;
    layout?: boolean;
    className?: string;
    children: ReactNode;
  }
>(function ListItem({ as = 'div', preset = 'collapse', layout, className, children }, ref) {
  const Component = tags[as];

  return (
    <Component
      ref={ref as never}
      role={wrappers.has(as) ? 'none' : undefined}
      className={className}
      layout={layout ? 'position' : undefined}
      transition={layout ? { layout: spring.indicator } : undefined}
      {...presence(itemPresets[preset])}
      {...useLeavingProps()}
    >
      {children}
    </Component>
  );
});

/** An item that glides to its new place when its list re-sorts (resolving a thread, say). */
export function LayoutItem({
  as = 'div',
  children,
  ...attributes
}: Attributes & { as?: Tag; children: ReactNode }) {
  const Component = tags[as];

  return (
    <Component layout="position" transition={{ layout: spring.indicator }} {...attributes}>
      {children}
    </Component>
  );
}

/**
 * An item that rises in a beat after the one before it (`index`), when its nearest animated
 * ancestor (`FadeSwap`, `Reveal`, `Enter`) enters. Content already on screen at first paint stays
 * put, because the ancestor skips its own entrance then.
 */
export function StaggerItem({
  index,
  as = 'div',
  children,
  ...attributes
}: Attributes & { index: number; as?: Tag; children: ReactNode }) {
  const Component = tags[as];

  return (
    <Component variants={staggered} custom={index} {...attributes}>
      {children}
    </Component>
  );
}

/**
 * A scrolling container whose scroll offset layout animations account for, so indicators and
 * re-sorting items inside it glide to the right place while it is scrolled.
 */
export const LayoutScroll = forwardRef<HTMLElement, Attributes & { as?: Tag; children: ReactNode }>(
  function LayoutScroll({ as = 'div', children, ...attributes }, ref) {
    const Component = tags[as];

    return (
      <Component ref={ref as never} layoutScroll {...attributes}>
        {children}
      </Component>
    );
  },
);
