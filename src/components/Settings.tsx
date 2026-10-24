import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import type { FeeEstimate, RoundFlowKind, RoundState, Vtxo, VtxoState, WalletTransaction } from "@secondts/bark";
import {
  clearCallLog,
  getCallLog,
  pushWorkerWatchdogOverride,
  subscribeCallLog,
  type CallLogEntry,
  type WalletClient,
} from "../lib/wallet/bark";
import { BooleanSwitch } from "./BooleanSwitch";
import { CopyRow } from "./Dashboard";
import {
  decryptMnemonic,
  decryptVaultBytes,
  encryptVaultBytes,
  saveVault,
  zeroBytes,
} from "../lib/vault/crypto";
import { rekeyStoredExitDestination } from "../lib/exit/emergencyExit";
import {
  clearBiometricUnlock,
  enrollBiometricUnlock,
  hasBiometricUnlock,
  isPlatformAuthenticatorAvailable,
} from "../lib/vault/webauthn";
import {
  disableNotifications,
  isNotificationSupported,
  isNotifyEnabled,
  isPushSupported,
  notificationPermission,
} from "../lib/notifications";
import { useBackLayer } from "../lib/ui/backLayers";
import { disableShake, enableShake, isShakeEnabled, isShakeSupported } from "../lib/ui/shakeToHide";
import { getThemePreference, setThemePreference, type ThemePreference } from "../lib/ui/theme";
import { getBgGlowEnabled, setBgGlowEnabled } from "../lib/ui/bgGlow";
import { getColorTheme, setColorTheme, type ColorTheme } from "../lib/ui/colorTheme";
import { getDesignVersion, setDesignVersion, useDesignVersion, type DesignVersion } from "../lib/ui/designVersion";
import { APP_NETWORK } from "../lib/network";
import { formatCallLogHeader } from "../lib/wallet/callLogHeader";
import {
  clearPendingVtxoRefresh,
  getPendingVtxoRefresh,
  setPendingVtxoRefresh,
  type PendingVtxoRefresh,
} from "../lib/maintenance/vtxoRefresh";
import { getFiatCurrency, setFiatCurrency, type FiatCurrency } from "../lib/currency";
import {
  fetchOnchainFees,
  fetchTipBlock,
  getLastKnownFees,
  getLastKnownTipBlock,
  type OnchainFees,
  type TipBlock,
} from "../lib/send/fees";
import { fetchBtcRates, formatFiat, satsToFiat } from "../lib/price";
import { getLastBackupStatus } from "../lib/backup/backup";
import { isHapticsEnabled, isHapticsSupported, setHapticsEnabled } from "../lib/ui/haptics";
import { useMotionOn } from "../lib/ui/motion";
import {
  setChatEnabled,
  setChatPushSettings,
  setReadReceiptsOn,
  useChatEnabled,
  useChatPushOn,
  useChatPushPreview,
  useReadReceiptsOn,
  type ChatPushPreview,
} from "../lib/chat/chatEnabled";
import { isBumpPayEnabled, isBumpPayKillSwitchActive, isBumpPaySupported, setBumpPayEnabled, requestMotionPermission } from "../lib/bump/bump";
import { isAutoLockEnabled, setAutoLockEnabled } from "../lib/vault/autoLock";
import NotificationsSheet from "./NotificationsSheet";
import { getLang, localeFor, setLang, tf, useLang, useT, type Lang } from "../lib/i18n";
import { isPasswordStrong, passwordProblem } from "../lib/vault/password";
import ChangelogSheet from "./ChangelogSheet";
import {
  withTimeout,
  WALLET_CALL_TIMEOUT_MS,
  ONCHAIN_SYNC_TIMEOUT_MS,
  SEND_WATCHDOG_MS,
  TIMEOUT_MESSAGE,
} from "../lib/wallet/walletCall";
import { ErrorCircleIcon, SuccessCircleIcon, WarningIcon } from "./BannerIcons";
import MnemonicGrid from "./MnemonicGrid";
import {
  clearNeedsSeedBackup,
  clearPendingGiftPassword,
  needsSeedBackup,
} from "../lib/gift/giftStore";
import BumpRecorderPage from "./BumpRecorderPage";
import SentGiftsList from "./SentGiftsList";
import { loadVaultOrPrompt, missingVaultText } from "../lib/vault/vaultAccess";
import InstallAppSheet from "./InstallAppSheet";
import {
  getStorageProtection,
  isIosBrowserTab,
  requestPersistentStorage,
  type StorageProtection,
} from "../lib/vault/storageProtection";
import "./Settings.css";
import { rawErrorMessage, surfaceError } from "../lib/appErrors";
import RefreshEnginePanel from "./RefreshEnginePanel";
import { approxTime } from "./RefreshEngineOverview";
import { effectiveEngineMode } from "../lib/refreshEngine/mode";
import { dropVtxoSnapshot } from "../lib/wallet/vtxoSnapshot";
import { computeOverview, engineSnapshot, subscribeEngine, type EngineOverview } from "../lib/refreshEngine/runner";

// Two levels now. The root ("menu") is a signpost: fee widget, four section
// rows, and the About card. The four section pages hold the actual settings,
// and the leaf pages (Změnit heslo, VTXO mince, …) sit under whichever
// section lists them. It used to be one long scroll of thirteen cards.
type SectionPage = "menu" | "security" | "wallet" | "appearance" | "danger";

type Section =
  | SectionPage
  | "vtxos"
  | "onchain-txs"
  | "call-log"
  | "seed"
  | "password"
  | "biometric"
  | "gifts"
  | "bump-lab"
  | "chat-settings";

// Where the back button goes, so a leaf returns to the section that listed it
// rather than jumping the user all the way to the root.
const PARENT: Record<Exclude<Section, "menu">, SectionPage> = {
  security: "menu",
  wallet: "menu",
  appearance: "menu",
  danger: "menu",
  password: "security",
  biometric: "security",
  seed: "security",
  vtxos: "wallet",
  "onchain-txs": "wallet",
  "call-log": "wallet",
  gifts: "wallet",
  "bump-lab": "appearance",
  "chat-settings": "appearance",
};

// Czech source strings — run through t() at the call site like everything else.
const SECTION_TITLE: Record<SectionPage, string> = {
  menu: "Nastavení",
  security: "Zabezpečení",
  wallet: "Peněženka",
  appearance: "Vzhled a chování",
  danger: "Nebezpečná zóna",
};

// isPlatformAuthenticatorAvailable() is async, and SecuritySection mounts
// fresh every time the Zabezpečení page is opened — so the "Odemykání
// otiskem" row was absent on the first paint and inserted a frame later,
// which reads as the page flickering. Resolve it once per session and prime
// it when Settings opens, so the row is there from the first render.
let platformAuthCache: boolean | null = null;
let platformAuthProbe: Promise<boolean> | null = null;

function probePlatformAuthenticator(): Promise<boolean> {
  if (platformAuthCache !== null) return Promise.resolve(platformAuthCache);
  platformAuthProbe ??= isPlatformAuthenticatorAvailable().then((available) => {
    platformAuthCache = available;
    return available;
  });
  return platformAuthProbe;
}

function formatBuildDate(iso: string, lang: Lang): string {
  if (!iso) return lang === "en" ? "unknown" : "neznámé";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return lang === "en" ? "unknown" : "neznámé";
  return d.toLocaleString(lang === "en" ? "en-US" : "cs-CZ", { dateStyle: "medium", timeStyle: "short" });
}

export default function Settings({
  wallet,
  onClose,
  onReset,
  onOpenExit,
  onWaitForIdleRefresh,
  initialSection,
  giftEncryptionKey,
}: {
  wallet: WalletClient;
  onClose: () => void;
  onReset: () => void;
  // Opens the exit sheet, which Dashboard owns (it also opens from the home
  // card and needs the session's exit tracker).
  onOpenExit: () => void;
  onWaitForIdleRefresh?: () => Promise<void>;
  // Open straight to a section instead of the menu — used by the dashboard
  // gift-recipient banner to land on "Zobrazit seed phrase".
  initialSection?: Section;
  // Cloud-backup AES-GCM key — needed to decrypt an outgoing gift's reclaim
  // seed in the "Odeslané dárky" list. Null when backups are unavailable.
  giftEncryptionKey?: CryptoKey | null;
}) {
  useBackLayer(true, onClose);
  const t = useT();
  const [section, setSection] = useState<Section>(initialSection ?? "menu");
  useEffect(() => {
    void probePlatformAuthenticator();
  }, []);
  const parentOf = (s: Exclude<Section, "menu">): SectionPage => PARENT[s];
  // Back inside Settings goes where the header's back button goes.
  useBackLayer(section !== "menu", () => {
    if (section !== "menu") setSection(parentOf(section));
  });

  return (
    <div className="settings">
      <header className="settings-header">
        {section === "menu" ? (
          <button className="secondary small" onClick={onClose}>
            {t("Zpět do peněženky")}
          </button>
        ) : (
          <button className="secondary small settings-back" onClick={() => setSection(parentOf(section))}>
            {/* Drawn, not the "←" character: Space Grotesk's latin subset has
                ↑ and ↓ but no ←, so it came from each system's own font, thin
                and light on Android. */}
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path d="M13 8H3.5M7.5 3.5 3 8l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {t(SECTION_TITLE[parentOf(section)])}
          </button>
        )}
      </header>

      {section === "menu" && <SettingsMenu onNavigate={setSection} />}
      {section === "security" && <SecuritySection onNavigate={setSection} />}
      {section === "wallet" && <WalletSection wallet={wallet} onNavigate={setSection} />}
      {section === "appearance" && <AppearanceSection wallet={wallet} onNavigate={setSection} />}
      {section === "danger" && <DangerSection onOpenExit={onOpenExit} onReset={onReset} />}
      {section === "vtxos" && <VtxoList wallet={wallet} waitForIdleRefresh={onWaitForIdleRefresh} />}
      {section === "onchain-txs" && <OnchainTxList wallet={wallet} />}
      {section === "call-log" && <CallLogPage />}
      {section === "gifts" && <SentGiftsList wallet={wallet} encryptionKey={giftEncryptionKey ?? null} />}
      {section === "seed" && <SeedReveal />}
      {section === "password" && <ChangePassword onDone={() => setSection(parentOf("password"))} />}
      {section === "biometric" && <BiometricUnlock />}
      {section === "bump-lab" && <BumpRecorderPage />}
      {section === "chat-settings" && <ChatSettingsPage />}
    </div>
  );
}

// Live low/medium/high onchain fee estimates. Deliberately fetched via the
// same-origin /api/fees/recommended proxy (src/lib/send/fees.ts, worker/index.ts)
// rather than wallet.onchainWallet.feeRates() — that call would go through
// the wallet Worker's single FIFO queue, which Dashboard's own background
// refresh cycle (8s Ark watch, 30s onchain poll — still running underneath
// even while Settings is open, see ARCHITECTURE.md) keeps busy enough that a fee
// lookup queued behind it can lose the race against its own timeout, even
// though the upstream API itself answers instantly. This path never touches
// that queue. Refreshes every 30s while mounted, which is only while the
// user is actually looking at the Settings menu — SettingsMenu unmounts on
// navigating to any other section (see Settings.tsx's `{section === "..."
// && ...}` branches), so this stops polling on its own the moment it's not
// visible.
// A typical one-input, two-output payment, for the footer's "what would a
// payment cost now" line.
const TYPICAL_PAYMENT_VB = 140;
// Consensus block weight limit: the mined block's fill is weight / this.
const MAX_BLOCK_WEIGHT = 4_000_000;

