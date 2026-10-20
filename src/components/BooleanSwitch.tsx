// Real on/off switch (track + thumb), used only in v2 — v1 keeps whatever
// two-button pattern each caller already had. The thumb is a fixed light
// color regardless of theme (like an iOS switch): tying it to --surface
// made it go near-black in dark mode, sitting on the orange track like a
// rendering bug rather than a knob.
//
// Its own file rather than living in Settings.tsx (where it used to): a
// caller outside Settings that only wants this one small toggle (e.g.
// ProfileSheet.tsx's Lightning-address opt-in) would otherwise statically
// pull the whole Settings.tsx module graph into its own chunk — Settings is
// normally lazy-loaded from Dashboard.tsx, and a static import elsewhere
// defeats that split. Seen live: importing it from Settings.tsx directly
// grew the main bundle by ~23KB gzip.
export function BooleanSwitch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`boolean-switch${checked ? " on" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span className="boolean-switch-thumb" />
    </button>
  );
}
