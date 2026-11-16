import { forwardRef, type SelectHTMLAttributes } from 'react';
import { cn } from '@/ui/cn';

/** A compact native select, so the OS menu, keyboard handling and screen reader support come free. */
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, ...props }, ref) {
    return (
      <select
        ref={ref}
        className={cn(
          'h-7 rounded-sm border border-line bg-sunken px-2 text-xs disabled:opacity-50',
          className,
        )}
        {...props}
      />
    );
  },
);