// Fee rates can be fractional (sub-1 sat/vB); show one decimal only there.
function formatFeeRate(rate: number): string {
  return rate < 10 && !Number.isInteger(rate) ? rate.toFixed(1) : String(Math.round(rate));
}

// mempool.space-style blocks. The three tiers are drawn as pending blocks
// whose fill is the tier's rate relative to "Vysoká" (a picture of how the
// rates compare, not of mempool fullness, which this endpoint doesn't give);
// the last mined block behind the dashed line is filled by its real weight.
function NetworkFeesWidget() {
  const t = useT();
  const lang = useLang();
  const motionOn = useMotionOn();
  const [rates, setRates] = useState<OnchainFees | null>(getLastKnownFees);
  const [tip, setTip] = useState<TipBlock | null>(getLastKnownTipBlock);
  const [error, setError] = useState(false);
  const [btcRate, setBtcRate] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // Height the widget was showing before the latest tip, so only a block that
  // actually arrived while looking plays the entrance (not the first paint).
  const [enteringHeight, setEnteringHeight] = useState<number | null>(null);
  const shownHeight = useRef<number | null>(tip?.height ?? null);
  const currency = getFiatCurrency();

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      setNow(Date.now());
      fetchOnchainFees()
        .then((fees) => {
          if (cancelled) return;
          setRates(fees);
          setError(false);
        })
        .catch(() => {
          if (!cancelled) setError(true);
        });
      fetchTipBlock()
        .then((block) => {
          if (cancelled) return;
          if (shownHeight.current !== null && block.height > shownHeight.current) setEnteringHeight(block.height);
          shownHeight.current = block.height;
          setTip(block);
        })
        .catch(() => {});
      fetchBtcRates()
        .then((r) => {
          if (!cancelled) setBtcRate(r[currency]);
        })
        .catch(() => {});
    };
    load();
    // Fees and blocks move on a scale of minutes and every poll is two Worker
    // requests, so a minute, and none while the page is hidden (coming back
    // loads at once).
    const tick = () => {
      if (!document.hidden) load();
    };
    const interval = setInterval(tick, 60_000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [currency]);

  if (!rates && error) {
    return (
      <div className="settings-group fee-widget">
        <div className="settings-label">
          <span>{t("Poplatky v síti")}</span>
        </div>
        <p className="muted small" style={{ padding: "0 16px 14px" }}>
          {t("Nepodařilo se načíst poplatky.")}
        </p>
      </div>
    );
  }

  const tiers = [
    { label: "Nízká", rate: rates?.low, eta: "~hodiny", reco: false },
    { label: "Střední", rate: rates?.medium, eta: "~30 min", reco: true },
    { label: "Vysoká", rate: rates?.high, eta: "~10 min", reco: false },
  ];
  const high = rates?.high ?? 0;
  const fillOf = (rate: number | undefined) =>
    rate === undefined || high <= 0 ? 0 : Math.min(1, Math.max(0.18, rate / high));
  const emptyPct = (fill: number) => `${Math.round((1 - fill) * 100)}%`;

  const locale = localeFor(lang);
  const paymentSats = rates ? Math.round(rates.medium * TYPICAL_PAYMENT_VB) : null;
  const age = tip ? Math.max(0, Math.floor(now / 1000 - tip.timestamp)) : 0;
  const ageText =
    age < 60
      ? tf(t("před {n} s"), { n: age })
      : age < 3600
        ? tf(t("před {n} min"), { n: Math.floor(age / 60) })
        : tf(t("před {n} h"), { n: Math.floor(age / 3600) });
  const entering = motionOn && tip !== null && tip.height === enteringHeight;

  return (
    <div className="settings-group fee-widget">
      <div className="settings-label">
        <span>{t("Poplatky v síti")}</span>
      </div>
      <div className="mp-strip">
        <div className={`mp-row${entering ? " mp-shift" : ""}`} key={entering ? `shift-${tip!.height}` : "row"}>
          {tiers.map((tier) => (
            <div className={`mp-col${tier.reco ? " reco" : ""}`} key={tier.label}>
              <div className="mp-label">{t(tier.label)}</div>
              <div className="mp-block" style={{ "--mp-e": emptyPct(fillOf(tier.rate)) } as CSSProperties}>
                <div className="mp-top" />
                <div className="mp-side" />
                <div className="mp-front">
                  <span className="mp-fee">{tier.rate === undefined ? "…" : formatFeeRate(tier.rate)}</span>
                  <span className="mp-unit">sat/vB</span>
                  <span className="mp-eta">{t(tier.eta)}</span>
                </div>
              </div>
            </div>
          ))}
          <div className="mp-divider" aria-hidden="true" />
          {tip && (
            <div className={`mp-col mined${entering ? " mp-enter" : ""}`} key={tip.height}>
              <div className="mp-label">{tip.height.toLocaleString(locale)}</div>
              <div
                className="mp-block"
                style={{ "--mp-e": emptyPct(Math.min(1, tip.weight / MAX_BLOCK_WEIGHT)) } as CSSProperties}
              >
                <div className="mp-top" />
                <div className="mp-side" />
                <div className="mp-front">
                  <span className="mp-eta">{ageText}</span>
                  <span className="mp-unit">{tip.txCount.toLocaleString(locale)} tx</span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
      <div className="mp-foot">
        <span>{t("Běžná platba")}</span>
        {paymentSats !== null && (
          <span className="mp-foot-cost">
            ≈ {paymentSats.toLocaleString(locale)} sat
            {btcRate !== null && ` · ${formatFiat(satsToFiat(paymentSats, btcRate), currency)}`}
          </span>
        )}
      </div>
    </div>
  );
}

// Silent-on-success by design (see ARCHITECTURE.md's backup section) — this is
// the only place the cloud backup feature is ever visible, and only shows a
// warning after *sustained* failure, not a single transient one (a lapsed
// backup right after first unlocking a wallet, before any change has
// triggered a first upload, isn't a failure worth alarming anyone about).
const BACKUP_STALE_AFTER_MS = 2 * 24 * 60 * 60 * 1000;

function computeBackupDisplayStatus(): {
  lastSuccessAt: number | null;
  isStale: boolean;
  lastError: string | null;
  restoreError: string | null;
} {
  const { lastSuccessAt, lastAttemptAt, lastError, restoreError } = getLastBackupStatus();
  const isStale = lastAttemptAt !== null && (lastSuccessAt === null || Date.now() - lastSuccessAt > BACKUP_STALE_AFTER_MS);
  return { lastSuccessAt, isStale, lastError, restoreError };
}

function BackupStatusWidget({ variant = "rows" }: { variant?: "rows" | "card" }) {
  const t = useT();
  const lang = useLang();
  const [{ lastSuccessAt, isStale, lastError, restoreError }, setStatus] = useState(computeBackupDisplayStatus);

  useEffect(() => {
    const interval = setInterval(() => setStatus(computeBackupDisplayStatus()), 30_000);
    return () => clearInterval(interval);
  }, []);

  // In the beta layout these rows sit in the "Trvalé úložiště" card with no
  // heading of their own ("Poslední záloha" already names them); V1 keeps the
  // standalone card. Either way the failure banners stay exactly as visible
  // as before (see ARCHITECTURE.md: this is the only place the backup feature is
  // ever surfaced).
  const rows = (
    <>
      <div className="info-row">
        <span>{t("Poslední záloha")}</span>
        <code>{lastSuccessAt ? formatBuildDate(new Date(lastSuccessAt).toISOString(), lang) : t("zatím žádná")}</code>
      </div>
      {restoreError !== null && (
        // Shown unconditionally, not behind the staleness window below: this
        // state means uploads are switched off for the whole session
        // (App.tsx's restoreFailed), so the "Poslední záloha" line above will
        // just quietly stop advancing with nothing to explain why.
        <div className="banner banner-danger">
          <ErrorCircleIcon />
          <span>
            {t("Obnovu zálohy se nepodařilo dokončit, takže zálohování je až do dalšího otevření aplikace vypnuté.")}{" "}
            <code style={{ wordBreak: "break-word" }}>{restoreError}</code>
          </span>
        </div>
      )}
      {isStale && (
        <div className="banner banner-warning">
          <WarningIcon />
          <span>
            {t("Zálohování se dlouho nedaří.")}
            {lastError && (
              <>
                {" "}
                <code style={{ wordBreak: "break-word" }}>{lastError}</code>
              </>
            )}
          </span>
        </div>
      )}
    </>
  );

  if (variant === "card") {
    return (
      <div className="settings-group">
        <div className="settings-label">{t("Záloha peněženky")}</div>
        {rows}
      </div>
    );
  }
  return rows;
}

// v2 beta. Whether the browser has agreed to keep this origin's storage (the
// vault's only copy) out of eviction, and what to do when it hasn't. See
// lib/storageProtection.ts. In an iOS browser tab the answer is always the
// Home Screen: ITP's 7-day deletion applies there whatever persist() says.
function StorageProtectionCard({ onShowSeed }: { onShowSeed: () => void }) {
  const t = useT();
  const [status, setStatus] = useState<StorageProtection | null>(null);
  const [asking, setAsking] = useState(false);
  const [refused, setRefused] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [iosTab] = useState(isIosBrowserTab);

  useEffect(() => {
    let cancelled = false;
    void getStorageProtection().then((s) => {
      if (!cancelled) setStatus(s);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const ask = async () => {
    setAsking(true);
    const next = await requestPersistentStorage({ force: true });
    setStatus(next);
    setRefused(next !== "persisted");
    setAsking(false);
  };

  const value =
    status === null
      ? "…"
      : status === "persisted"
        ? t("zapnuto")
        : status === "best-effort"
          ? t("vypnuto")
          : t("nepodporováno");

  return (
    <div className="settings-group">
      <div className="info-row">
        <span>{t("Trvalé úložiště")}</span>
        <code>{value}</code>
      </div>
      {/* Both say whether this wallet's data is safe: kept by the browser,
          and copied to the cloud (its failure banners come along). */}
      <BackupStatusWidget />
      {iosTab ? (
        <button className="settings-item settings-item--stacked" onClick={() => setSheet(true)}>
          <span className="settings-item-text">
            <span>{t("Přidat appku na plochu")}</span>
            <span className="settings-item-sub">{t("V prohlížeči iOS smaže data webu, který týden neotevřeš.")}</span>
          </span>
          <span className="chevron">›</span>
        </button>
      ) : (
        status === "best-effort" && (
          <button className="settings-item settings-item--stacked" disabled={asking} onClick={() => void ask()}>
            <span className="settings-item-text">
              <span>{t("Požádat o trvalé úložiště")}</span>
              <span className="settings-item-sub">
                {refused
                  ? t("Prohlížeč zatím nevyhověl. Pomůže nainstalovat appku nebo zapnout oznámení o platbách.")
                  : t("Bez něj může prohlížeč data peněženky smazat, když v zařízení dojde místo.")}
              </span>
            </span>
          </button>
        )
      )}
      {sheet && (
        <InstallAppSheet
          variant="wallet"
          needsSeed={needsSeedBackup()}
          onShowSeed={() => {
            setSheet(false);
            onShowSeed();
          }}
          onClose={() => setSheet(false)}
        />
      )}
    </div>
  );
}

// The root of Settings: a signpost, not a settings page. Fee widget on top
// (a live readout people open Settings to glance at — burying it a level down
// would kill it), then the four section rows, then the About card.
function SettingsMenu({ onNavigate }: { onNavigate: (s: Section) => void }) {
  const t = useT();
  const isBeta = useDesignVersion() === "v2";
  const [showChangelog, setShowChangelog] = useState(false);
  // Hidden toggle: triple-click "Verze" to flip the background glow on/off
  // (src/lib/ui/bgGlow.ts) — always keeps a way back to the plain flat
  // background without needing a code change.
  const versionClickRef = useRef<{ count: number; last: number }>({ count: 0, last: 0 });
  const handleVersionClick = useCallback(() => {
    const now = Date.now();
    const ref = versionClickRef.current;
    if (now - ref.last > 600) ref.count = 0;
    ref.count += 1;
    ref.last = now;
    if (ref.count >= 3) {
      ref.count = 0;
      setBgGlowEnabled(!getBgGlowEnabled());
    }
  }, []);

  return (
    <div className="settings-body">
      <NetworkFeesWidget />

      <div className="settings-group">
        <NavRow
          label={t("Zabezpečení")}
          sub={t("Heslo, otisk, uzamčení, seed phrase")}
          onClick={() => onNavigate("security")}
        />
        <NavRow
          label={t("Peněženka")}
          sub={t("Záloha, VTXO mince, onchain transakce")}
          onClick={() => onNavigate("wallet")}
        />
        <NavRow
          label={t("Vzhled a chování")}
          sub={t("Motiv, jazyk, měna, oznámení")}
          onClick={() => onNavigate("appearance")}
        />
        <NavRow
          danger="all"
          label={t("Nebezpečná zóna")}
          sub={t("Nouzový exit, smazání peněženky")}
          onClick={() => onNavigate("danger")}
        />
      </div>

      <div className="settings-group">
        <div className="settings-label">{t("O peněžence")}</div>
        <div className="info-row" onClick={handleVersionClick}>
          <span>{t("Verze")}</span>
          <code>v{__APP_VERSION__}</code>
        </div>
        <div className="info-row">
          <span>{t("Sestaveno")}</span>
          <code>{formatBuildDate(__APP_COMMIT_DATE__, getLang())}</code>
        </div>
        {/* Own row rather than appended to "Sestaveno" — as a suffix it broke
            across two lines mid-hash (.info-row code wraps at any character). */}
        <div className="info-row">
          <span>{t("Poslední commit")}</span>
          <code>{__APP_COMMIT__}</code>
        </div>
        {/* CoinGecko's API terms require attributing it; this also covers the
            fiat amounts on the home screen, which have no room of their own. */}
        <div className="info-row">
          <span>{t("Cenová data")}</span>
          <a className="info-row-link" href="https://www.coingecko.com" target="_blank" rel="noopener noreferrer">
            CoinGecko
          </a>
        </div>
        {/* Generated at build time (vite.config.ts thirdPartyLicensesPlugin);
            the bundled libraries and fonts require their notices to be shown. */}
        <div className="info-row">
          <span>{t("Licence")}</span>
          <a className="info-row-link" href="/third-party-licenses.txt" target="_blank" rel="noopener noreferrer">
            {t("Třetí strany")}
          </a>
        </div>
        {/* The source is AGPL; VERIFY.md in the repo explains how to check that the site runs it. */}
        <div className="info-row">
          <span>{t("Zdrojový kód")}</span>
          <a className="info-row-link" href="https://github.com/spendrr/web" target="_blank" rel="noopener noreferrer">
            GitHub
          </a>
        </div>
        {/* Static pages (public/terms.html, privacy.html), English under /en. */}
        <div className="info-row">
          <span>{t("Podmínky a soukromí")}</span>
          <span>
            <a className="info-row-link" href={getLang() === "en" ? "/terms/en" : "/terms"} target="_blank" rel="noopener noreferrer">
              {t("Podmínky")}
            </a>
            {" · "}
            <a className="info-row-link" href={getLang() === "en" ? "/privacy/en" : "/privacy"} target="_blank" rel="noopener noreferrer">
              {t("Soukromí")}
            </a>
          </span>
        </div>
        {/* The project's own tip page (worker serves it for /donate), a plain link like the rows above. */}
        {isBeta && (
          <div className="info-row">
            <span className="info-row-heart">
              {t("Podpora vývoje")}
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 20.5s-7.5-4.6-9.3-9.2C1.5 8 3.4 5 6.6 5c2 0 3.6 1.1 5.4 3.1C13.8 6.1 15.4 5 17.4 5c3.2 0 5.1 3 3.9 6.3-1.8 4.6-9.3 9.2-9.3 9.2z" />
              </svg>
            </span>
            <a className="info-row-link" href="/donate" target="_blank" rel="noopener noreferrer">
              {t("Přispět")}
            </a>
          </div>
        )}
        <button className="settings-item" onClick={() => setShowChangelog(true)}>
          <span>{t("Zobrazit changelog")}</span>
          <span className="chevron">›</span>
        </button>
        <div className="settings-row settings-row--inline">
          <div className="settings-row-label">{t("Vyzkoušet beta verzi")}</div>
          <DesignVersionToggle />
        </div>
        <div className="about-warning">
          <div className="banner banner-warning">
            <WarningIcon />
            <span>
              {t(
                "Tohle je beta verze bez nezávislého auditu. Používej ji na vlastní riziko a nedrž v ní větší prostředky, než jsi ochotný ztratit.",
              )}
            </span>
          </div>
        </div>
      </div>
      {showChangelog && <ChangelogSheet onClose={() => setShowChangelog(false)} />}
    </div>
  );
}

// A row on the root signpost. The subtitle is what makes the root readable
// without opening anything — it names what is inside instead of making the
// user guess from a one-word heading.
function NavRow({
  label,
  sub,
  danger,
  onClick,
}: {
  label: string;
  sub: string;
  // "all" paints the subtitle red too — used on the signpost row, where the
  // whole row is a warning about where it leads. "title" is for rows already
  // inside Nebezpečná zóna, where every subtitle turning red made the page
  // read as one solid block of red.
  danger?: "title" | "all";
  onClick: () => void;
}) {
  return (
    <button
      className={`settings-item settings-item--stacked${danger ? " settings-item--danger" : ""}${
        danger === "all" ? " settings-item--danger-all" : ""
      }`}
      onClick={onClick}
    >
      <span className="settings-item-text">
        <span>{label}</span>
        <span className="settings-item-sub">{sub}</span>
      </span>
      <span className="chevron">›</span>
    </button>
  );
}

function SecuritySection({ onNavigate }: { onNavigate: (s: Section) => void }) {
  const t = useT();
  const [bioAvailable, setBioAvailable] = useState(() => hasBiometricUnlock() || platformAuthCache === true);
  useEffect(() => {
    if (bioAvailable) return;
    let cancelled = false;
    probePlatformAuthenticator().then((available) => {
      if (!cancelled && available) setBioAvailable(true);
    });
    return () => {
      cancelled = true;
    };
  }, [bioAvailable]);

  return (
    <div className="settings-body">
      <div className="settings-group">
        <button className="settings-item" onClick={() => onNavigate("password")}>
          <span>{t("Změnit heslo")}</span>
          <span className="chevron">›</span>
        </button>
        {bioAvailable && (
          <button className="settings-item" onClick={() => onNavigate("biometric")}>
            <span>
              {t("Odemykání otiskem")} {hasBiometricUnlock() ? `(${t("zapnuto")})` : ""}
            </span>
            <span className="chevron">›</span>
          </button>
        )}
        <AutoLockSetting />
        {isShakeSupported() && <ShakeSetting />}
      </div>

      {/* Its own card, below everything else: the rest of this page locks
          things down, this one puts the seed phrase on screen. It used to sit
          third in an unlabelled list between "Onchain transakce" and
          "Změnit heslo". */}
      <div className="settings-group">
        <button className="settings-item settings-item--stacked" onClick={() => onNavigate("seed")}>
          <span className="settings-item-text">
            <span>{t("Zobrazit seed phrase")}</span>
            <span className="settings-item-sub">{t("Odhalí slova na obrazovce")}</span>
          </span>
          <span className="chevron">›</span>
        </button>
      </div>
    </div>
  );
}

function WalletSection({ wallet, onNavigate }: { wallet: WalletClient; onNavigate: (s: Section) => void }) {
  const t = useT();
  return (
    <div className="settings-body">
      <div className="settings-group">
        {/* Which server and which wallet this is — the context for everything
            below it, so it reads before the storage and coin rows rather than
            sitting in "O peněžence" next to the build number. */}
        <div className="info-row">
          <span>Ark server</span>
          <code>ark.second.tech</code>
        </div>
        <div className="info-row">
          <span>{t("Síť")}</span>
          <code>mainnet</code>
        </div>
        <div className="info-row">
          <span>Fingerprint</span>
          <code>{wallet.fingerprint}</code>
        </div>
      </div>

      <StorageProtectionCard onShowSeed={() => onNavigate("seed")} />

      {/* Own card: everything above is a read-only fact about this wallet,
          these two lead somewhere. */}
      <div className="settings-group">
        <button className="settings-item" onClick={() => onNavigate("vtxos")}>
          <span>{t("VTXO mince")}</span>
          <span className="chevron">›</span>
        </button>
        <button className="settings-item" onClick={() => onNavigate("onchain-txs")}>
          <span>{t("Onchain transakce")}</span>
          <span className="chevron">›</span>
        </button>
        <button className="settings-item" onClick={() => onNavigate("gifts")}>
          <span>{t("Odeslané dárky")}</span>
          <span className="chevron">›</span>
        </button>
        {/* For everyone, not just the beta: it's what lets someone report a
            stuck payment or a hung call with actual detail from their phone. */}
        <button className="settings-item" onClick={() => onNavigate("call-log")}>
          <span>{t("Log peněženky")}</span>
          <span className="chevron">›</span>
        </button>
      </div>
    </div>
  );
}

function AppearanceSection({ wallet, onNavigate }: { wallet: WalletClient; onNavigate: (s: Section) => void }) {
  const t = useT();
  const isBeta = useDesignVersion() === "v2";
  const chatOn = useChatEnabled();
  return (
    <div className="settings-body">
      <div className="settings-group">
        <div className="settings-row">
          <div className="settings-row-label">{t("Vzhled")}</div>
          <ThemeToggle />
        </div>
        <div className="settings-row">
          <div className="settings-row-label">{t("Barevné téma")}</div>
          <ColorThemeToggle />
        </div>
        <div className="settings-row">
          <div className="settings-row-label">{t("Jazyk")}</div>
          <LanguageToggle />
        </div>
        <div className="settings-row">
          <div className="settings-row-label">{t("Měna")}</div>
          <CurrencyToggle />
        </div>
        {isHapticsSupported() && (
          <div className="settings-row settings-row--inline">
            <div className="settings-row-label">{t("Haptická odezva")}</div>
            <HapticsToggle />
          </div>
        )}
        {isBeta && !isBumpPayKillSwitchActive() && isBumpPaySupported() && (
          <div className="settings-row settings-row--inline">
            <div className="settings-row-label">{t("Platby ťuknutím (beta)")}</div>
            <BumpPayToggle />
          </div>
        )}
        {isBeta && (
          <div className="settings-row settings-row--inline">
            <div className="settings-row-label">{t("Zprávy (beta)")}</div>
            <ChatToggle />
          </div>
        )}
        {isBeta && chatOn && (
          <button className="settings-item" onClick={() => onNavigate("chat-settings")}>
            <span>{t("Nastavení zpráv")}</span>
            <span className="chevron">›</span>
          </button>
        )}
        {isBeta && !isBumpPayKillSwitchActive() && isBumpPaySupported() && (
          <button className="settings-item" onClick={() => onNavigate("bump-lab")}>
            <span>{t("Záznamník ťuknutí")}</span>
            <span className="chevron">›</span>
          </button>
        )}
        {isNotificationSupported() && (
          <div className="settings-row settings-row--inline">
            <div className="settings-row-label">{t("Oznámení o platbách")}</div>
            <NotificationsToggle wallet={wallet} />
          </div>
        )}
      </div>
    </div>
  );
}

// Rows, not buttons: neither of these does anything on its own. "Nouzový
// exit" opens the exit sheet, "Smazat peněženku" opens the two-step
// confirm modal — so a full-width danger button misrepresents them as
// triggers, and stacking two of them inside a card is a box in a box. The
// danger colour still marks where they lead.
function DangerSection({ onOpenExit, onReset }: { onOpenExit: () => void; onReset: () => void }) {
  const t = useT();
  return (
    <div className="settings-body">
      <p className="settings-intro">
        {t(
          "Obě akce níž mají vážné a těžko vratné důsledky. Než se cokoli stane, ukáže se ještě obrazovka s vysvětlením a potvrzením.",
        )}
      </p>
      <div className="settings-group">
        <NavRow
          danger="title"
          label={t("Nouzový exit z Ark")}
          sub={t("Převede prostředky on-chain bez součinnosti Ark serveru")}
          onClick={onOpenExit}
        />
        <NavRow
          danger="title"
          label={t("Smazat peněženku z prohlížeče")}
          sub={t("Odstraní zašifrovanou peněženku z tohoto zařízení")}
          onClick={onReset}
        />
      </div>
    </div>
  );
}

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: "system", label: "Systém" },
  { value: "light", label: "Světlý" },
  { value: "dark", label: "Tmavý" },
];

function ThemeToggle() {
  const t = useT();
  const [theme, setTheme] = useState<ThemePreference>(getThemePreference());

  const choose = useCallback((value: ThemePreference) => {
    setThemePreference(value);
    setTheme(value);
  }, []);

  return (
    <div className="mode-toggle">
      {THEME_OPTIONS.map((opt) => (
        <button
          key={opt.value}
          className={theme === opt.value ? "active" : ""}
          onClick={() => choose(opt.value)}
        >
          {t(opt.label)}
        </button>
      ))}
    </div>
  );
}

// The beta toggle: stored in localStorage, not per-wallet state, so it doesn't
// follow a wallet across origins (a phone on a LAN-IP dev origin starts with it
// off whatever a desktop session has). designVersion.ts lists what it gates.
function DesignVersionToggle() {
  const t = useT();
  const [version, setVersion] = useState<DesignVersion>(getDesignVersion());
  const isV2 = version === "v2";

  const choose = useCallback((value: DesignVersion) => {
    setDesignVersion(value);
    setVersion(value);
  }, []);

  return (
    <BooleanSwitch
      checked={isV2}
      onChange={(v) => choose(v ? "v2" : "v1")}
      label={t(isV2 ? "Přepnout zpět na V1" : "Vyzkoušet V2")}
    />
  );
}


const LANGUAGE_OPTIONS: { value: Lang; label: string }[] = [
  { value: "en", label: "English" },
  { value: "cs", label: "Čeština" },
];

function LanguageToggle() {
  const [lang, setLangState] = useState<Lang>(getLang());

  const choose = useCallback((value: Lang) => {
    setLang(value);
    setLangState(value);
  }, []);

  return (
    <div className="mode-toggle">
      {LANGUAGE_OPTIONS.map((opt) => (
        <button key={opt.value} className={lang === opt.value ? "active" : ""} onClick={() => choose(opt.value)}>
          {opt.label}
        </button>
      ))}
    </div>
  );
}

const COLOR_THEME_OPTIONS: { value: ColorTheme; label: string }[] = [
  { value: "orange", label: "Oranžová" },
  { value: "purple", label: "Fialová" },
  { value: "red", label: "Červená" },
  { value: "blue", label: "Modrá" },
  { value: "teal", label: "Petrolejová" },
];

function ColorThemeToggle() {
  const t = useT();
  const [colorTheme, setColorThemeState] = useState<ColorTheme>(getColorTheme());

  const choose = useCallback((value: ColorTheme) => {
    setColorTheme(value);
    setColorThemeState(value);
  }, []);

  return (
    <div className="color-theme-toggle">
      {COLOR_THEME_OPTIONS.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className={`color-swatch-btn color-swatch--${opt.value}${colorTheme === opt.value ? " active" : ""}`}
          onClick={() => choose(opt.value)}
          aria-label={t(opt.label)}
          aria-pressed={colorTheme === opt.value}
        />
      ))}
    </div>
  );
}

// One step. Switching on opens the privacy sheet, which asks the
// browser for permission; switching off turns push off right here.
function NotificationsToggle({ wallet }: { wallet: WalletClient }) {
  const t = useT();
  const [enabled, setEnabled] = useState(isNotifyEnabled());
  const [busy, setBusy] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);

  const choose = useCallback(async (value: boolean) => {
    if (value) {
      setSheetOpen(true);
      return;
    }
    setBusy(true);
    await disableNotifications();
    setEnabled(false);
    setBusy(false);
  }, []);

  return (
    <>
      <BooleanSwitch checked={enabled} disabled={busy} onChange={(v) => void choose(v)} label={t("Oznámení o platbách")} />
      {sheetOpen && (
        <NotificationsSheet
          wallet={wallet}
          onClose={() => {
            setSheetOpen(false);
            setEnabled(isNotifyEnabled());
          }}
        />
      )}
    </>
  );
}

