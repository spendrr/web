import type { ReactNode } from "react";

// Line icons for the Settings rows: 24 grid, 2 px round stroke, same family as
// BannerIcons. Decorative, so hidden from assistive tech (the row label names it).
function Icon({ children }: { children: ReactNode }) {
  return (
    <span className="settings-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {children}
      </svg>
    </span>
  );
}

export function LockIcon() {
  return (
    <Icon>
      <rect x="5" y="11" width="14" height="9" rx="2.5" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </Icon>
  );
}

export function FingerprintIcon() {
  return (
    <Icon>
      <path d="M12 4a7 7 0 0 0-7 7v1.5" />
      <path d="M12 4a7 7 0 0 1 7 7v1" />
      <path d="M12 8a3.5 3.5 0 0 0-3.5 3.5V14c0 2-.5 3.5-1.5 5" />
      <path d="M12 8a3.5 3.5 0 0 1 3.5 3.5V13c0 2 .5 3.5 1.5 5" />
      <path d="M12 12v2c0 2.5.5 4.5 2 6.5" />
    </Icon>
  );
}

export function TimerIcon() {
  return (
    <Icon>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </Icon>
  );
}

export function ShakeIcon() {
  return (
    <Icon>
      <rect x="8" y="4" width="8" height="16" rx="2" />
      <path d="M4.5 9v6M19.5 9v6" />
    </Icon>
  );
}

export function ShieldIcon() {
  return (
    <Icon>
      <path d="M12 3.5l7 2.5v5.5c0 4.2-2.8 7.4-7 9-4.2-1.6-7-4.8-7-9V6l7-2.5Z" />
      <path d="M9 12l2.2 2.2L15 10.5" />
    </Icon>
  );
}

export function SeedEyeIcon() {
  return (
    <Icon>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="3" />
    </Icon>
  );
}

export function CoinsIcon() {
  return (
    <Icon>
      <path d="M4 7c0 1.7 3.6 3 8 3s8-1.3 8-3-3.6-3-8-3-8 1.3-8 3Z" />
      <path d="M4 7v5c0 1.7 3.6 3 8 3s8-1.3 8-3V7" />
      <path d="M4 12v5c0 1.7 3.6 3 8 3s8-1.3 8-3v-5" />
    </Icon>
  );
}

// A block: what "on-chain" means.
export function BlockIcon() {
  return (
    <Icon>
      <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3Z" />
      <path d="M4 7.5l8 4.5 8-4.5M12 12v9" />
    </Icon>
  );
}

export function GiftIcon() {
  return (
    <Icon>
      <rect x="3" y="8.5" width="18" height="4" rx="1.2" />
      <path d="M5 12.5V19a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19v-6.5" />
      <path d="M12 8.5v12" />
      <path d="M12 8.5C10 8.5 7.8 8 7.8 6.2 7.8 4.8 8.8 4 10 4c1.6 0 2 2.4 2 4.5Zm0 0c2 0 4.2-.5 4.2-2.3C16.2 4.8 15.2 4 14 4c-1.6 0-2 2.4-2 4.5Z" />
    </Icon>
  );
}

export function LogIcon() {
  return (
    <Icon>
      <path d="M7 3.5h7l4 4V20a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z" />
      <path d="M14 3.5V8h4M9 12h6M9 16h6" />
    </Icon>
  );
}

export function ExitIcon() {
  return (
    <Icon>
      <path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4" />
      <path d="M15 8l4 4-4 4" />
      <path d="M19 12H9" />
    </Icon>
  );
}

export function TrashIcon() {
  return (
    <Icon>
      <path d="M4 7h16" />
      <path d="M9 7V4.5h6V7" />
      <path d="M6.5 7l1 13h9l1-13" />
      <path d="M10.25 11v5M13.75 11v5" />
    </Icon>
  );
}
