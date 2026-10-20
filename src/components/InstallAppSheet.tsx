// "Přidej si Spendrr na plochu" (v2 beta, iOS browser tab only). Why it
// exists: see src/lib/vault/storageProtection.ts. iOS has no API that installs a web
// app, so this can only show the way: a small phone plays the three steps on a
// loop, in step with the list beside it (tap a step to jump to it).
//
// Two variants, because the storage of a Home Screen web app is separate from
// Safari's and the installed app starts empty:
// - "onboarding": no wallet exists yet, so the advice is simply to create it
//   in the installed app. The cheap moment, nothing to move.
// - "wallet": a wallet already lives in this tab. The installed app has to be
//   restored from the seed phrase, so the sheet says so and offers the seed.
//
// Shared sheet primitives from sheet/PaySheet; styling in InstallAppSheet.css
// under the `ias-` prefix.
import { useEffect, useState } from "react";
import { useT } from "../lib/i18n";
import { isIpad } from "../lib/vault/storageProtection";
import { Screen, Sheet, useSheetClose } from "./sheet/PaySheet";
import "./InstallAppSheet.css";

const STEP_MS = 2800;
const STEPS = 3;

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

export default function InstallAppSheet({
  variant,
  needsSeed = false,
  onShowSeed,
  onContinueInBrowser,
  onNever,
  onClose,
}: {
  variant: "onboarding" | "wallet";
  // The seed has never been shown on this device (fresh gift recipient).
  needsSeed?: boolean;
  onShowSeed?: () => void;
  // Onboarding only: carry on with what the user tapped before the sheet.
  onContinueInBrowser?: () => void;
  // Shown as "Nepřipomínat" when the sheet came up by itself.
  onNever?: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const { closing, closeThen } = useSheetClose();
  const [step, setStep] = useState(0);
  // Reduced motion: no autoplay; the steps still switch the picture on tap.
  const [autoplay] = useState(() => !prefersReducedMotion());
  // iPad Safari has its bar at the top and opens Share as a popover there.
  const [ipad] = useState(isIpad);

  useEffect(() => {
    if (!autoplay) return;
    const id = window.setTimeout(() => setStep((s) => (s + 1) % STEPS), STEP_MS);
    return () => window.clearTimeout(id);
  }, [step, autoplay]);

  const steps = [
    {
      title: t("Klepni na Sdílet"),
      hint: ipad ? t("V Safari nahoře, případně pod •••") : t("V Safari dole, případně pod •••"),
    },
    { title: t("Vyber Přidat na plochu"), hint: t("Když ji nevidíš, sjeď v nabídce níž") },
    variant === "onboarding"
      ? { title: t("Otevři Spendrr z plochy"), hint: t("Peněženku si založ až tam") }
      : { title: t("Otevři Spendrr z plochy"), hint: t("Tam zvol Mám seed phrase") },
  ];

  return (
    <Sheet closing={closing} onBackdrop={() => closeThen(onClose)} screenKey="install">
      <Screen>
        <h2 className="sht-title">{t("Přidej si Spendrr na plochu")}</h2>
        <p className="sht-sub">
          {variant === "onboarding"
            ? t("iOS maže data webů, které týden neotevřeš. Appka na ploše tohle omezení nemá, tak si peněženku založ rovnou v ní.")
            : t("iOS maže data webů, které týden neotevřeš, a s nimi i tuhle peněženku. Appka na ploše tohle omezení nemá.")}
        </p>

        <div className="ias-demo">
          <PhoneDemo step={step} ipad={ipad} addLabel={t("Přidat na plochu")} />
          <ol className="ias-steps">
            {steps.map((s, i) => (
              <li key={i}>
                <button
                  type="button"
                  className={`ias-step${i === step ? " is-active" : ""}`}
                  aria-current={i === step ? "step" : undefined}
                  onClick={() => setStep(i)}
                >
                  <span className="ias-step-num">{i + 1}</span>
                  <span className="ias-step-text">
                    <strong>{s.title}</strong>
                    <small>{s.hint}</small>
                  </span>
                  {autoplay && i === step && (
                    <span
                      key={`bar-${step}`}
                      className="ias-step-bar"
                      style={{ ["--ias-step-ms" as string]: `${STEP_MS}ms` }}
                    />
                  )}
                </button>
              </li>
            ))}
          </ol>
        </div>

        {variant === "wallet" && (
          <p className={`ias-note${needsSeed ? " is-danger" : ""}`}>
            {needsSeed
              ? t("Appka na ploše začne prázdná a peněženku v ní obnovíš jen seed phrase. Tu ještě nemáš zálohovanou.")
              : t("Appka na ploše má vlastní úložiště a začne prázdná. Peněženku v ní obnovíš seed phrase.")}
          </p>
        )}

        {variant === "wallet" && onShowSeed ? (
          <div className="sht-actions">
            <button type="button" className="secondary" onClick={() => closeThen(onShowSeed)}>
              {t("Zobrazit seed")}
            </button>
            <button type="button" onClick={() => closeThen(onClose)}>
              {t("Rozumím")}
            </button>
          </div>
        ) : (
          <button type="button" className="sht-wide" onClick={() => closeThen(onClose)}>
            {t("Rozumím")}
          </button>
        )}
        {onContinueInBrowser && (
          <button type="button" className="sht-link" onClick={() => closeThen(onContinueInBrowser)}>
            {t("Pokračovat v prohlížeči")}
          </button>
        )}
        {onNever && (
          <button type="button" className="sht-link" onClick={() => closeThen(onNever)}>
            {t("Nepřipomínat")}
          </button>
        )}
      </Screen>
    </Sheet>
  );
}

// A schematic iPhone (or iPad): the Spendrr tab in Safari underneath, the
// share sheet sliding over it, and the Home Screen on top, where the icon
// lands. Which layer shows is driven by data-step alone (CSS), so a step
// jumps cleanly from any other.
function PhoneDemo({ step, ipad, addLabel }: { step: number; ipad: boolean; addLabel: string }) {
  return (
    <div className={`ias-phone${ipad ? " ias-phone--ipad" : ""}`} data-step={step} aria-hidden="true">
      <div className="ias-screen">
        <div className="ias-page">
          <div className="ias-page-head">
            <span className="ias-wordmark">
              Spend<span>r</span>
              <span>r</span>
            </span>
          </div>
          <div className="ias-page-balance" />
          <div className="ias-page-fiat" />
          <div className="ias-page-buttons">
            <span />
            <span />
          </div>
          <div className="ias-page-row" />
          <div className="ias-page-row ias-page-row--short" />
        </div>

        <div className="ias-toolbar">
          <div className="ias-address">spendrr.app</div>
          <div className="ias-toolbar-icons">
            <ChevronGlyph flip />
            <ChevronGlyph />
            <span className="ias-target ias-target--share">
              <ShareGlyph />
              <span className="ias-tap" />
            </span>
            <BookGlyph />
            <TabsGlyph />
          </div>
        </div>

        <div className="ias-dim" />
        <div className="ias-share">
          <div className="ias-share-head">
            <img src="/apple-touch-icon.png" alt="" />
            <span>
              <b>Spendrr</b>
              <i>spendrr.app</i>
            </span>
          </div>
          <div className="ias-share-row">
            <span className="ias-share-bar" />
            <span className="ias-share-ico" />
          </div>
          <div className="ias-share-row ias-share-row--target">
            <span>{addLabel}</span>
            <PlusSquareGlyph />
            <span className="ias-tap" />
          </div>
          <div className="ias-share-row">
            <span className="ias-share-bar ias-share-bar--short" />
            <span className="ias-share-ico" />
          </div>
        </div>

        <div className="ias-home">
          <div className="ias-home-grid">
            {Array.from({ length: 11 }, (_, i) => (
              <span key={i} className={`ias-app ias-app--${i % 4}`} />
            ))}
            <span className="ias-app-new">
              <img src="/apple-touch-icon.png" alt="" />
              <i>Spendrr</i>
            </span>
          </div>
          <div className="ias-dock">
            <span className="ias-app ias-app--1" />
            <span className="ias-app ias-app--2" />
            <span className="ias-app ias-app--3" />
            <span className="ias-app ias-app--0" />
          </div>
        </div>
      </div>
    </div>
  );
}

function ShareGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="ias-glyph">
      <path d="M12 3.5v11M8 7.5l4-4 4 4" />
      <path d="M8.5 10.5H7a2 2 0 0 0-2 2V19a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6.5a2 2 0 0 0-2-2h-1.5" />
    </svg>
  );
}

function PlusSquareGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="ias-glyph">
      <rect x="4" y="4" width="16" height="16" rx="4" />
      <path d="M12 8.5v7M8.5 12h7" />
    </svg>
  );
}

function ChevronGlyph({ flip }: { flip?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className="ias-glyph ias-glyph--dim">
      <path d={flip ? "M14.5 6l-6 6 6 6" : "M9.5 6l6 6-6 6"} />
    </svg>
  );
}

function BookGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="ias-glyph ias-glyph--dim">
      <path d="M12 6.5C10 5 7 4.5 4 5v13c3-.5 6 0 8 1.5 2-1.5 5-2 8-1.5V5c-3-.5-6 0-8 1.5zM12 6.5v13" />
    </svg>
  );
}

function TabsGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="ias-glyph ias-glyph--dim">
      <rect x="4" y="8" width="12" height="12" rx="2.5" />
      <path d="M8 5.5h9.5A2.5 2.5 0 0 1 20 8v9.5" />
    </svg>
  );
}