function HapticsToggle() {
  const t = useT();
  const [enabled, setEnabled] = useState(isHapticsEnabled());

  const choose = useCallback((value: boolean) => {
    setHapticsEnabled(value);
    setEnabled(value);
  }, []);

  return <BooleanSwitch checked={enabled} onChange={choose} label={t("Haptická odezva")} />;
}

// Deliberately requests motion permission right here, synchronously inside
// this click handler — the home screen's passive listener (BumpOverlay.tsx)
// has no user gesture of its own to ask from once it's already running, so
// this toggle is the only place that request can ever legitimately happen.
// Turning the switch off doesn't (can't) revoke permission a browser
// already granted — it just stops the passive listener from starting.
function BumpPayToggle() {
  const t = useT();
  const [enabled, setEnabled] = useState(isBumpPayEnabled());
  const [error, setError] = useState<string | null>(null);

  const choose = useCallback(
    async (value: boolean) => {
      setError(null);
      if (!value) {
        setBumpPayEnabled(false);
        setEnabled(false);
        return;
      }
      const granted = await requestMotionPermission();
      if (!granted) {
        setError(t("Senzory pohybu se nepodařilo povolit."));
        return;
      }
      setBumpPayEnabled(true);
      setEnabled(true);
    },
    [t],
  );

  return (
    <>
      <BooleanSwitch checked={enabled} onChange={(v) => void choose(v)} label={t("Platby ťuknutím (beta)")} />
      {error && <p className="error small">{error}</p>}
    </>
  );
}

