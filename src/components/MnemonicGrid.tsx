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
}: {
  words: string[];
  // Lets the parent gate its own "I wrote it down, continue" button on
  // actually having stepped through every word — without this, a caller
  // that only checks its own state has no way to know the user still has
  // dots on words 4-12 when they click continue.
  onAllRevealedChange?: (allRevealed: boolean) => void;
}) {
  const t = useT();
  const [revealedCount, setRevealedCount] = useState(REVEAL_STEP);
  const allRevealed = revealedCount >= words.length;

  useEffect(() => {
    onAllRevealedChange?.(allRevealed);
    // onAllRevealedChange is expected to be a stable setState-style callback;
    // omitting it from deps avoids re-firing on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allRevealed]);

  return (
    <>
      <div className="mnemonic-grid">
        {words.map((w, i) => (
          <div key={i} className="mnemonic-word">
            <span className="idx">{i + 1}</span>
            {i < revealedCount ? (
              w
            ) : (
              <span className="mnemonic-dots" aria-label={tf(t("Slovo {n} skryté"), { n: i + 1 })}>
                •••••
              </span>
            )}
          </div>
        ))}
      </div>
      {!allRevealed && (
        <button
          type="button"
          className="secondary"
          onClick={() => setRevealedCount((c) => Math.min(c + REVEAL_STEP, words.length))}
        >
          {tf(t("Zobrazit další ({shown}/{total})"), {
            shown: Math.min(revealedCount + REVEAL_STEP, words.length),
            total: words.length,
          })}
        </button>
      )}
    </>
  );
}
