import { Fragment, useState } from "react";
import { useLang, useT } from "../lib/i18n";
import "./Welcome.css";

// One span per word so the headline can land word by word; `from` keeps the stagger running across both lines.
function words(text: string, from: number) {
  const parts = text.split(" ");
  return parts.map((w, i) => (
    <Fragment key={i}>
      <span className="wl-w" style={{ ["--w" as string]: from + i }}>
        {w}
      </span>
      {i < parts.length - 1 ? " " : null}
    </Fragment>
  ));
}

// Onboarding entry. One screen: what this is, what it does for you, and the two ways in.
//
// The three cards carry the trust claims. Each one holds a short line and, behind the "+", the honest detail —
// the thing a skeptic actually wants (that we cannot recover a seed for them, that nothing is asked of them).
// Putting that behind a tap keeps the screen calm without hiding it.
export default function Welcome({
  busy,
  onCreate,
  onImport,
}: {
  busy: boolean;
  onCreate: () => void;
  onImport: () => void;
}) {
  const t = useT();
  const lang = useLang();
  const [open, setOpen] = useState<number | null>(null);
  const line1 = t("Měj bitcoin u sebe.");
  const line2 = t("Ne na burze.");

  const cards = [
    {
      icon: <KeyIcon />,
      title: t("Klíče máš jen ty"),
      line: t("Uložené v telefonu."),
      detail: t("Seed je zašifrovaný jen v tomhle zařízení. Nemáme ho a nemůžeme ti ho obnovit."),
    },
    {
      icon: <NoAccountIcon />,
      title: t("Bez registrace"),
      line: t("Žádný e-mail."),
      detail: t("Nechceme jméno, telefon ani doklad. Peněženku máš hotovou za pár vteřin."),
    },
    {
      icon: <BoltIcon />,
      title: t("Platby za vteřiny"),
      line: t("Stačí @jméno."),
      detail: t("Pošli na @jméno nebo Lightning adresu. Obvykle to trvá pár vteřin."),
    },
    // The objection every one of the cards above provokes. Answering it here, bluntly, is the point.
    {
      icon: <RestoreIcon />,
      title: t("Ztratíš telefon?"),
      line: t("12 slov tě vrátí."),
      detail: t("Zapiš si 12 slov na papír. Obnovíš s nimi peněženku kdekoli. Bez nich to nejde."),
    },
  ];

  return (
    <div className={`wl${lang === "en" ? " is-en" : ""}`}>
      <div className="wl-top">
        <span className="wordmark wl-mark">
          Spend
          <span className="accent-r r1">r</span>
          <span className="accent-r r2">r</span>
        </span>
      </div>

      <div className="wl-main">
        <p className="wl-kicker">{t("Vítej ve Spendrru")}</p>
        <h1 className="wl-title">
          <span className="wl-line">{words(line1, 0)}</span>
          <span className="wl-line wl-accent">
            <span className="wl-rule">{words(line2, line1.split(" ").length)}</span>
          </span>
        </h1>

        <ul className="wl-cards">
          {cards.map((c, i) => (
            <li
              key={i}
              className={`wl-card wl-rise${open === i ? " is-open" : ""}`}
              style={{ ["--i" as string]: i }}
            >
              <span className="wl-card-ico" aria-hidden="true">
                {c.icon}
              </span>
              <div className="wl-card-faces">
                <div className="wl-card-face">
                  <h3>{c.title}</h3>
                  <p>{c.line}</p>
                </div>
                <div className="wl-card-face wl-card-back">
                  <p>{c.detail}</p>
                </div>
              </div>
              <button
                type="button"
                className="wl-card-more"
                aria-expanded={open === i}
                aria-label={open === i ? t("Zavřít") : c.title}
                onClick={() => setOpen((o) => (o === i ? null : i))}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
                </svg>
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="wl-actions wl-rise" style={{ ["--i" as string]: 3 }}>
        <button type="button" disabled={busy} onClick={onCreate}>
          {t("Vytvořit peněženku")}
        </button>
        <button type="button" className="secondary" disabled={busy} onClick={onImport}>
          {t("Mám seed phrase")}
        </button>
        <nav className="wl-proof" aria-label={t("Ověř si sám")}>
          <a href="https://github.com/spendrr/web" target="_blank" rel="noopener">
            {t("Zdrojový kód")}
          </a>
          <a href="/learn" target="_blank" rel="noopener">
            {t("Jak to funguje")}
          </a>
          <a href="/privacy" target="_blank" rel="noopener">
            {t("Soukromí")}
          </a>
        </nav>
      </div>
    </div>
  );
}

const ico = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

// The teeth sit on the shaft line and hang off one side of it. The tip runs a short way past the outer tooth —
// enough to read as the end of a key, where the full-length stub read as a stray line.
function KeyIcon() {
  return (
    <svg {...ico}>
      <circle cx="8" cy="15.5" r="4.2" />
      <path d="M11 12.5 18.7 4.8M16.5 7l3 3M14 9.5l2.5 2.5" />
    </svg>
  );
}

// The shoulders run the full width; a body cut short on one side reads as a drawing error, not as a crossed-out figure.
function NoAccountIcon() {
  return (
    <svg {...ico}>
      <circle cx="12" cy="8" r="3.4" />
      <path d="M5.6 19.4c.7-3.4 3.3-5.3 6.4-5.3s5.7 1.9 6.4 5.3" />
      <path d="M3.6 3.6 20.4 20.4" />
    </svg>
  );
}

function RestoreIcon() {
  return (
    <svg {...ico}>
      <path d="M3.4 3.4v5.6h5.6" />
      <path d="M3.9 14.3a8.6 8.6 0 1 0 2.2-8.2L3.4 9" />
    </svg>
  );
}

function BoltIcon() {
  return (
    <svg {...ico}>
      <path d="M13.8 2.2 5.2 12.9h5.1l-1.1 8.9 8.6-10.7h-5.1l1.1-8.9Z" />
    </svg>
  );
}