// Everything that only matters once Zprávy are on; the switch itself stays in
// Vzhled a chování.
function ChatSettingsPage() {
  const t = useT();
  return (
    <div className="settings-body">
      <div className="settings-group">
        <div className="settings-row settings-row--inline">
          <div className="settings-row-label">{t("Potvrzení o přečtení")}</div>
          <ReadReceiptsToggle />
        </div>
        {isNotificationSupported() && <ChatPushSettings />}
      </div>
    </div>
  );
}

function ReadReceiptsToggle() {
  const t = useT();
  const on = useReadReceiptsOn();
  return <BooleanSwitch checked={on} onChange={setReadReceiptsOn} label={t("Potvrzení o přečtení")} />;
}

const CHAT_PREVIEWS: { value: ChatPushPreview; label: string }[] = [
  { value: "text", label: "Text" },
  { value: "name", label: "Jméno" },
  { value: "none", label: "Nic" },
];

// Chat notifications (chatPush.ts): the switch, and what a notification shows.
function ChatPushSettings() {
  const t = useT();
  const on = useChatPushOn();
  const preview = useChatPushPreview();
  const [busy, setBusy] = useState(false);
  const [denied, setDenied] = useState(false);
  const supported = isPushSupported();
  // Permission taken back in the browser later: the switch shows it is off.
  const blocked = denied || notificationPermission() === "denied";
  const working = on && supported && !blocked;

  const choose = async (value: boolean) => {
    setDenied(false);
    if (!value) {
      setChatPushSettings(false);
      return;
    }
    setBusy(true);
    const permission = await Notification.requestPermission().catch(() => "denied" as const);
    setBusy(false);
    if (permission !== "granted") {
      setDenied(true);
      return;
    }
    setChatPushSettings(true);
  };

  return (
    <>
      <div className="settings-row settings-row--inline">
        <div className="settings-row-label">{t("Oznámení o zprávách")}</div>
        <BooleanSwitch
          checked={working}
          disabled={busy || !supported}
          onChange={(v) => void choose(v)}
          label={t("Oznámení o zprávách")}
        />
      </div>
      {(!supported || blocked) && (
        <div className="settings-row">
          <p className="settings-row-note">
            {!supported ? t("Jen v appce přidané na plochu.") : t("Oznámení jsou v prohlížeči zakázaná.")}
          </p>
        </div>
      )}
      {working && (
        <div className="settings-row">
          <div className="settings-row-label">{t("Náhled")}</div>
          <div className="mode-toggle">
            {CHAT_PREVIEWS.map((opt) => (
              <button key={opt.value} className={preview === opt.value ? "active" : ""} onClick={() => setChatPushSettings(true, opt.value)}>
                {t(opt.label)}
              </button>
            ))}
          </div>
          <p className="settings-row-note">{t("Vidět i na zamčené obrazovce.")}</p>
        </div>
      )}
    </>
  );
}

function ChatToggle() {
  const t = useT();
  const enabled = useChatEnabled();
  return <BooleanSwitch checked={enabled} onChange={setChatEnabled} label={t("Zprávy (beta)")} />;
}

