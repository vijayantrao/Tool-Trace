import type { ReactNode } from 'react';
import { Drill, Ruler, Wrench, Zap } from 'lucide-react';
import { Wordmark } from '@/components/app-shell';

/** Split screen: a small shadow board on the left, the form on the right. */
export default function AuthLayout({ children }: { children: ReactNode }) {
  const outlines = [
    { Icon: Wrench, tag: 'TW-0101', out: false },
    { Icon: Ruler, tag: 'VC-0301', out: true },
    { Icon: Zap, tag: 'MM-0201', out: false },
    { Icon: Drill, tag: 'IW-0701', out: false },
  ];
  return (
    <div className="grid min-h-dvh lg:grid-cols-[1fr_minmax(28rem,36rem)]">
      <div className="pegboard relative hidden flex-col justify-between p-12 lg:flex">
        <div className="text-machine">
          <Wordmark />
        </div>
        <div className="grid max-w-md grid-cols-2 gap-5">
          {outlines.map(({ Icon, tag, out }) => (
            <div
              key={tag}
              className={`flex aspect-[5/4] flex-col justify-between rounded-xl border-2 p-4 ${
                out ? 'border-dashed border-muted/45' : 'border-ink/15 bg-panel'
              }`}
            >
              <span className="tag-plate text-ink">{tag}</span>
              <Icon
                className={`mx-auto size-14 ${out ? 'text-muted/60' : 'text-ink'}`}
                strokeWidth={out ? 1.25 : 1.6}
                strokeDasharray={out ? '2.5 2.5' : undefined}
                aria-hidden
              />
              <span className="text-sm text-muted">{out ? 'Out with Asha V.' : 'In the crib'}</span>
            </div>
          ))}
        </div>
        <p className="max-w-sm text-lg text-muted">
          Every tool has a place on the board. When one is out, its outline tells you who has it and when it&apos;s due back.
        </p>
      </div>
      <div className="flex flex-col bg-panel px-6 py-10 sm:px-12">
        <div className="mb-16 text-machine lg:hidden">
          <Wordmark />
        </div>
        <div className="my-auto w-full max-w-sm">{children}</div>
      </div>
    </div>
  );
}
