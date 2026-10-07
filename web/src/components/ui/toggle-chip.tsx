'use client'

import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { Check } from 'lucide-react'

import { cn } from '@/lib/utils'

/**
 * A multi-select chip that is actually a control.
 *
 * The previous markup used `<Badge onClick>` for every "accepted providers",
 * "payout accounts" and "webhook events" picker. `Badge` renders a `<span>` with
 * no role, no `tabIndex` and no `aria-pressed`, which means the primary
 * configuration flow in the product was reachable by pointer only — a keyboard
 * user could not select a provider at all, and no screen reader announced which
 * chips were selected.
 *
 * A real `<button>` with `aria-pressed` fixes both, and picking a provider with
 * Enter or Space is what a user expects from a control that looks selectable.
 *
 * The visual language is unchanged, so this is a drop-in replacement.
 */
const toggleVariants = cva(
  'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium transition-colors ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 ' +
    'disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      selected: {
        true: 'border-transparent bg-primary text-primary-foreground',
        false: 'border-input bg-background text-foreground hover:bg-accent hover:text-accent-foreground',
      },
    },
    defaultVariants: { selected: false },
  }
)

export interface ToggleChipProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'>,
    VariantProps<typeof toggleVariants> {
  selected: boolean
  children: React.ReactNode
}

export const ToggleChip = React.forwardRef<HTMLButtonElement, ToggleChipProps>(
  ({ className, selected, children, ...props }, ref) => (
    <button
      ref={ref}
      type="button"
      role="checkbox"
      aria-checked={selected}
      aria-pressed={selected}
      data-state={selected ? 'checked' : 'unchecked'}
      className={cn(toggleVariants({ selected: Boolean(selected) }), className)}
      {...props}
    >
      {selected && <Check className="w-3 h-3 shrink-0" aria-hidden="true" />}
      {children}
    </button>
  )
)
ToggleChip.displayName = 'ToggleChip'