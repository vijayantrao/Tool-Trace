/** Dates and times as people at the plant read them (the site time zone). */
const zone = () => process.env.TOOLTRACE_SITE_TZ ?? 'Asia/Kolkata';

export const formatSiteTime = (d: Date | string) =>
  new Intl.DateTimeFormat('en-IN', { timeZone: zone(), day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(d));

/** "2026-11-03" (a calendar date) -> "3 Nov 2026". */
export const formatDay = (d: string) =>
  new Intl.DateTimeFormat('en-IN', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(`${d}T00:00:00Z`));
