import { useEffect, useRef, useState } from "react";
import { useT } from "../../lib/i18n";
import { CopyGlyph } from "../sheet/SendConfirmSheet";

// Long values (invoices, payment hashes, addresses) render as a middle-truncated
// monospace snippet with a copy button, instead of the raw string breaking across
// several wrapped lines — a full lnbc1... invoice is 300+ chars.
function truncateMiddle(value: string, head = 10, tail = 6): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export function CopyRow({ label, value }: { label: string; value: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <div className="info-row">
      <span>{label}</span>
      <div className="copy-value">
        <code>{truncateMiddle(value)}</code>
        <button
          type="button"
          className="copy-btn"
          aria-label={t("Kopírovat")}
          onClick={() => {
            navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? <CopiedIcon /> : <CopyIcon />}
        </button>
      </div>
    </div>
  );
}

// Copy row of the payment detail: the same tap-to-copy row as the address in the
// send confirm sheet (whole row is the button, glyph at the end, a word in
// place of the value, and a rejected clipboard write never reads as copied).
export function SheetCopyRow({ label, value }: { label: string; value: string }) {
  const t = useT();
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copied = state === "copied";
  return (
    <button
      type="button"
      className={`info-row txd-copy sht-send-copy${copied ? " is-copied" : ""}`}
      aria-label={`${t("Kopírovat")}: ${value}`}
      onClick={() => {
        const settle = (next: "copied" | "failed") => {
          setState(next);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setState("idle"), 1200);
        };
        navigator.clipboard.writeText(value).then(
          () => settle("copied"),
          () => settle("failed"),
        );
      }}
    >
      <span>{label}</span>
      <span className="sht-send-addr">
        <code>{state === "idle" ? truncateMiddle(value) : copied ? t("Zkopírováno") : t("Nelze zkopírovat")}</code>
        <CopyGlyph done={copied} />
      </span>
    </button>
  );
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="8" y="8" width="12" height="12" rx="2.5" stroke="currentColor" strokeWidth="2" />
      <path
        d="M16 8V6.5a2.5 2.5 0 0 0-2.5-2.5h-7A2.5 2.5 0 0 0 4 6.5v7A2.5 2.5 0 0 0 6.5 16H8"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CopiedIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M5 13l4 4 10-10" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
