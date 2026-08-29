import type { SVGProps } from 'react';

const PATHS = {
  copy: 'M8 8h10v12H8zM6 16H4V4h12v2',
  file: 'M14 3H6v18h12V7zM14 3v4h4M9 13h6M9 17h6',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  close: 'M6 6l12 12M18 6 6 18',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  expand: 'M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7',
  fit: 'M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5',
  pin: 'M9 3h6l-1 7 3 3v2H7v-2l3-3zM12 15v6',
  unpin: 'M9 3h6l-1 7 3 3v2H7v-2l3-3zM12 15v6M4 4l16 16',
  settings: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.5-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.5 2 1.5A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.5 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.5-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.5-2-1.5c.1-.4.1-.8.1-1.2z',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M21 13.5A8.5 8.5 0 0 1 10.5 3a7 7 0 1 0 10.5 10.5z',
  eye: 'M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  chevronDown: 'M6 9l6 6 6-6',
  chevronRight: 'M9 6l6 6-6 6',
  arrowLeft: 'M19 12H5M11 6l-6 6 6 6',
  arrowRight: 'M5 12h14M13 6l6 6-6 6',
  external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6',
  refresh: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5',
  graph: 'M5 5a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM19 5a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM12 15a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM6.5 8.5l4.3 6M17.5 8.5l-4.3 6M7 7h10',
  list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  quote: 'M7 7h5v5H8a1 1 0 0 0-1 1v3H4v-6a3 3 0 0 1 3-3zM16 7h5v5h-4a1 1 0 0 0-1 1v3h-3v-6a3 3 0 0 1 3-3z',
  check: 'M5 12l5 5L20 7',
  alert: 'M12 3l10 18H2zM12 10v4M12 17v.5',
  target: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 12h.01',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v5M12 8v.5',
  sidebar: 'M4 5h16v14H4zM9 5v14',
  tag: 'M4 4h7l9 9-7 7-9-9zM8 8h.01',
  timeline: 'M4 19h16M7 19v-5M12 19V9M17 19v-8',
  bookmark: 'M6 3h12v18l-6-4.5L6 21z',
  folder: 'M3 5h6l2 2h10v12H3z',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, ...rest }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

export function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <line x1="32" y1="32" x2="14" y2="20" stroke="currentColor" strokeWidth="4" opacity="0.45" />
      <line x1="32" y1="32" x2="50" y2="18" stroke="currentColor" strokeWidth="4" opacity="0.45" />
      <line x1="32" y1="32" x2="46" y2="48" stroke="currentColor" strokeWidth="4" opacity="0.45" />
      <line x1="32" y1="32" x2="16" y2="46" stroke="currentColor" strokeWidth="4" opacity="0.45" />
      <circle cx="32" cy="32" r="10" fill="var(--node-seed)" />
      <circle cx="14" cy="20" r="6" fill="var(--node-cited)" />
      <circle cx="50" cy="18" r="6" fill="var(--node-citing)" />
      <circle cx="46" cy="48" r="6" fill="var(--node-cited)" />
      <circle cx="16" cy="46" r="6" fill="var(--node-citing)" />
    </svg>
  );
}
