import type { ComponentProps } from 'react';
import { Switch as Primitive } from 'radix-ui';
import { cn } from '@/ui/cn';

type SwitchProps = Omit<ComponentProps<typeof Primitive.Root>, 'asChild' | 'children'>;

/**
 * An on/off control that takes effect at once. The thumb slides on a CSS transition timed by the
 * motion tokens, so the reduced-motion rule in app.css makes it instant.
 */
export function Switch({ className, ...props }: SwitchProps) {
  return (
    <Primitive.Root
      className={cn(
        'inline-flex h-5 w-9 shrink-0 items-center rounded-full bg-line-strong p-0.5 transition-colors data-[state=checked]:bg-accent disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <Primitive.Thumb className="pointer-events-none block size-4 rounded-full bg-white shadow-sm transition-transform data-[state=checked]:translate-x-4" />
    </Primitive.Root>
  );
}
