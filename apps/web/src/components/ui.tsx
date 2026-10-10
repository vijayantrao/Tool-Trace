'use client';

import Link from 'next/link';
import { Loader2, X } from 'lucide-react';
import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';

type Variant = 'primary' | 'safety' | 'quiet' | 'danger';

const variants: Record<Variant, string> = {
  primary: 'bg-machine text-machine-ink hover:brightness-110',
  safety: 'bg-safety text-safety-ink hover:brightness-105',
  quiet: 'bg-transparent text-ink ring-1 ring-inset ring-line hover:bg-board',
  danger: 'bg-signal text-white hover:brightness-110',
};

const base =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-md px-4 text-[0.95rem] font-semibold transition-[filter,background-color] disabled:cursor-not-allowed disabled:opacity-55';

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean }
>(function Button({ variant = 'primary', busy, className = '', children, disabled, ...props }, ref) {
  return (
    <button ref={ref} className={`${base} ${variants[variant]} ${className}`} disabled={disabled || busy} {...props}>
      {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
});

export function LinkButton({
  href,
  variant = 'primary',
  className = '',
  children,
}: {
  href: string;
  variant?: Variant;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link href={href} className={`${base} ${variants[variant]} ${className}`}>
      {children}
    </Link>
  );
}

const control =
  'w-full min-h-11 rounded-md border border-line bg-panel px-3 text-ink placeholder:text-muted/70 focus:border-machine focus:outline-none focus:ring-2 focus:ring-machine/25';

export function Field({
  label,
  hint,
  children,
  htmlFor,
}: {
  label: string;
  hint?: string;
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-semibold text-ink">
        {label}
      </label>
      {children}
      {hint && <p className="text-[0.82rem] text-muted">{hint}</p>}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className = '', ...props },
  ref,
) {
  return <input ref={ref} className={`${control} ${className}`} {...props} />;
});

export function Select({ className = '', children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={`${control} appearance-auto ${className}`} {...props}>
      {children}
    </select>
  );
}

export function useFieldId() {
  return useId();
}

export function ErrorNote({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="rounded-md border border-signal/40 bg-signal-soft px-3 py-2 text-sm text-ink">
      {children}
    </p>
  );
}

export function PageHeader({ title, sub, actions }: { title: string; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-[2rem] font-semibold md:text-[2.4rem]">{title}</h1>
        {sub && <p className="mt-1 text-muted">{sub}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </header>
  );
}

export function Panel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-lg border border-line bg-panel ${className}`}>{children}</section>;
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-10 text-muted" role="status">
      <Loader2 className="size-5 animate-spin" aria-hidden />
      {label}
    </div>
  );
}

/** Native <dialog>: focus trapping, Esc to close and the backdrop come for free. */
export function Dialog({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      className="m-auto w-[min(34rem,calc(100vw-2rem))] rounded-xl border border-line bg-panel p-0 text-ink shadow-2xl backdrop:bg-black/45"
    >
      <div className="flex items-center justify-between border-b border-line px-5 py-4">
        <h2 id={titleId} className="text-2xl font-semibold">
          {title}
        </h2>
        <button
          type="button"
          onClick={onClose}
          className="grid size-10 place-items-center rounded-md text-muted hover:bg-board"
          aria-label="Close"
        >
          <X className="size-5" />
        </button>
      </div>
      <div className="px-5 py-5">{open && children}</div>
    </dialog>
  );
}
