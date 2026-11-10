import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/ui/cn';
import { Kbd } from '@/ui/kbd';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md';

const variants: Record<Variant, string> = {
  primary:
    'bg-accent text-accent-fg hover:bg-accent-hover border border-transparent shadow-sm disabled:hover:bg-accent',
  secondary: 'bg-panel text-fg border border-line-strong hover:bg-hover',
  ghost: 'text-fg-muted hover:text-fg hover:bg-hover border border-transparent',
  danger: 'bg-fail text-accent-fg hover:opacity-90 border border-transparent',
};

const sizes: Record<Size, string> = {
  sm: 'h-7 px-2 text-xs gap-1.5 rounded-sm',
  md: 'h-8 px-3 text-sm gap-2 rounded-sm',
};

/** Square, padding-free sizes for icon-only buttons (no conflicting padding classes). */
const iconSizes: Record<Size, string> = {
  sm: 'size-7 text-xs rounded-sm',
  md: 'size-8 text-sm rounded-sm',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
  /** Keyboard shortcut shown inside the button, in tinykeys syntax. */
  shortcut?: string;
  iconOnly?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    icon,
    shortcut,
    iconOnly = false,
    className,
    children,
    type = 'button',
    ...props
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        // A slight press-in confirms the click; CSS, so the reduced-motion rule in app.css covers it.
        'inline-flex shrink-0 items-center justify-center font-medium whitespace-nowrap transition-[color,background-color,border-color,opacity,scale] select-none enabled:active:scale-[0.97] disabled:cursor-default disabled:opacity-50',
        variants[variant],
        iconOnly ? iconSizes[size] : sizes[size],
        className,
      )}
      {...props}
    >
      {icon}
      {children}
      {shortcut && <Kbd keys={shortcut} className={variant === 'primary' ? 'opacity-80' : ''} />}
    </button>
  );
});

export const IconButton = forwardRef<HTMLButtonElement, ButtonProps & { label: string }>(
  function IconButton({ label, className, size = 'md', variant = 'ghost', ...props }, ref) {
    return (
      <Button
        ref={ref}
        aria-label={label}
        title={label}
        variant={variant}
        size={size}
        iconOnly
        className={className}
        {...props}
      />
    );
  },
);
