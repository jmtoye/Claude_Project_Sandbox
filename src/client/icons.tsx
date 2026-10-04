import type { Status } from '../shared/types';

const S = (p: { children: any; title?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden={p.title ? undefined : 'true'} role={p.title ? 'img' : undefined}>
    {p.title && <title>{p.title}</title>}
    {p.children}
  </svg>
);

export const StatusIcon = ({ status }: { status: Status }) => {
  switch (status) {
    case 'on_track':
      return (
        <S>
          <circle cx="12" cy="12" r="9" fill="currentColor" stroke="none" />
          <path d="M8 12.5l2.6 2.6L16.2 9.5" stroke="#0b1a0b" stroke-width="2.6" />
        </S>
      );
    case 'in_progress':
      return (
        <S>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor" stroke="none" />
        </S>
      );
    case 'at_risk':
      return (
        <S>
          <path d="M12 3l9.5 17h-19z" fill="currentColor" stroke="none" />
          <path d="M12 9.5v4.5M12 17h.01" stroke="#1d1503" stroke-width="2.6" />
        </S>
      );
    case 'blocked':
      return (
        <S>
          <path d="M8 2.8h8l5.2 5.2v8L16 21.2H8L2.8 16V8z" fill="currentColor" stroke="none" />
          <path d="M7.5 12h9" stroke="#fff" stroke-width="2.6" />
        </S>
      );
    default:
      return (
        <S>
          <circle cx="12" cy="12" r="8.5" stroke-dasharray="3.2 3" />
        </S>
      );
  }
};

export const PinIcon = () => (
  <S title="Pinned">
    <path d="M9 3h6l-1 6 4 3v2H6v-2l4-3z" fill="currentColor" />
    <path d="M12 14v7" />
  </S>
);
export const LockIcon = () => (
  <S title="Only me">
    <rect x="5" y="11" width="14" height="10" rx="2" fill="currentColor" stroke="none" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </S>
);
export const AlertIcon = () => (
  <S>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7.5v5.5M12 16.5h.01" />
  </S>
);
export const RefreshIcon = () => (
  <S>
    <path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" />
  </S>
);
export const ScreenIcon = () => (
  <S>
    <rect x="3" y="4" width="18" height="12" rx="2" />
    <path d="M8 20h8M12 16v4" />
  </S>
);
export const SparkIcon = () => (
  <S>
    <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6" />
  </S>
);
export const PlusIcon = () => (
  <S>
    <path d="M12 5v14M5 12h14" />
  </S>
);
export const Logo = () => (
  <svg viewBox="0 0 32 32" aria-hidden="true">
    <rect x="3" y="4" width="12" height="11" rx="3" fill="#3987e5" />
    <rect x="17" y="4" width="12" height="11" rx="3" fill="#5b616e" />
    <rect x="3" y="17" width="12" height="11" rx="3" fill="#5b616e" />
    <rect x="17" y="17" width="12" height="11" rx="3" fill="#0ca30c" />
  </svg>
);
