import { useEffect, useId, useRef, type ReactNode } from 'react';

// Presentation adapted from the owner's supplied v1 components.jsx HexMark and
// product-components.jsx Icon excerpts. No v1 runtime or data dependencies.
export function HexMark() {
  const id = useId();
  return (
    <svg className="hex-mark" viewBox="0 0 52 48" aria-hidden="true">
      <defs>
        <linearGradient id={id} x1=".2" y1="1" x2=".8" y2="0">
          <stop stopColor="#ffcc00" />
          <stop offset=".45" stopColor="#ff6030" />
          <stop offset=".72" stopColor="#ff007d" />
          <stop offset="1" stopColor="#ef00e7" />
        </linearGradient>
      </defs>
      <path fill={`url(#${id})`} d="M13 1h26l13 23-13 23H13L0 24Z" />
      <path
        d="M7 35 17 17h19l10 18M13 46 22 30h11l9 16M8 34 18 34l7 12"
        fill="none"
        stroke="white"
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </svg>
  );
}
const paths = {
  chart: 'M4 20V13H7V20M10 20V8H13V20M16 20V3H19V20',
  price: 'M12 2V22M17 6H10a4 4 0 0 0 0 8h4a4 4 0 0 1 0 8H6',
  pie: 'M11 3a9 9 0 1 0 10 10H11ZM14 2v8h8a9 9 0 0 0-8-8',
  calendar: 'M5 3V7M19 3V7M3 10H21M3 5H21V22H3Z',
  database: 'M3 6c0-5 18-5 18 0s-18 5-18 0M3 6v12c0 5 18 5 18 0V6M3 12c0 5 18 5 18 0',
  clock: 'M12 7V13L16 16M22 12a10 10 0 1 0-20 0a10 10 0 0 0 20 0',
  download: 'M12 2V16M6 10L12 16L18 10M3 16V22H21V16',
  search: 'M16 16L22 22M18 10a8 8 0 1 0-16 0a8 8 0 0 0 16 0',
  home: 'M2 11L12 2L22 11M5 9V22H10V15H14V22H19V9',
  menu: 'M3 5H21M3 12H21M3 19H21',
  sun: 'M16 12a4 4 0 1 0-8 0a4 4 0 0 0 8 0M12 2V4M12 20V22M2 12H4M20 12H22M5 5L6.5 6.5M17.5 17.5L19 19M5 19L6.5 17.5M17.5 6.5L19 5',
  moon: 'M20.9 13A9 9 0 0 1 11 3.1a9 9 0 1 0 9.9 9.9Z',
  person: 'M16 7a4 4 0 1 0-8 0a4 4 0 0 0 8 0M4 22v-3a8 8 0 0 1 16 0v3Z',
  people:
    'M8 12a4 4 0 1 0 0-8a4 4 0 0 0 0 8M2 21v-3a6 6 0 0 1 12 0v3M17 4a4 4 0 0 1 0 8M17 15a5 5 0 0 1 5 5',
  link: 'M10 14l4-4M8 16l-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0M16 8l1-1a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0',
} as const;
export type IconName = keyof typeof paths;
export function Icon({ name }: { name: IconName }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
export function Dialog({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    id = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.showModal();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return (
    <dialog
      className="site-dialog"
      ref={ref}
      aria-labelledby={id}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="dialog-heading">
        <h2 id={id}>{title}</h2>
        <button autoFocus onClick={onClose}>
          Close
        </button>
      </div>
      {children}
    </dialog>
  );
}
