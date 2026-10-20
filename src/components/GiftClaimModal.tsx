import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  claimGiftToAddress,
  generateMnemonic,
  GIFT_EMPTY_MESSAGE,
  GIFT_SLOW_MESSAGE,
  scanGiftStatus,
  type WalletClient,
} from "../lib/wallet/bark";
import { encryptMnemonic, loadVault, saveVault } from "../lib/vault/crypto";
import { hasBiometricUnlock } from "../lib/vault/webauthn";
import { createDeviceVault, hasDeviceVault } from "../lib/vault/deviceVault";
import { requestPersistentStorage } from "../lib/vault/storageProtection";
import { isPasswordStrong, passwordProblem } from "../lib/vault/password";
import { offerPasswordToManager } from "../lib/vault/credentialStore";
import {
  clearNeedsSeedBackup,
  markGiftClaimed,
  markNeedsSeedBackup,
} from "../lib/gift/giftStore";
import type { GiftLinkParams } from "../lib/gift/giftLink";
import { fetchBtcRates } from "../lib/price";
import { getFiatCurrency } from "../lib/currency";
import { hapticSuccess } from "../lib/ui/haptics";
import { localeFor, useLang, useT } from "../lib/i18n";
import { BigAmount, Collapse, Screen, Sheet, StatusMark, WaitingDots } from "./sheet/PaySheet";
import "./GiftReveal.css";
import { surfaceError } from "../lib/appErrors";
import { stableArkAddress } from "../lib/send/arkAddress";

type Rates = Awaited<ReturnType<typeof fetchBtcRates>>;

type Phase = "set-password" | "preparing" | "needs-unlock" | "claiming" | "ready" | "error";

// The receiving half of a gift link: what someone sees when they open
// spendrr.app/g#… . Built on the same sheet as the sender's composer and as
// tap-to-pay (sheet/PaySheet.tsx), with one thing of its own — the box
// actually opens when the claim lands (GiftReveal.css), and the amount
// counts up out of it.
//
// The claim itself is unchanged: a fresh recipient gets a wallet created
// here, an existing one unlocks, and either way the gift is pulled in the
// background while this screen is already showing what is coming.

// The credential-manager username the recipient password is
// filed under. Fixed string, not the wallet fingerprint — the user recovers
// by picking "Spendrr" in their password manager, not by matching an id.
const CREDENTIAL_USERNAME = "Spendrr";

// Shown when the pull ran out of time but a look at the server says the gift is still there (or half pulled):
// it is the connection, not a taken gift, and the same tap tries again.
const GIFT_RETRY_MESSAGE = "Pomalé spojení. Dárek je pořád tvůj, zkus to znovu.";

