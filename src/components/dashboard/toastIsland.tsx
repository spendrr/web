import { useT } from "../../lib/i18n";

// Beta (v2) toast: the amount travels separately from the sentence, so the
// island can show it as the headline instead of burying it mid-message.
// `message` stays the full sentence for v1 and the OS notification.
export type ToastDetail = { title: string; amountSats: number; direction: "in" | "out" };

export type ToastTone = "in" | "out" | "success" | "danger" | "neutral" | "offline" | "arkDown" | "online";

export type NetIsland = { kind: "offline" | "arkDown" | "back" | "backArk"; closing: boolean };

export const NET_ISLAND_COPY: Record<NetIsland["kind"], { tone: ToastTone; headline: string; title: string }> = {
  offline: { tone: "offline", headline: "Jsi offline", title: "Zůstatek se obnoví, až se připojíš." },
  // Sends are not blocked: the probe only proves the server's front door
  // isn't answering, and a payment may still go through once it does.
  arkDown: { tone: "arkDown", headline: "Server Arku neodpovídá", title: "Platby se můžou zdržet." },
  back: { tone: "online", headline: "Jsi zase online", title: "Obnovuji zůstatek…" },
  backArk: { tone: "online", headline: "Server zase odpovídá", title: "Obnovuji zůstatek…" },
};

// Colour follows what happened, not the old kind: a sent payment is "danger"
// in v1 (red), which read as a failure. In the island it gets the accent.
export function toastTone(kind: "success" | "danger" | "neutral", detail?: ToastDetail): ToastTone {
  return detail ? detail.direction : kind;
}

export function ToastIslandIcon({ tone }: { tone: ToastTone }) {
  const d =
    tone === "in"
      ? "M17 7 7 17M16 17H7V8"
      : tone === "out"
        ? "M7 17 17 7M8 7h9v9"
        : tone === "danger"
          ? "M12 7v6M12 17h.01"
          : tone === "offline"
            ? "M4.5 10a11 11 0 0 1 4-2.4M13.5 7.2A11 11 0 0 1 19.5 10M7.5 13.5a6 6 0 0 1 3-1.5M15 12.6a6 6 0 0 1 1.5.9M12 17.5h.01M4 4l16 16"
            : tone === "arkDown"
              ? "M4 4l16 16M7 7.6A5 5 0 0 0 8 18h8.5M19.6 16.4A3.5 3.5 0 0 0 16.5 11h-.7A6 6 0 0 0 10.2 6.4"
              : tone === "online"
                ? "M4.5 10a11 11 0 0 1 15 0M7.5 13.5a6 6 0 0 1 9 0M12 17.5h.01"
                : "m5.5 12.5 4 4 9-9.5";
  return (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d={d} stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Copies the SDK's own error text, for a bug report: the toast itself only
// says "Něco se nepovedlo." for an error appErrors doesn't recognise.
export function ToastCopyButton({ raw, copied, onCopy }: { raw: string; copied: boolean; onCopy: (raw: string) => void }) {
  const t = useT();
  return (
    <button
      type="button"
      className="toast-island-copy"
      onClick={() => onCopy(raw)}
      aria-label={copied ? t("Zkopírováno") : t("Zkopírovat chybu")}
    >
      {copied ? t("Zkopírováno") : t("Kopírovat")}
    </button>
  );
}