// Manual override for App.tsx's 5-minute inactivity auto-lock — see
// autoLock.ts's file comment for why this exists on top of the app's
// existing per-operation deferrals (in-flight send/exit, a focused input
// field).
function AutoLockSetting({ variant = "row" }: { variant?: "row" | "card" }) {
  const t = useT();
  const [enabled, setEnabled] = useState(isAutoLockEnabled());

  const choose = useCallback((value: boolean) => {
    setAutoLockEnabled(value);
    setEnabled(value);
  }, []);

  const control = <BooleanSwitch checked={enabled} onChange={choose} label={t("Automatické uzamčení")} />;

  // "card" is the pre-beta look (its own card in the flat menu); "row" is a
  // line inside the beta Zabezpečení page.
  if (variant === "card") {
    return (
      <div className="settings-group">
        <div className="settings-group--inline-switch">
          <div className="settings-label">{t("Automatické uzamčení")}</div>
          <div className="theme-toggle-wrap">{control}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="settings-row settings-row--inline">
      <div className="settings-row-label">{t("Automatické uzamčení")}</div>
      {control}
    </div>
  );
}

const CURRENCY_OPTIONS: { value: FiatCurrency; label: string }[] = [
  { value: "czk", label: "Kč" },
  { value: "eur", label: "EUR" },
  { value: "usd", label: "USD" },
];

function CurrencyToggle() {
  const [currency, setCurrency] = useState<FiatCurrency>(getFiatCurrency());

  const choose = useCallback((value: FiatCurrency) => {
    setFiatCurrency(value);
    setCurrency(value);
  }, []);

  return (
    <div className="mode-toggle">
      {CURRENCY_OPTIONS.map((opt) => (
        <button
          key={opt.value}
          className={currency === opt.value ? "active" : ""}
          onClick={() => choose(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

// Ground-truth recovery, independent of anything this app tracks itself.
// VtxoConsolidate's `pending` state (localStorage, keyed by a single
// roundId this app remembers registering) can fall out of sync with what
// the wallet actually has outstanding — e.g. a round that failed without
// resolving cleanly, or one registered from a different browser/device
// entirely. wallet.pendingRoundStates() asks the wallet itself for every
// round it knows about, with no dependency on our own bookkeeping or on
// allVtxos() ever succeeding, so this is the one recovery path that still
// works when both of those are stale or stuck.
function roundFlowKindLabel(t: (s: string) => string, state: RoundFlowKind): string {
  switch (state) {
    case "delegated-pending":
      return t("Čeká na naplánovanou výšku bloku");
    case "pending":
      return t("Čeká na start kola");
    case "ongoing":
      return t("Probíhá");
    case "awaiting-confirmations":
      return t("Čeká na potvrzení na blockchainu");
    case "failed":
      return t("Selhalo");
    case "canceled":
      return t("Zrušeno");
  }
}

// `known`: the round list the screen's own overview read already fetched.
// pendingRoundStates() is the slow call (minutes with a round stuck open), so
// asking twice doubles the wait; after a cancel (version > 0) it re-reads.
function PendingRoundsPanel({
  wallet,
  hideRoundIds,
  known,
}: {
  wallet: WalletClient;
  hideRoundIds?: ReadonlySet<number>;
  known?: RoundState[];
}) {
  const t = useT();
  const [rounds, setRounds] = useState<RoundState[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [cancelingAll, setCancelingAll] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (known && version === 0) {
      setRounds(known.filter((s) => s.state !== "failed" && s.state !== "canceled"));
      setError(null);
      return;
    }
    let cancelled = false;
    // Confirmed live: with a round the server itself has left open for
    // hours (way past a normal ~1h round), pendingRoundStates() genuinely
    // takes longer than WALLET_CALL_TIMEOUT_MS (60s) to answer once it's
    // actually running — not just queued behind something else. Widened to
    // match ONCHAIN_SYNC_TIMEOUT_MS, the same "legitimately slow, not
    // stuck" allowance already used for onchainWallet.sync()'s own
    // unbounded-in-practice case.
    const popWatchdog = pushWorkerWatchdogOverride(ONCHAIN_SYNC_TIMEOUT_MS);
    withTimeout(wallet.pendingRoundStates(), ONCHAIN_SYNC_TIMEOUT_MS, t(TIMEOUT_MESSAGE))
      .then((states) => {
        if (cancelled) return;
        // `ongoing` only covers state "pending"/"ongoing" — a
        // "delegated-pending" round (waiting for a scheduled block height,
        // e.g. from "Obnovit všechna VTXO" delegated refresh) has
        // ongoing: false despite still being an open participation the user
        // may need to see and cancel. Show everything that isn't in a
        // terminal state instead of relying on `ongoing`.
        setRounds(states.filter((s) => s.state !== "failed" && s.state !== "canceled"));
        setError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        surfaceError(e, setError, rawErrorMessage(e) || t("Neznámá chyba"));
      })
      .finally(popWatchdog);
    return () => {
      cancelled = true;
    };
  }, [wallet, t, version, known]);

  const cancel = useCallback(
    async (id: number) => {
      setBusyId(id);
      setError(null);
      // Same reasoning as above — cancelling a round this broken may need
      // just as long to hear back from the server as listing it did.
      const popWatchdog = pushWorkerWatchdogOverride(ONCHAIN_SYNC_TIMEOUT_MS);
      try {
        await withTimeout(wallet.cancelPendingRound(id), ONCHAIN_SYNC_TIMEOUT_MS, t(TIMEOUT_MESSAGE));
        // In case this happens to be the same round VtxoConsolidate's own
        // (possibly stale) bookkeeping still remembers — otherwise it'd keep
        // showing a "Probíhá…" card for a round that no longer exists.
        const own = getPendingVtxoRefresh();
        if (own && own.roundId === id) clearPendingVtxoRefresh();
        setVersion((n) => n + 1);
      } catch (e) {
        surfaceError(e, setError, rawErrorMessage(e) || t("Neznámá chyba"));
      } finally {
        setBusyId(null);
        popWatchdog();
      }
    },
    [wallet, t],
  );

  const cancelAll = useCallback(async () => {
    setCancelingAll(true);
    setError(null);
    const popWatchdog = pushWorkerWatchdogOverride(ONCHAIN_SYNC_TIMEOUT_MS);
    try {
      await withTimeout(wallet.cancelAllPendingRounds(), ONCHAIN_SYNC_TIMEOUT_MS, t(TIMEOUT_MESSAGE));
      clearPendingVtxoRefresh();
      setVersion((n) => n + 1);
    } catch (e) {
      surfaceError(e, setError, rawErrorMessage(e) || t("Neznámá chyba"));
    } finally {
      setCancelingAll(false);
      popWatchdog();
    }
  }, [wallet, t]);

  // Silent while loading and when there's nothing to recover from — this
  // only needs to be visible when it actually has something to say (an
  // active round, or a failure to even ask). A loading card that then
  // vanished made the whole screen jump.
  // Rounds the refresh engine tracks are shown (and released) in its own card;
  // a cancel from here can't touch a delegated round anyway.
  const shown = rounds?.filter((r) => !hideRoundIds?.has(r.id)) ?? null;
  if (!error && (!shown || shown.length === 0)) return null;

  return (
    <div className="vtxo-card">
      <div className="info-row">
        <span>{t("Aktivní kola serveru")}</span>
        {shown && shown.length > 1 && (
          <button className="secondary danger small" disabled={cancelingAll} onClick={cancelAll}>
            {cancelingAll ? t("Ruším…") : t("Zrušit všechna")}
          </button>
        )}
      </div>
      <div className="settings-body" style={{ padding: "0 16px 16px" }}>
        {error && (
          <>
            <p className="error">{error}</p>
            <button className="secondary small" onClick={() => setVersion((n) => n + 1)}>
              {t("Zkusit znovu")}
            </button>
          </>
        )}
        {shown?.map((r) => (
          <div key={r.id} className="info-row">
            <span>
              {tf(t("Kolo #{id}"), { id: r.id })}
              {" — "}
              {roundFlowKindLabel(t, r.state)}
              {r.state === "delegated-pending" && r.scheduledHeight !== undefined
                ? ` (${tf(t("blok {height}"), { height: r.scheduledHeight })})`
                : ""}
            </span>
            <button className="secondary danger small" disabled={busyId === r.id} onClick={() => cancel(r.id)}>
              {busyId === r.id ? t("Ruším…") : t("Zrušit")}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// allVtxos() can list the same VTXO more than once (e.g. once per subsystem
// that references it), and the duplicates aren't always byte-identical — one
// copy can reflect a state read just before a concurrent lock/spend and
// another just after. A plain Map-by-id dedup is last-write-wins by array
// order, which picks an arbitrary one of the two; pick the most restrictive
// state instead so this list never overstates what's actually spendable.
// Also drops VTXOs already fully spent, which aren't part of the wallet's
// holdings anymore and just clutter the list.
function vtxosForList(v: readonly Vtxo[]): Vtxo[] {
  const stateRank: Record<VtxoState["type"], number> = {
    spent: 3,
    exited: 2,
    locked: 1,
    spendable: 0,
  };
  const byId = new Map<string, Vtxo>();
  for (const x of v) {
    const existing = byId.get(x.id);
    if (!existing || stateRank[x.state.type] > stateRank[existing.state.type]) {
      byId.set(x.id, x);
    }
  }
  return Array.from(byId.values()).filter((x) => x.state.type !== "spent");
}

// Last screen read per wallet, kept in memory only. A re-open shows it at once
// and re-reads behind it: the read queues behind refresh()/engine ticks in the
// worker and takes tens of seconds on a big wallet.
const lastVtxoRead = new Map<string, { overview: EngineOverview | null; vtxos: Vtxo[] }>();

function VtxoList({
  wallet,
  waitForIdleRefresh,
}: {
  wallet: WalletClient;
  waitForIdleRefresh?: () => Promise<void>;
}) {
  const t = useT();
  const engineLive = effectiveEngineMode() === "live";
  // A round already registered via "Obnovit všechna VTXO" stays real even
  // with the engine live (a session opened before it went live, another
  // device): it must not hide the one recovery action (cancelPendingRound(), inside VtxoConsolidate's pending
  // branch) that can get those VTXOs unstuck from a round that's failing.
  const hasPendingVtxoRefresh = getPendingVtxoRefresh() !== null;
  const cached = engineLive ? lastVtxoRead.get(wallet.fingerprint) : undefined;
  const [vtxos, setVtxos] = useState<Vtxo[] | null>(cached?.vtxos ?? null);
  const [overview, setOverview] = useState<EngineOverview | null>(cached?.overview ?? null);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  // A user action behind this (refresh, release, cancel) changed coins:
  // re-read for real, not from the shared snapshot.
  const reload = useCallback(() => {
    dropVtxoSnapshot(wallet.fingerprint);
    setRefreshVersion((n) => n + 1);
  }, [wallet]);
  // The engine's state changing (a tick, a release) re-reads the screen.
  const engineLog = useSyncExternalStore(subscribeEngine, () => {
    const log = engineSnapshot().state.log;
    return `${log.length}:${log.at(-1)?.at ?? 0}`;
  });

  // One read for the whole screen, so the cards don't pop in one by one: with
  // the engine live, its overview (which carries the VTXO list too), else
  // just the list. The previous result stays up while a re-read runs.
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      (waitForIdleRefresh ? waitForIdleRefresh() : Promise.resolve())
        .then(async () => {
          // See SEND_WATCHDOG_MS's own comment (walletCall.ts) — a wallet with
          // enough VTXO history for allVtxos() to genuinely take a while
          // shouldn't have that trip bark.ts's 25s crash-recovery watchdog and
          // force the whole app back to "unlock" just for opening this screen.
          const popWatchdog = pushWorkerWatchdogOverride(SEND_WATCHDOG_MS);
          try {
            if (engineLive) {
              try {
                const o = await computeOverview(wallet);
                if (cancelled) return;
                setOverview(o);
                setOverviewError(null);
                const list = vtxosForList(o.vtxos as Vtxo[]).filter((x) => x.state.type !== "exited");
                lastVtxoRead.set(wallet.fingerprint, { overview: o, vtxos: list });
                setVtxos(list);
                setError(null);
                return;
              } catch (e) {
                if (cancelled) return;
                setOverviewError(rawErrorMessage(e) || t("Neznámá chyba"));
              }
            }
            const v = await withTimeout(wallet.allVtxos(), WALLET_CALL_TIMEOUT_MS, t(TIMEOUT_MESSAGE));
            if (cancelled) return;
            const list = vtxosForList(v);
            setVtxos(list);
            setError(null);
          } finally {
            popWatchdog();
          }
        })
        .catch((e) => {
          if (cancelled) return;
          // Without a timeout, a stalled allVtxos() call (same class of
          // network hang as other wallet.* calls, see ../lib/walletCall)
          // used to leave this screen showing "Načítám…" forever. A blank
          // e.message would do the same thing again below (falsy `error`
          // skips the error branch while `vtxos` stays null) — fall back to
          // a non-empty string so that can't happen.
          surfaceError(e, setError, rawErrorMessage(e) || t("Neznámá chyba"));
        });
    void load();
    // Expiry is counted in blocks; once a minute is plenty.
    const timer = window.setInterval(load, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet, engineLive, refreshVersion, engineLog]);

  const loaded = vtxos !== null || error !== null;
  const engineRoundIds = new Set(
    engineLive ? engineSnapshot().state.batches.flatMap((b) => (b.roundId == null ? [] : [b.roundId])) : [],
  );

  return (
    <div className="settings-body">
      {!loaded && (
        <div className="settings-loading" role="status">
          <div className="spinner" aria-hidden="true" />
          <span className="muted small">{t("Načítám…")}</span>
        </div>
      )}
      {loaded && engineLive && (
        <RefreshEnginePanel wallet={wallet} overview={overview} overviewError={overviewError} onChanged={reload} />
      )}
      {/* Ground truth, independent of everything else on this screen — see
          PendingRoundsPanel's own comment. Shown for every wallet, beta or
          not, since it's not a feature at all. Silent until it has something
          to say, so it can load on its own (a stuck round can take minutes)
          without the screen jumping. */}
      {/* With the engine live, the overview read carries the rounds: wait for
          it instead of starting a second slow pendingRoundStates(). */}
      {(!engineLive || loaded) && (
        <PendingRoundsPanel wallet={wallet} hideRoundIds={engineRoundIds} known={overview?.rounds as RoundState[] | undefined} />
      )}
      {/* Rendered before the allVtxos() error below — a round registered via
          "Obnovit všechna VTXO" can be what makes allVtxos() hang, and the
          cancel inside VtxoConsolidate's pending branch doesn't need vtxoIds.
          With the refresh engine live, its own "Obnovit teď" is the manual
          path: same guards and locks as the automatic one. */}
      {((!engineLive && loaded) || hasPendingVtxoRefresh) && (
        <VtxoConsolidate
          wallet={wallet}
          vtxoIds={vtxos?.filter((v) => v.state.type === "spendable").map((v) => v.id) ?? []}
          onDone={reload}
          canRegisterNew={!engineLive}
        />
      )}
      {error && <div className="error">{error}</div>}

      {vtxos?.length === 0 && <p className="muted">{t("Žádné VTXO.")}</p>}
      {vtxos && vtxos.length > 0 && <CoinList vtxos={vtxos} tipHeight={overview?.forecast.tipHeight ?? null} />}
    </div>
  );
}

// The coins as one short list, a line each. Tap a coin for its id and depth.
const COIN_STATE: Record<VtxoState["type"], string> = {
  spendable: "k dispozici",
  locked: "zamčená",
  exited: "v exitu",
  spent: "utracená",
};

function CoinList({ vtxos, tipHeight }: { vtxos: readonly Vtxo[]; tipHeight: number | null }) {
  const t = useT();
  const lang = useLang();
  const [open, setOpen] = useState<string | null>(null);
  const sorted = [...vtxos].sort((a, b) => a.expiryHeight - b.expiryHeight);
  return (
    <div className="vtxo-card">
      <div className="info-row">
        <span>{t("Mince")}</span>
        <code>{sorted.length}</code>
      </div>
      <div className="coin-list">
        {sorted.map((v) => (
          <button key={v.id} type="button" className="coin-row" onClick={() => setOpen((o) => (o === v.id ? null : v.id))}>
            <span className="coin-row-main">
              <strong>{v.amountSats.toLocaleString(localeFor(lang))} sats</strong>
              <span className="muted small">
                {t(COIN_STATE[v.state.type])}
                {" · "}
                {tipHeight === null
                  ? tf(t("blok {height}"), { height: v.expiryHeight })
                  : v.expiryHeight > tipHeight
                    ? tf(t("vyprší {when}"), { when: approxTime(v.expiryHeight - tipHeight, t) })
                    : t("vypršela")}
              </span>
            </span>
            {open === v.id && (
              <span className="coin-row-detail muted small">
                {tf(t("hloubka {n}"), { n: v.exitDepth })} · {tf(t("blok {height}"), { height: v.expiryHeight })}
                <span className="vtxo-id">{v.id}</span>
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

// Registers every current VTXO for the next Ark round via
// refreshVtxosDelegated(), which resets each one's exitDepth back to 0
// (see VtxoList's "Původ" row) at the cost of the server's refresh fee
// (ppm on the amount, no flat fee, no on-chain footprint — unlike
// board/offboard/exit). Deliberately doesn't promise the round will merge
// everything into a single output — the SDK's own docs return the round's
// outputs as an array without saying how the server chooses to split them,
// so all this can honestly claim is "fresh, depth-0 VTXOs", not "one big
// coin". Still open: proactive VTXO expiry detection.
function VtxoConsolidate({
  wallet,
  vtxoIds,
  onDone,
  canRegisterNew,
}: {
  wallet: WalletClient;
  vtxoIds: string[];
  onDone: () => void;
  // Registering VTXOs for a fresh round is still the beta feature — only
  // *cancelling an already-registered one* (the `pending` branch below) is
  // exempt from that gate, since it's recovery for something that already
  // happened, not a new feature to opt into. See VtxoList's own
  // hasPendingVtxoRefresh comment for why this component can render at all
  // outside of beta.
  canRegisterNew: boolean;
}) {
  const t = useT();
  const lang = useLang();
  const [pending, setPending] = useState<PendingVtxoRefresh | null>(() => getPendingVtxoRefresh());
  const [showConfirm, setShowConfirm] = useState(false);
  const [feeEstimate, setFeeEstimate] = useState<FeeEstimate | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  // Re-checked fresh every time this screen opens rather than tracked by a
  // persistent background watcher — see vtxoRefresh.ts's file comment for
  // why (Settings unmounts on close, and the round itself can take up to
  // ~1h, so there's nothing useful for a watcher to do while this screen
  // isn't open anyway). Self-scheduling, matching EmergencyExit.tsx's
  // pattern, stopped on unmount rather than left running once this
  // component goes away.
  useEffect(() => {
    if (!pending) return;
    let cancelled = false;
    let timer: number | undefined;
    const tick = async () => {
      // See SEND_WATCHDOG_MS's own comment (walletCall.ts) — progressing a
      // round is real round participation (same class of call as
      // maintenance()/boardAll()), and this poll runs every 8s for as long
      // as this screen stays open — without this override, a round that's
      // merely taking a while queues every call behind it right into
      // bark.ts's 25s crash-recovery watchdog, tearing down the worker (and
      // forcing a re-unlock) for a round that was never actually stuck.
      const popWatchdog = pushWorkerWatchdogOverride(SEND_WATCHDOG_MS);
      try {
        // Best-effort nudge — mirrors how progressExits() is called
        // periodically elsewhere for the exit flow's own pending state,
        // not documented as required but cheap and harmless if it is a
        // no-op when nothing needs advancing.
        await wallet.progressPendingRounds().catch(() => {});
        const states = await withTimeout(wallet.pendingRoundStates(), WALLET_CALL_TIMEOUT_MS, t(TIMEOUT_MESSAGE));
        if (cancelled) return;
        const stillPending = states.find((s) => s.id === pending.roundId);
        const finalState = stillPending?.state;
        // Don't use `ongoing` here — it only covers state "pending"/
        // "ongoing", not "delegated-pending" (still waiting for its
        // scheduled block height) or "awaiting-confirmations" (broadcast,
        // waiting for the chain), both of which are still in flight. Only
        // stop polling once the round is actually gone or in a terminal
        // state.
        if (!stillPending || finalState === "failed" || finalState === "canceled") {
          clearPendingVtxoRefresh();
          setPending(null);
          // RoundState now carries `state: RoundFlowKind`, so we can tell
          // success ("awaiting-confirmations") apart from a genuine failure
          // or cancellation instead of always claiming it went fine — this
          // used to be indistinguishable and misled the user during the
          // live incident where VTXOs stayed registered for a round that
          // kept failing.
          const message =
            finalState === "failed"
              ? t("Kolo selhalo. Zkus to znovu.")
              : finalState === "canceled"
                ? t("Kolo bylo zrušeno.")
                : t("Kolo skončilo. Novou expiraci uvidíš v seznamu níže.");
          setStatusMessage(message);
          onDone();
          return;
        }
      } catch (e) {
        // Best-effort — a failed check just retries on the next tick
        // rather than surfacing a scary error for what's likely a
        // transient network hiccup during a background wait.
        console.error("vtxo refresh poll failed", e);
      } finally {
        popWatchdog();
      }
      if (!cancelled) timer = window.setTimeout(tick, 8_000);
    };
    tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending?.roundId]);

  const openConfirm = useCallback(async () => {
    setError(null);
    setStatusMessage(null);
    setBusy(true);
    // See SEND_WATCHDOG_MS's own comment (walletCall.ts) — a fee estimate
    // still has to ask the server, same as the round calls below.
    const popWatchdog = pushWorkerWatchdogOverride(SEND_WATCHDOG_MS);
    try {
      // The automatic refresh (Dashboard's refresh(), delegated) may already
      // have these coins in a delegated participation. Delegated rounds never
      // lock their inputs, so the VTXOs still read as spendable here and a
      // second registration would submit them again.
      const states = await withTimeout(wallet.pendingRoundStates(), WALLET_CALL_TIMEOUT_MS, t(TIMEOUT_MESSAGE));
      if (states.some((s) => s.state === "delegated-pending")) {
        setStatusMessage(t("Obnova už čeká na kolo serveru."));
        return;
      }
      const estimate = await withTimeout(wallet.estimateRefreshFee(vtxoIds), WALLET_CALL_TIMEOUT_MS, t(TIMEOUT_MESSAGE));
      setFeeEstimate(estimate);
      setShowConfirm(true);
    } catch (e) {
      surfaceError(e, setError, rawErrorMessage(e) || t("Neznámá chyba"));
    } finally {
      setBusy(false);
      popWatchdog();
    }
  }, [wallet, vtxoIds, t]);

  const confirmRefresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    // See SEND_WATCHDOG_MS's own comment (walletCall.ts) — registering VTXOs
    // for a round is real round participation, not a quick lookup.
    const popWatchdog = pushWorkerWatchdogOverride(SEND_WATCHDOG_MS);
    try {
      const state = await withTimeout(wallet.refreshVtxosDelegated(vtxoIds), WALLET_CALL_TIMEOUT_MS, t(TIMEOUT_MESSAGE));
      if (!state) throw new Error(t("Server nevrátil žádnou odpověď."));
      const record: PendingVtxoRefresh = { roundId: state.id, vtxoIds, startedAt: Date.now() };
      setPendingVtxoRefresh(record);
      setPending(record);
      setShowConfirm(false);
      setStatusMessage(null);
    } catch (e) {
      surfaceError(e, setError, rawErrorMessage(e) || t("Neznámá chyba"));
    } finally {
      setBusy(false);
      popWatchdog();
    }
  }, [wallet, vtxoIds, t]);

  const cancelPending = useCallback(async () => {
    if (!pending) return;
    setBusy(true);
    setError(null);
    // See SEND_WATCHDOG_MS's own comment (walletCall.ts) — cancelling still
    // has to tell the server, same as every other round call here. This is
    // also the one call this screen's users most need to actually work when
    // a round is stuck — no override here was exactly what could leave it
    // tripping the worker's crash-recovery watchdog instead of completing.
    const popWatchdog = pushWorkerWatchdogOverride(SEND_WATCHDOG_MS);
    try {
      await withTimeout(wallet.cancelPendingRound(pending.roundId), WALLET_CALL_TIMEOUT_MS, t(TIMEOUT_MESSAGE));
      clearPendingVtxoRefresh();
      setPending(null);
    } catch (e) {
      surfaceError(e, setError, rawErrorMessage(e) || t("Neznámá chyba"));
    } finally {
      setBusy(false);
      popWatchdog();
    }
  }, [wallet, pending, t]);

  return (
    <div className="vtxo-card">
      <div className="info-row">
        <span>{t("Obnovit všechna VTXO")}</span>
      </div>
      {pending ? (
        <div className="settings-body" style={{ padding: "14px 16px 16px" }}>
          <p className="muted small">{t("Čeká na kolo serveru, do ~1 hodiny.")}</p>
          {error && <p className="error">{error}</p>}
          <button className="secondary danger small" disabled={busy} onClick={cancelPending}>
            {busy ? t("Ruším…") : t("Zrušit")}
          </button>
        </div>
      ) : canRegisterNew ? (
        <div className="settings-body" style={{ padding: "14px 16px 16px" }}>
          <p className="muted small">{t("Appka je obnovuje sama před expirací. Tady to spustíš hned.")}</p>
          {statusMessage && <p className="muted small">{statusMessage}</p>}
          {error && <p className="error">{error}</p>}
          <button className="secondary small" disabled={busy || vtxoIds.length === 0} onClick={openConfirm}>
            {busy ? t("Načítám…") : t("Obnovit")}
          </button>
        </div>
      ) : null}
      {showConfirm && feeEstimate && (
        <div className="modal-backdrop" onClick={busy ? undefined : () => setShowConfirm(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{t("Obnovit všechna VTXO")}</h2>
            </div>
            <p className="muted small">{t("Proběhne v příštím kole serveru, do ~1 hodiny. Do té doby jde zrušit.")}</p>
            <div className="info-row">
              <span>{t("Počet VTXO")}</span>
              <strong>{vtxoIds.length}</strong>
            </div>
            <div className="info-row">
              <span>{t("Poplatek")}</span>
              <strong>{feeEstimate.feeSats.toLocaleString(localeFor(lang))} sats</strong>
            </div>
            {error && (
              <div className="banner banner-danger">
                <ErrorCircleIcon />
                <span>{error}</span>
              </div>
            )}
            <div className="stack">
              <button disabled={busy} onClick={confirmRefresh}>
                {busy ? t("Zahajuji…") : t("Potvrdit")}
              </button>
              <button type="button" className="secondary" disabled={busy} onClick={() => setShowConfirm(false)}>
                {t("Zpět")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Diagnostic view: per-transaction confirmation detail from the SDK, as
// opposed to the aggregate OnchainBalance.confirmedSats/pendingSats shown
// elsewhere — useful when that aggregate disagrees with what a block
// explorer shows for the same deposit (i.e. the wallet's own bookkeeping is
// the thing in question, not the actual chain state).
function OnchainTxList({ wallet }: { wallet: WalletClient }) {
  const t = useT();
  const [txs, setTxs] = useState<WalletTransaction[] | null>(null);
  const [tipHeight, setTipHeight] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  const loadCached = useCallback(async () => {
    // See SEND_WATCHDOG_MS's own comment (walletCall.ts) — even reading
    // already-cached data can apparently take a while for a wallet with
    // enough onchain history, and this runs the moment the screen opens, no
    // user action beyond that. Shouldn't cost a forced relock just for
    // looking.
    const popWatchdog = pushWorkerWatchdogOverride(SEND_WATCHDOG_MS);
    try {
      const [result, tip] = await Promise.all([
        withTimeout(wallet.onchainWallet.transactions(), WALLET_CALL_TIMEOUT_MS, t(TIMEOUT_MESSAGE)),
        withTimeout(wallet.onchainWallet.tipHeight(), WALLET_CALL_TIMEOUT_MS, t(TIMEOUT_MESSAGE)).catch(() => null),
      ]);
      setTxs(result);
      setTipHeight(tip);
    } finally {
      popWatchdog();
    }
  }, [wallet, t]);

  useEffect(() => {
    let cancelled = false;
    // Deliberately NOT syncing first here anymore: sync() checks every
    // locally revealed onchain address every time
    // (start_sync_with_revealed_spks_at), which can take much longer than
    // any reasonable timeout for a screen that's just being opened to look
    // at something. Shows whatever's already cached immediately; the
    // "Synchronizovat" button below does the expensive sync on demand
    // instead of forcing every visit to pay for it.
    (async () => {
      try {
        await loadCached();
      } catch (e) {
        // A blank e.message would make setError("") falsy below, skipping
        // the error branch while txs stays null — same bug VtxoList had.
        if (!cancelled) surfaceError(e, setError, rawErrorMessage(e) || t("Neznámá chyba"));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadCached]);

  const handleSync = () => {
    setSyncing(true);
    setError(null);
    const popWatchdog = pushWorkerWatchdogOverride(ONCHAIN_SYNC_TIMEOUT_MS);
    withTimeout(wallet.onchainWallet.sync(), ONCHAIN_SYNC_TIMEOUT_MS, t(TIMEOUT_MESSAGE))
      .then(loadCached)
      .catch((e) => surfaceError(e, setError, rawErrorMessage(e) || t("Neznámá chyba")))
      .finally(() => {
        setSyncing(false);
        popWatchdog();
      });
  };

  if (error) return <div className="settings-body error">{error}</div>;
  if (!txs) {
    return (
      <div className="settings-body">
        <div className="settings-loading" role="status">
          <div className="spinner" aria-hidden="true" />
          <span className="muted small">{t("Načítám…")}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="settings-body">
      <button className="secondary small" onClick={handleSync} disabled={syncing}>
        {syncing ? t("Synchronizuji (může trvat déle)…") : t("Synchronizovat")}
      </button>
      {txs.length === 0 && <p className="muted">{t("Žádné onchain transakce.")}</p>}
      {txs.map((tx) => (
        <div key={tx.txid} className="vtxo-card">
          <div className="info-row">
            <span>{t("Změna zůstatku")}</span>
            <strong>
              {tx.balanceChangeSats > 0 ? "+" : ""}
              {tx.balanceChangeSats.toLocaleString(getLang() === "en" ? "en-US" : "cs-CZ")} sats
            </strong>
          </div>
          <div className="info-row">
            <span>{t("Stav")}</span>
            <code>{tx.confirmation ? tf(t("Potvrzeno v bloku {block}"), { block: tx.confirmation.height }) : t("V mempoolu (nepotvrzeno)")}</code>
          </div>
          {tx.confirmation && tipHeight !== null && (
            <div className="info-row">
              <span>{t("Potvrzení")}</span>
              <code>{Math.max(1, tipHeight - tx.confirmation.height + 1).toLocaleString(getLang() === "en" ? "en-US" : "cs-CZ")}</code>
            </div>
          )}
          {tx.onchainFeeSats !== undefined && (
            <div className="info-row">
              <span>{t("Poplatek")}</span>
              <code>{tx.onchainFeeSats.toLocaleString(getLang() === "en" ? "en-US" : "cs-CZ")} sats</code>
            </div>
          )}
          {tx.isCpfp && (
            <div className="info-row">
              <span>CPFP</span>
              <code>{t("Ano")}</code>
            </div>
          )}
          <CopyRow label="Txid" value={tx.txid} />
        </div>
      ))}
    </div>
  );
}

// Builds a plain-text dump of the call log for export/sharing — same fields
// as the on-screen list, just flattened to one line per entry so it pastes
// cleanly into a bug report or chat.
function formatCallLogText(entries: readonly CallLogEntry[]): string {
  const header = formatCallLogHeader({
    version: __APP_VERSION__,
    commit: __APP_COMMIT__,
    network: APP_NETWORK,
    design: getDesignVersion(),
    userAgent: navigator.userAgent,
    language: navigator.language,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    online: typeof navigator.onLine === "boolean" ? navigator.onLine : null,
    visibility: document.visibilityState,
    exportedAt: Date.now(),
    firstAt: entries.length > 0 ? entries[0].time : null,
    lastAt: entries.length > 0 ? entries[entries.length - 1].time : null,
    count: entries.length,
    errors: entries.filter((e) => e.status === "error").length,
  });
  const lines = entries
    .map((e) => {
      const dur = e.durationMs !== undefined ? `${e.durationMs}ms` : "pending";
      const args = e.args !== undefined && e.args.length > 0 ? ` args=${JSON.stringify(e.args)}` : "";
      const err = e.error ? ` error=${e.error}` : "";
      return `${new Date(e.time).toISOString()} [${e.status}] ${e.label} (${dur})${args}${err}`;
    })
    .join("\n");
  return `${header}\n${lines}`;
}

async function exportCallLog(entries: readonly CallLogEntry[]): Promise<void> {
  const text = formatCallLogText(entries);
  const filename = `spendrr-wallet-log-${new Date().toISOString().slice(0, 10)}.txt`;
  const blob = new Blob([text], { type: "text/plain" });
  const nav = navigator as Navigator & {
    canShare?: (data: { files: File[] }) => boolean;
    share?: (data: { files: File[]; title?: string }) => Promise<void>;
  };
  if (nav.share && nav.canShare) {
    const file = new File([blob], filename, { type: "text/plain" });
    if (nav.canShare({ files: [file] })) {
      try {
        await nav.share({ files: [file], title: filename });
        return;
      } catch {
        // User cancelled the share sheet, or it failed — fall back to a
        // plain download below rather than leaving the tap looking like it
        // did nothing.
      }
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

const LOG_INITIAL_COUNT = 10;
const LOG_PAGE_SIZE = 20;

// Log of every request that has crossed into the wallet worker (see
// bark.ts's request()) — method name, sanitized args, status, duration, and
// (crucially for debugging) the error message for anything that failed.
// Persisted in IndexedDB (see bark.ts's CallLogEntry comment), so this
// covers real usage across separate app opens, not just whatever happened to
// still be in memory — a stuck round is exactly the kind of thing noticed
// *after* reopening the app. Exists so a hung/failing call can actually be
// diagnosed from the phone itself, without remote devtools. Deliberately
// reads only what bark.ts already sanitized, never a raw payload — payload
// .auth/.source can carry the plaintext password or mnemonic.
function CallLogPage() {
  const t = useT();
  const [, setVersion] = useState(0);
  const [exporting, setExporting] = useState(false);
  useEffect(() => subscribeCallLog(() => setVersion((n) => n + 1)), []);
  const entries = getCallLog();
  const errorCount = entries.filter((e) => e.status === "error").length;

  // Rendering all of a 5000-entry log at once (bark.ts's CALL_LOG_MAX_ENTRIES)
  // would be an unbounded, ever-growing DOM list — reveal it in pages
  // instead, same pattern as MnemonicGrid's "Zobrazit další". No reset logic
  // needed for Vymazat: visibleCount below is clamped to entries.length, so
  // an emptied log just renders nothing regardless of shownCount.
  const [shownCount, setShownCount] = useState(LOG_INITIAL_COUNT);
  const visibleCount = Math.min(shownCount, entries.length);

  const statusColor = (e: CallLogEntry): string => {
    if (e.status === "pending") return "var(--muted, #888)";
    if (e.status === "error") return "var(--danger)";
    return "var(--success)";
  };

  const handleExport = () => {
    setExporting(true);
    exportCallLog(entries).finally(() => setExporting(false));
  };

  return (
    <div className="settings-body">
      <div className="vtxo-card">
        <div className="info-row">
          <span>{t("Počet záznamů")}</span>
          <strong>{entries.length}</strong>
        </div>
        {entries.length > 0 && (
          <div className="info-row">
            <span>{t("Nejstarší záznam")}</span>
            <code>{new Date(entries[0].time).toLocaleString(getLang() === "en" ? "en-US" : "cs-CZ")}</code>
          </div>
        )}
        {errorCount > 0 && (
          <div className="info-row">
            <span>{t("Chyby")}</span>
            <strong className="error">{errorCount}</strong>
          </div>
        )}
        <div style={{ display: "flex", gap: 8, padding: "12px 16px" }}>
          <button className="secondary small" disabled={entries.length === 0 || exporting} onClick={handleExport}>
            {exporting ? t("Exportuji…") : t("Exportovat")}
          </button>
          <button className="secondary danger small" disabled={entries.length === 0} onClick={clearCallLog}>
            {t("Vymazat")}
          </button>
        </div>
      </div>
      <div className="vtxo-card">
        {entries.length === 0 && (
          <p className="muted small" style={{ padding: "10px 16px", margin: 0 }}>
            {t("Zatím žádná volání.")}
          </p>
        )}
        {[...entries]
          .reverse()
          .slice(0, visibleCount)
          .map((e) => (
            <div
              key={e.id}
              className="info-row"
              style={{ flexDirection: "column", alignItems: "stretch", gap: 4, padding: "10px 16px" }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
                <code style={{ color: statusColor(e), textAlign: "left", maxWidth: "none" }}>{e.label}</code>
                <span className="muted small" style={{ whiteSpace: "nowrap", flexShrink: 0 }}>
                  {new Date(e.time).toLocaleString(getLang() === "en" ? "en-US" : "cs-CZ")}
                  {e.durationMs !== undefined ? ` · ${e.durationMs}ms` : ` · ${t("čeká…")}`}
                </span>
              </div>
              {e.args !== undefined && e.args.length > 0 && (
                <code className="muted small" style={{ wordBreak: "break-all", textAlign: "left", maxWidth: "none" }}>
                  {JSON.stringify(e.args)}
                </code>
              )}
              {e.error && (
                <span className="error small" style={{ wordBreak: "break-all", textAlign: "left" }}>
                  {e.error}
                </span>
              )}
            </div>
          ))}
        {visibleCount < entries.length && (
          <button
            className="secondary small"
            style={{ margin: "12px 16px" }}
            onClick={() => setShownCount((c) => c + LOG_PAGE_SIZE)}
          >
            {tf(t("Zobrazit další ({shown}/{total})"), {
              shown: Math.min(visibleCount + LOG_PAGE_SIZE, entries.length),
              total: entries.length,
            })}
          </button>
        )}
      </div>
    </div>
  );
}

function SeedReveal() {
  const t = useT();
  const [password, setPassword] = useState("");
  const [mnemonic, setMnemonic] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reveal = useCallback(async () => {
    const vault = loadVaultOrPrompt();
    if (!vault) {
      setError(t(missingVaultText()));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const m = await decryptMnemonic(vault, password);
      setMnemonic(m);
      // A wallet that arrived via a gift link shows a "back up your seed"
      // banner until the seed has actually been on screen at least once.
      clearNeedsSeedBackup();
      // decryptMnemonic succeeded, so the password was right — and the seed
      // itself is now on screen, which is the stronger way back in anyway.
      // Nothing is left for the plaintext copy to protect against.
      clearPendingGiftPassword();
    } catch {
      setError(t("Nesprávné heslo."));
    } finally {
      setBusy(false);
    }
  }, [password, t]);

  if (mnemonic) {
    const words = mnemonic.split(" ");
    return (
      <div className="settings-body">
        <div className="banner banner-warning">
          <WarningIcon />
          <span>{t("Nikomu tato slova neukazuj. Kdokoliv je uvidí, může ti ukrást prostředky.")}</span>
        </div>
        <MnemonicGrid words={words} />
      </div>
    );
  }

  return (
    <div className="settings-body">
      <p className="muted">{t("Pro zobrazení seed phrase potvrď své heslo.")}</p>
      <input
        type="password"
        placeholder={t("Heslo")}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && reveal()}
      />
      {error && (
        <div className="banner banner-danger">
          <ErrorCircleIcon />
          <span>{error}</span>
        </div>
      )}
      <button disabled={busy || !password} onClick={reveal}>
        {busy ? t("Ověřuji…") : t("Zobrazit")}
      </button>
    </div>
  );
}

function ChangePassword({ onDone }: { onDone: () => void }) {
  const t = useT();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [busy, setBusy] = useState(false);
  const mismatch = confirm.length > 0 && next !== confirm;
  const nextProblem = passwordProblem(next);

  const submit = useCallback(async () => {
    const vault = loadVaultOrPrompt();
    if (!vault) {
      setError(t(missingVaultText()));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Bytes, not a string: nothing here needs to *read* the seed, only to
      // re-encrypt it under the new password, and a JS string can never be
      // zeroed once it exists. Same reasoning as the worker boundary on the
      // unlock path — see ARCHITECTURE.md.
      const seedBytes = await decryptVaultBytes(vault, current);
      let newVault;
      try {
        newVault = await encryptVaultBytes(seedBytes, next);
      } finally {
        zeroBytes(seedBytes);
      }
      saveVault(newVault);
      // The exit destination's tag is keyed by the password and the vault's
      // salt, both of which just changed. Re-tagged only if the OLD tag still
      // vouches for the stored address; otherwise the address is dropped and
      // the exit screen asks for it again (exitDestinationTag.ts). A failure
      // here leaves the old tag, which blocks the claim until the address is
      // set again: never a claim to an unverified address.
      try {
        await rekeyStoredExitDestination({ password: current, vault }, { password: next, vault: newVault });
      } catch (e) {
        console.warn("exit destination rekey failed", e);
      }
      // A gift-link recipient's auto-generated password may still be sitting
      // in localStorage in the clear (giftStore.ts's PENDING_PW_KEY, the
      // safety net for a password they never typed). Two reasons it must go
      // exactly here: the user just proved possession by typing it as
      // `current`, and it no longer even opens the vault — leaving it would
      // have the unlock screen's "here is your password" modal offer a
      // string that is now guaranteed to fail.
      clearPendingGiftPassword();
      setSuccess(true);
    } catch {
      setError(t("Nesprávné současné heslo."));
    } finally {
      setBusy(false);
    }
  }, [current, next, t]);

  if (success) {
    return (
      <div className="settings-body">
        <div className="banner banner-success">
          <SuccessCircleIcon />
          <span>{t("Heslo bylo změněno.")}</span>
        </div>
        <button onClick={onDone}>{t("Zpět do nastavení")}</button>
      </div>
    );
  }

  return (
    <div className="settings-body">
      <div className="field">
        <label className="field-label">{t("Současné heslo")}</label>
        <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} />
      </div>
      <div className="field">
        <label className="field-label">{t("Nové heslo")}</label>
        <input type="password" value={next} onChange={(e) => setNext(e.target.value)} />
      </div>
      <div className="field">
        <label className="field-label">{t("Nové heslo znovu")}</label>
        <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      </div>
      {mismatch && <p className="error">{t("Nová hesla se neshodují.")}</p>}
      {/* See the identical hint on the create-wallet screen (App.tsx) for
          why this names the weakness instead of a character-class rule. */}
      {!mismatch && nextProblem && <p className="error">{t(nextProblem)}</p>}
      {error && <p className="error">{error}</p>}
      <button disabled={busy || !current || !isPasswordStrong(next) || mismatch} onClick={submit}>
        {busy ? t("Měním…") : t("Změnit heslo")}
      </button>
    </div>
  );
}

function BiometricUnlock() {
  const t = useT();
  const [enabled, setEnabled] = useState(hasBiometricUnlock());
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const enroll = useCallback(async () => {
    const vault = loadVaultOrPrompt();
    if (!vault) {
      setError(t(missingVaultText()));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Bytes, not a string, for the same reason as the password change
      // above — enrollBiometricUnlock only re-encrypts them.
      const seedBytes = await decryptVaultBytes(vault, password);
      try {
        await enrollBiometricUnlock(seedBytes);
      } finally {
        zeroBytes(seedBytes);
      }
      // decryptVaultBytes above only got this far because `password` was
      // correct, so the user demonstrably has it — drop the plaintext copy a
      // gift-link recipient may still have in localStorage.
      //
      // This is the path that made that copy effectively permanent: from now
      // on they unlock with a fingerprint, and App.tsx's clear only ever ran
      // after a successful *password* unlock. The auto-generated password sat
      // next to the vault it opens, in the clear, for the life of the wallet.
      clearPendingGiftPassword();
      setEnabled(true);
      setSuccess(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("Nesprávné heslo."));
    } finally {
      setBusy(false);
    }
  }, [password, t]);

  const disable = useCallback(() => {
    clearBiometricUnlock();
    setEnabled(false);
    setSuccess(false);
    setPassword("");
  }, []);

  if (enabled) {
    return (
      <div className="settings-body">
        {success && (
          <div className="banner banner-success">
            <SuccessCircleIcon />
            <span>{t("Odemykání otiskem je zapnuté.")}</span>
          </div>
        )}
        <p className="muted">
          {t("Na tomto zařízení je zapnuté odemykání otiskem. Heslo pořád funguje jako záloha, pokud otisk selže.")}
        </p>
        <button className="danger" onClick={disable}>
          {t("Vypnout odemykání otiskem")}
        </button>
      </div>
    );
  }

  return (
    <div className="settings-body">
      <p className="muted">
        {t(
          "Pro zapnutí odemykání otiskem potvrď své heslo. Otisk pak bude sloužit k rychlému odemčení místo hesla; heslo zůstává funkční jako záloha.",
        )}
      </p>
      <input
        type="password"
        placeholder={t("Heslo")}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && enroll()}
      />
      {error && (
        <div className="banner banner-danger">
          <ErrorCircleIcon />
          <span>{error}</span>
        </div>
      )}
      <button disabled={busy || !password} onClick={enroll}>
        {busy ? t("Nastavuji…") : t("Zapnout odemykání otiskem")}
      </button>
    </div>
  );
}

// Inline switch like AutoLockSetting (it was a page of its own with one
// switch on it). Turning it on may ask for motion-sensor permission (iOS);
// a refusal shows under the row.
function ShakeSetting() {
  const t = useT();
  const [enabled, setEnabled] = useState(isShakeEnabled());
  const [denied, setDenied] = useState(false);
  const [busy, setBusy] = useState(false);

  const choose = useCallback(async (value: boolean) => {
    if (!value) {
      disableShake();
      setEnabled(false);
      setDenied(false);
      return;
    }
    setBusy(true);
    const ok = await enableShake();
    setEnabled(ok);
    setDenied(!ok);
    setBusy(false);
  }, []);

  return (
    <>
      <div className="settings-row settings-row--inline">
        <div className="settings-row-label">{t("Zatřesením skrýt zůstatek")}</div>
        <BooleanSwitch checked={enabled} disabled={busy} onChange={(v) => void choose(v)} label={t("Zatřesením skrýt zůstatek")} />
      </div>
      {denied && (
        <div className="settings-row">
          <p className="error small">{t("Pohybové senzory zamítnuty v prohlížeči")}</p>
        </div>
      )}
    </>
  );
}