export default function GiftClaimModal({
  gift,
  liveWallet,
  onOpenFresh,
  onOpenVault,
  onOpenDevice,
  onDone,
}: {
  gift: GiftLinkParams;
  // Non-null once any wallet session is open (fresh one we just created, or
  // the device's existing one after unlock).
  liveWallet: WalletClient | null;
  onOpenFresh: (mnemonic: string) => Promise<void>;
  onOpenVault: (password: string) => Promise<void>;
  // Opens this device's passwordless wallet (deviceVault.ts) without asking for anything.
  onOpenDevice: () => Promise<void>;
  onDone: () => void;
}) {
  const t = useT();
  const lang = useLang();
  const fmt = (n: number) => n.toLocaleString(localeFor(lang));
  const cur = getFiatCurrency();
  // Computed once at mount: no vault on this device and no biometric vault
  // either → this is a brand-new recipient and we create their wallet here.
  const [freshRecipient] = useState(() => loadVault() === null && !hasBiometricUnlock() && !hasDeviceVault());
  // An earlier passwordless gift wallet is on this device: it opens by itself, no password to ask for.
  const [deviceRecipient] = useState(() => !freshRecipient && loadVault() === null && hasDeviceVault());

  const [phase, setPhase] = useState<Phase>(
    freshRecipient || (deviceRecipient && !liveWallet) ? "preparing" : liveWallet ? "claiming" : "needs-unlock",
  );
  const [claimedSats, setClaimedSats] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [rates, setRates] = useState<Rates | null>(null);
  // The user tapped "Přijmout" before the background claim finished — as
  // soon as it does, dismiss automatically instead of making them tap again.
  const [proceeding, setProceeding] = useState(false);
  const proceedingRef = useRef(false);

  const startedFreshRef = useRef(false);
  const claimStartedRef = useRef(false);

  useEffect(() => {
    fetchBtcRates()
      .then(setRates)
      .catch(() => {});
  }, []);

  // Create the recipient's own wallet and open it. Only ever once: a retry
  // reaches this after a wallet was already made here (its open failed, or the
  // session dropped mid-claim and took the gift worker with it), and that
  // wallet may already hold the gift, or get it when the interrupted forward
  // resumes (bark finishes a stored arkoor send on the next sync, to the
  // address it was started with). A fresh seed would overwrite the only copy
  // of that wallet's seed, so the retry opens the existing one instead.
  const runFreshOpen = useCallback(async (newPassword = "") => {
    if (startedFreshRef.current) return;
    startedFreshRef.current = true;
    setPhase("preparing");
    setErrorMsg(null);
    try {
      if (hasDeviceVault()) {
        await onOpenDevice();
        return;
      }
      if (loadVault() !== null) {
        startedFreshRef.current = false;
        setPhase("needs-unlock");
        return;
      }
      // Complete password setup before persisting a wallet or moving the gift.
      // A refresh before this point leaves no wallet to get locked out of.
      if (!gift.passwordless && (!newPassword || !isPasswordStrong(newPassword))) {
        startedFreshRef.current = false;
        setPhase("set-password");
        return;
      }
      const mnemonic = await generateMnemonic();
      if (gift.passwordless) {
        // No password to invent, store or show: the wallet is sealed under this device's own key and the next open
        // asks for a real one (PasswordSetupSheet). Persistence is asked for now, since the key lives in IndexedDB.
        await createDeviceVault(mnemonic);
        void requestPersistentStorage({ force: true });
        await onOpenFresh(mnemonic);
        return;
      }
      const vault = await encryptMnemonic(mnemonic, newPassword);
      saveVault(vault);
      // The user has entered and confirmed this password. Only offer it to
      // their password manager; never retain a plaintext recovery copy.
      await offerPasswordToManager(CREDENTIAL_USERNAME, newPassword);
      await onOpenFresh(mnemonic);
    } catch (e) {
      startedFreshRef.current = false;
      surfaceError(e, setErrorMsg);
      setPhase("error");
    }
  }, [onOpenFresh, onOpenDevice, gift.passwordless]);

  // Fresh recipients set up their password first; passwordless gifts open
  // eagerly. The actual claim waits for liveWallet in the effect below.
  useEffect(() => {
    if (freshRecipient) void runFreshOpen();
  }, [freshRecipient, runFreshOpen]);

  const deviceOpenStartedRef = useRef(false);
  useEffect(() => {
    if (!deviceRecipient || liveWallet || deviceOpenStartedRef.current) return;
    deviceOpenStartedRef.current = true;
    onOpenDevice().catch((e) => {
      deviceOpenStartedRef.current = false;
      surfaceError(e, setErrorMsg);
      setPhase("error");
    });
  }, [deviceRecipient, liveWallet, onOpenDevice]);

  const runClaim = useCallback(
    async (wallet: WalletClient, fresh: boolean) => {
      if (claimStartedRef.current) return;
      claimStartedRef.current = true;
      setPhase("claiming");
      try {
        const recipientAddr = await stableArkAddress(wallet);
        const { claimedSats: got } = await claimGiftToAddress(gift.mnemonic, gift.id, recipientAddr);
        markGiftClaimed(gift.id);
        if (fresh && !gift.passwordless) markNeedsSeedBackup();
        setClaimedSats(got);
        setPhase("ready");
        hapticSuccess();
        if (proceedingRef.current) onDone();
      } catch (e) {
        claimStartedRef.current = false;
        let msg = e instanceof Error ? e.message : String(e);
        // A pull that never finishes is how a taken gift usually looks, but a slow connection looks the same.
        // The recovery scan tells them apart (giftScan.ts); read-only, so asking costs nothing if it cannot look.
        if (msg === GIFT_SLOW_MESSAGE) {
          const verdict = await scanGiftStatus(gift.mnemonic, gift.id).catch(() => "unknown" as const);
          if (verdict === "claimed") msg = GIFT_EMPTY_MESSAGE;
          else if (verdict === "waiting" || verdict === "opened") msg = GIFT_RETRY_MESSAGE;
        }
        if (msg === GIFT_EMPTY_MESSAGE) {
          // Nothing to claim — mark it so re-opening this link on this
          // device falls straight through instead of spinning again.
          markGiftClaimed(gift.id);
          // A fresh recipient spun up a wallet for nothing; don't then nag
          // about backing it up.
          if (fresh) {
            clearNeedsSeedBackup();
          }
        }
        if (msg === GIFT_EMPTY_MESSAGE || msg === GIFT_RETRY_MESSAGE) setErrorMsg(msg);
        else surfaceError(e, setErrorMsg);
        setPhase("error");
      }
    },
    [gift.mnemonic, gift.id, gift.passwordless, onDone],
  );

  // Once a session is open (fresh or unlocked), pull the gift in.
  useEffect(() => {
    if (!liveWallet) return;
    if (phase === "preparing" || phase === "claiming") void runClaim(liveWallet, freshRecipient);
  }, [liveWallet, phase, freshRecipient, runClaim]);

  const onPrimary = () => {
    if (phase === "ready") {
      onDone();
      return;
    }
    proceedingRef.current = true;
    setProceeding(true);
  };

  const onUnlock = async () => {
    setErrorMsg(null);
    setPhase("claiming");
    try {
      await onOpenVault(password);
      // liveWallet will arrive via props; the effect above runs the claim.
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : t("Nesprávné heslo."));
      setPhase("needs-unlock");
    }
  };

  const rate = rates ? rates[cur] : null;
  const shownSats = claimedSats ?? gift.amountSats;
  const busy = phase === "preparing" || phase === "claiming";
  const opened = phase === "ready";

  // Sparkle positions are random per mount, so two opens in a row don't play
  // an identical burst. Fixed once, not per render.
  const sparkles = useMemo(
    () =>
      Array.from({ length: 7 }, (_, i) => ({
        // Spread around the box, biased upward — this is a burst out of the
        // lid, not a ring around it.
        x: -46 + i * 15 + (Math.random() * 10 - 5),
        y: -8 - Math.random() * 34,
        delay: 120 + Math.random() * 260,
        size: 5 + Math.random() * 5,
      })),
    [],
  );

  let screenKey: string;
  let body;

  if (phase === "set-password") {
    const mismatch = confirmPassword.length > 0 && password !== confirmPassword;
    const problem = passwordProblem(password);
    const canCreate = isPasswordStrong(password) && password === confirmPassword;
    screenKey = "set-password";
    body = (
      <Screen>
        <h2 className="sht-title">{t("Nastav heslo")}</h2>
        <p className="sht-sub">
          {t("Heslo šifruje seed phrase v tomto prohlížeči. Neposílá se nikam a nikdo ho nemůže obnovit za tebe.")}
        </p>
        <input
          type="password"
          className="sht-field"
          placeholder={t("Heslo")}
          value={password}
          autoFocus
          autoComplete="new-password"
          onChange={(e) => setPassword(e.target.value)}
        />
        <input
          type="password"
          className="sht-field"
          placeholder={t("Heslo znovu")}
          value={confirmPassword}
          autoComplete="new-password"
          onChange={(e) => setConfirmPassword(e.target.value)}
        />
        {mismatch && <p className="sht-error">{t("Hesla se neshodují.")}</p>}
        {!mismatch && problem && <p className="sht-sub">{t(problem)}</p>}
        <button
          type="button"
          className="primary sht-wide"
          disabled={!canCreate}
          onClick={() => {
            if (!canCreate) return;
            void runFreshOpen(password);
            setPassword("");
            setConfirmPassword("");
          }}
        >
          {t("Vytvořit peněženku")}
        </button>
      </Screen>
    );
  } else if (phase === "needs-unlock") {
    screenKey = "unlock";
    body = (
      <Screen>
        <GiftBox opened={false} sparkles={sparkles} />
        <p className="gft-kicker">{t("Dostal jsi dárek")}</p>
        <BigAmount sats={gift.amountSats} rate={rate} currency={cur} fmt={fmt} />
        {gift.message && <GiftNote message={gift.message} label={t("vzkaz")} />}
        <p className="sht-sub">{t("Na tomhle zařízení už peněženku máš. Odemkni ji a dárek se do ní připíše.")}</p>
        <input
          type="password"
          className="sht-field"
          placeholder={t("Heslo")}
          value={password}
          autoFocus
          autoComplete="current-password"
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && password) void onUnlock();
          }}
        />
        {errorMsg && <p className="sht-error">{errorMsg}</p>}
        <button type="button" className="primary sht-wide" disabled={!password} onClick={() => void onUnlock()}>
          {t("Odemknout a přijmout")}
        </button>
      </Screen>
    );
  } else if (phase === "error") {
    screenKey = "error";
    body = (
      <Screen>
        <StatusMark state="warn" />
        <h2 className="sht-title">
          {errorMsg === GIFT_EMPTY_MESSAGE ? t("Tenhle dárek už je vyzvednutý") : t("Dárek se nepodařilo vyzvednout")}
        </h2>
        {errorMsg && errorMsg !== GIFT_EMPTY_MESSAGE && <p className="sht-sub">{errorMsg}</p>}
        <div className="sht-actions">
          <button type="button" className="secondary" onClick={onDone}>
            {t("Zavřít")}
          </button>
          {errorMsg !== GIFT_EMPTY_MESSAGE && (
            <button
              type="button"
              className="primary"
              onClick={() => {
                setErrorMsg(null);
                if (liveWallet) {
                  setPhase("claiming");
                  claimStartedRef.current = false;
                  void runClaim(liveWallet, freshRecipient);
                } else if (freshRecipient) {
                  startedFreshRef.current = false;
                  void runFreshOpen();
                } else if (deviceRecipient) {
                  setPhase("preparing");
                  deviceOpenStartedRef.current = false;
                } else {
                  setPhase("needs-unlock");
                }
              }}
            >
              {t("Zkusit znovu")}
            </button>
          )}
        </div>
      </Screen>
    );
  } else {
    // One screen for "waiting on the claim" and "claimed": the key stays the
    // same so the box opens in place rather than the whole step being
    // replaced by a different one under the reveal.
    screenKey = "gift";
    body = (
      <Screen>
        <GiftBox opened={opened} sparkles={sparkles} />
        <p className="gft-kicker">{opened ? t("Je tvůj") : t("Dostal jsi dárek")}</p>
        <BigAmount sats={shownSats} rate={rate} currency={cur} fmt={fmt} countUp={opened} />
        {gift.message && <GiftNote message={gift.message} label={t("vzkaz")} />}
        <button
          type="button"
          className="primary sht-wide"
          onClick={onPrimary}
          disabled={busy && proceeding}
        >
          {busy && proceeding ? t("Přijímám…") : t("Přijmout dárek")}
        </button>
        {/* Reserved space either way (Collapse), so the button doesn't jump
            as the claim resolves. */}
        <Collapse open={busy && proceeding}>
          <p className="sht-sub sht-waiting gft-progress">
            <WaitingDots />
            {t("Připisuju dárek do peněženky")}
          </p>
        </Collapse>
        {freshRecipient && !opened && (
          <p className="sht-sub">{t("Vytvoří se ti vlastní peněženka. Klíče má jen tvoje zařízení.")}</p>
        )}
      </Screen>
    );
  }

  // No backdrop dismissal anywhere in this flow: every path out of it either
  // claims the gift or is an explicit "Zavřít", and a stray tap must not
  // drop a link that may be the only copy of a real payment.
  return <Sheet screenKey={screenKey}>{body}</Sheet>;
}

