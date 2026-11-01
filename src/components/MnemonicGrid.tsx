import { useEffect, useState } from "react";
import { tf, useT } from "../lib/i18n";

const REVEAL_STEP = 3;

// Shows the seed phrase progressively (3 words per tap of "Zobrazit další")
// instead of all 12 at once — a phone screen glanced at over someone's
// shoulder, or a screenshot taken a beat too early, exposes only a few
// words at a time instead of the whole phrase.
export default function MnemonicGrid({
  words,
  onAllRevealedChange,
  tiles = false,
  revealAll = false,
  onContinue,
  continueLabel,
  continueDisabled = false,
}: {
  words: string[];
  // One tile per word in two columns, laid out like the import form's cells, instead of one boxed three-column list.
  tiles?: boolean;
  // All words from the start, for a screen the person opened on purpose (the backup sheet) where stepping through
  // three at a time is only a detour.
  revealAll?: boolean;
  // Lets the parent gate its own "I wrote it down, continue" button on
  // actually having stepped through every word — without this, a caller
  // that only checks its own state has no way to know the user still has
  // dots on words 4-12 when they click continue.
  onAllRevealedChange?: (allRevealed: boolean) => void;
  // The way on, as the same button that stepped through the words: once the last ones are shown it turns into
  // "I wrote it down" in place (colour and label ease over), instead of one button vanishing and another appearing.
  onContinue?: () => void;
  continueLabel?: string;
  continueDisabled?: boolean;
}) {
  const t = useT();
  const [revealedCount, setRevealedCount] = useState(revealAll ? words.length : REVEAL_STEP);
  const allRevealed = revealedCount >= words.length;

  useEffect(() => {
    onAllRevealedChange?.(allRevealed);
    // onAllRevealedChange is expected to be a stable setState-style callback;
    // omitting it from deps avoids re-firing on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allRevealed]);

  return (
    <>
      <div className={`mnemonic-grid${tiles ? " is-tiles" : ""}`}>
        {words.map((w, i) => (
          <div key={i} className="mnemonic-word">
            <span className="idx">{i + 1}</span>
            {i < revealedCount ? (
              <span className="mnemonic-w">{w}</span>
            ) : (
              <span className="mnemonic-dots" aria-label={tf(t("Slovo {n} skryté"), { n: i + 1 })}>
                •••••
              </span>
            )}
          </div>
        ))}
      </div>
      {(!allRevealed || (onContinue && continueLabel)) && (
        <button
          type="button"
          className={`mnemonic-next${allRevealed ? "" : " secondary"}`}
          disabled={allRevealed && continueDisabled}
          onClick={() => (allRevealed ? onContinue?.() : setRevealedCount((c) => Math.min(c + REVEAL_STEP, words.length)))}
        >
          <span key={allRevealed ? "go" : "more"} className="mnemonic-next-label">
            {allRevealed
              ? continueLabel
              : tf(t("Zobrazit další ({shown}/{total})"), {
                  shown: Math.min(revealedCount + REVEAL_STEP, words.length),
                  total: words.length,
                })}
          </span>
        </button>
      )}
    </>
  );
}
