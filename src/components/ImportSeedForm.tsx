import { useRef, useState } from "react";
import { bip39UniqueMatch, isBip39Word } from "../lib/vault/bip39Wordlist";
import { ErrorCircleIcon, EyeIcon, EyeOffIcon } from "./BannerIcons";
import { tf, useT } from "../lib/i18n";

type WordCount = 12 | 24;

// How long the filled-in suffix visibly pulses before focus jumps to the
// next field — long enough to actually see it happen, short enough not to
// feel like a delay.
const AUTOCOMPLETE_ANIMATION_MS = 260;

function normalizeToken(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z]/g, "");
}

function resizeWords(words: string[], count: WordCount): string[] {
  const next = words.slice(0, count);
  while (next.length < count) next.push("");
  return next;
}

// Per-word validity for the border/color hint only — the real checksum
// check still happens via the WASM SDK's validateMnemonic() after submit.
function wordState(word: string): "empty" | "valid" | "invalid" {
  if (!word) return "empty";
  return isBip39Word(word) ? "valid" : "invalid";
}

export default function ImportSeedForm({
  onSubmit,
  onCancel,
  error,
  busy,
}: {
  onSubmit: (mnemonic: string) => void;
  onCancel: () => void;
  error: string | null;
  busy: boolean;
}) {
  const t = useT();
  const [wordCount, setWordCount] = useState<WordCount>(12);
  const [words, setWords] = useState<string[]>(() => Array(12).fill(""));
  const [revealed, setRevealed] = useState(false);
  const [autocompletedIndex, setAutocompletedIndex] = useState<number | null>(null);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  const focusField = (index: number, atStart = false) => {
    const el = inputRefs.current[index];
    if (!el) return;
    el.focus();
    if (atStart) el.setSelectionRange(0, 0);
    else el.setSelectionRange(el.value.length, el.value.length);
  };

  const setWord = (index: number, value: string) => {
    setWords((prev) => {
      const next = [...prev];
      next[index] = value;
      return next;
    });
  };

  const distributePaste = (startIndex: number, text: string) => {
    const tokens = text
      .split(/\s+/)
      .map(normalizeToken)
      .filter(Boolean);
    if (tokens.length === 0) return;
    // Pasting a whole phrase (12 or 24 words) from the very first field is
    // the common case — switch word count to match rather than truncating
    // half the phrase away.
    let targetCount = wordCount;
    if (startIndex === 0 && (tokens.length === 12 || tokens.length === 24)) {
      targetCount = tokens.length as WordCount;
      setWordCount(targetCount);
    }
    setWords((prev) => {
      const base = resizeWords(prev, targetCount);
      tokens.forEach((tok, i) => {
        if (startIndex + i < base.length) base[startIndex + i] = tok;
      });
      return base;
    });
    const lastFilled = Math.min(startIndex + tokens.length, targetCount) - 1;
    requestAnimationFrame(() => focusField(lastFilled));
  };

  const handleChange = (index: number, raw: string) => {
    if (/\s/.test(raw)) {
      // A typed space means "word finished, move on" — always advance
      // exactly one field, regardless of whether the word typed so far is
      // itself a complete BIP39 word (about 49 of them, e.g. "act", "add",
      // "all", are also a prefix of a longer word, so they'd never trigger
      // the unique-match auto-advance below on their own). Real multi-word
      // pastes never reach here — onPaste already intercepts those.
      const word = normalizeToken(raw.split(/\s+/)[0] ?? "");
      setWord(index, word);
      if (index < wordCount - 1) requestAnimationFrame(() => focusField(index + 1));
      return;
    }
    const previous = words[index];
    const normalized = normalizeToken(raw);
    const grew = normalized.length > previous.length;
    // Once the typed prefix narrows the wordlist to exactly one word, fill
    // in the rest and jump to the next field — BIP39 words are constructed
    // so a 3-4 letter prefix is already enough to know the whole word.
    const unique = grew ? bip39UniqueMatch(normalized) : null;
    if (unique && unique !== normalized) {
      setWord(index, unique);
      setAutocompletedIndex(index);
      if (index < wordCount - 1) {
        setTimeout(() => {
          setAutocompletedIndex((cur) => (cur === index ? null : cur));
          focusField(index + 1);
        }, AUTOCOMPLETE_ANIMATION_MS);
      }
      return;
    }
    setWord(index, normalized);
    if (unique === normalized && index < wordCount - 1) {
      setAutocompletedIndex(index);
      setTimeout(() => {
        setAutocompletedIndex((cur) => (cur === index ? null : cur));
        focusField(index + 1);
      }, AUTOCOMPLETE_ANIMATION_MS);
    }
  };

  const handleKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    const el = e.currentTarget;
    if (e.key === "Enter") {
      e.preventDefault();
      if (index < wordCount - 1) focusField(index + 1);
      return;
    }
    if (e.key === "Backspace" && el.value === "" && index > 0) {
      e.preventDefault();
      focusField(index - 1);
      return;
    }
    if (e.key === "ArrowLeft" && el.selectionStart === 0 && el.selectionEnd === 0 && index > 0) {
      e.preventDefault();
      focusField(index - 1);
      return;
    }
    if (
      e.key === "ArrowRight" &&
      el.selectionStart === el.value.length &&
      el.selectionEnd === el.value.length &&
      index < wordCount - 1
    ) {
      e.preventDefault();
      focusField(index + 1);
    }
  };

  const changeWordCount = (count: WordCount) => {
    setWordCount(count);
    setWords((prev) => resizeWords(prev, count));
  };

  const filledCount = words.filter(Boolean).length;
  const allValid = words.length === wordCount && words.every((w) => isBip39Word(w));

  return (
    <div className="centered-screen">
      <div className="auth-card">
        <h1>{t("Import peněženky")}</h1>
        <p className="muted">{t("Zadej svou seed phrase — každé slovo do vlastního políčka.")}</p>

        <div className="word-count-toggle">
          <button
            type="button"
            className={wordCount === 12 ? "" : "secondary"}
            onClick={() => changeWordCount(12)}
          >
            {tf(t("{n} slov"), { n: 12 })}
          </button>
          <button
            type="button"
            className={wordCount === 24 ? "" : "secondary"}
            onClick={() => changeWordCount(24)}
          >
            {tf(t("{n} slov"), { n: 24 })}
          </button>
        </div>

        <div className="mnemonic-input-grid">
          {words.map((word, i) => {
            const state = wordState(word);
            const autocompleted = autocompletedIndex === i;
            return (
              <div key={i} className={`mnemonic-input-word state-${state}${autocompleted ? " autocompleted" : ""}`}>
                <span className="idx">{i + 1}</span>
                <input
                  ref={(el) => {
                    inputRefs.current[i] = el;
                  }}
                  type={revealed ? "text" : "password"}
                  value={word}
                  onChange={(e) => handleChange(i, e.target.value)}
                  onKeyDown={(e) => handleKeyDown(i, e)}
                  onPaste={(e) => {
                    e.preventDefault();
                    distributePaste(i, e.clipboardData.getData("text"));
                  }}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  inputMode="text"
                  name={`bip39-word-slot-${i}`}
                  aria-label={tf(t("Slovo {n}"), { n: i + 1 })}
                  data-lpignore="true"
                  data-1p-ignore="true"
                  data-bwignore="true"
                  data-form-type="other"
                  data-gramm="false"
                />
              </div>
            );
          })}
        </div>

        <div className="mnemonic-import-footer">
          <span className="muted small">
            {tf(t("Vyplněno {filled}/{total}"), { filled: filledCount, total: wordCount })}
          </span>
          <button type="button" className="icon-toggle" onClick={() => setRevealed((r) => !r)} aria-label={t("Zobrazit/skrýt slova")}>
            {revealed ? <EyeOffIcon /> : <EyeIcon />}
          </button>
        </div>

        {error && (
          <div className="banner banner-danger">
            <ErrorCircleIcon />
            <span>{error}</span>
          </div>
        )}

        <div className="stack">
          <button disabled={busy || !allValid} onClick={() => onSubmit(words.join(" "))}>
            {t("Pokračovat")}
          </button>
          <button className="secondary" onClick={onCancel}>
            {t("Zpět")}
          </button>
        </div>
      </div>
    </div>
  );
}