function GiftNote({ message, label }: { message: string; label: string }) {
  return (
    <div className="gft-note">
      <span className="gft-note-label">{label}</span>
      <p className="gft-note-body">{message}</p>
    </div>
  );
}

// The box: sits closed and breathing while the claim runs, then the lid pops
// off, tilts away and a few sparkles burst out of it. Pure CSS off the
// `is-open` class, so it plays exactly once, when the claim actually lands —
// not on a timer that could celebrate before the money is really there.
function GiftBox({
  opened,
  sparkles,
}: {
  opened: boolean;
  sparkles: { x: number; y: number; delay: number; size: number }[];
}) {
  return (
    <div className={`gft-box${opened ? " is-open" : ""}`} aria-hidden="true">
      <span className="gft-glow" />
      {sparkles.map((s, i) => (
        <span
          key={i}
          className="gft-sparkle"
          style={{
            ["--x" as string]: `${s.x}px`,
            ["--y" as string]: `${s.y}px`,
            ["--d" as string]: `${s.delay}ms`,
            ["--s" as string]: `${s.size}px`,
          }}
        />
      ))}
      <svg viewBox="0 0 88 84" className="gft-box-svg">
        {/* Body */}
        <rect className="gft-body" x="12" y="34" width="64" height="44" rx="6" />
        <rect className="gft-ribbon-v" x="39" y="34" width="10" height="44" />
        {/* Lid — animated as one group so the bow rides along with it. */}
        <g className="gft-lid">
          <rect className="gft-lid-plate" x="7" y="22" width="74" height="16" rx="5" />
          <rect className="gft-ribbon-h" x="39" y="22" width="10" height="16" />
          <path className="gft-bow" d="M44 22c-3-7-14-9-15-3s8 5 15 3zM44 22c3-7 14-9 15-3s-8 5-15 3z" />
        </g>
      </svg>
    </div>
  );
}
