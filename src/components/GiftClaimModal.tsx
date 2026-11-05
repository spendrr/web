import { useCallback, useEffect, useRef, useState } from "react";
import {
  claimGiftToAddress,
  generateMnemonic,
  GIFT_EMPTY_MESSAGE,
  GIFT_SLOW_MESSAGE,
  prepareGiftClaim,
  scanGiftStatus,
  type WalletClient,
} from "../lib/wallet/bark";
import { encryptMnemonic, loadVault, saveVault } from "../lib/vault/crypto";
import { hasBiometricUnlock } from "../lib/vault/webauthn";
import { createDeviceVault, hasDeviceVault } from "../lib/vault/deviceVault";
import { walletTabLock } from "../lib/wallet/walletTabLock";
import { requestPersistentStorage } from "../lib/vault/storageProtection";
import { generateGiftPassword } from "../lib/gift/giftPassword";
import { offerPasswordToManager } from "../lib/vault/credentialStore";
import {
  clearNeedsSeedBackup,
  clearPendingGiftPassword,
  markGiftClaimed,
  getPendingGiftPassword,
  markNeedsSeedBackup,
  setPendingGiftPassword,
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

type Phase = "preparing" | "needs-unlock" | "claiming" | "ready" | "error";

// The receiving half of a gift link: what someone sees when they open
// spendrr.app/g#… . Built on the same sheet as the sender's composer and as
// tap-to-pay (sheet/PaySheet.tsx), with one thing of its own — the box
// actually opens when the claim lands (GiftReveal.css), and the amount
// counts up out of it.
//
// The claim itself is unchanged: a fresh recipient gets a wallet created
// here, an existing one unlocks, and either way the gift is pulled in the
// background while this screen is already showing what is coming.

// The credential-manager username the auto-generated recipient password is
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
  const [rates, setRates] = useState<Rates | null>(null);
  // Two steps: the gift is pulled into its wallet as soon as a session is open (`prepared`, the part
  // that waits on the network), and only the user's tap on "Přijmout dárek" (`proceeding`) forwards it
  // to their own address. The box opens when that forward has gone through.
  const [prepared, setPrepared] = useState(false);
  const [proceeding, setProceeding] = useState(false);

  const startedFreshRef = useRef(false);
  const prepareStartedRef = useRef(false);
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
  //
  // The cross-tab wallet lock is taken before any vault is looked at, and kept through
  // saving and opening (prepareSession finds it already held): two tabs opening gift links
  // together would otherwise both see no vault and the later write would replace the seed
  // the first tab's wallet was just created from.
  const runFreshOpen = useCallback(async () => {
    if (startedFreshRef.current) return;
    startedFreshRef.current = true;
    setPhase("preparing");
    setErrorMsg(null);
    let opened = false;
    try {
      if (!(await walletTabLock.acquire())) {
        startedFreshRef.current = false;
        setErrorMsg(t("Peněženka je otevřená v jiném okně"));
        setPhase("error");
        return;
      }
      if (hasDeviceVault()) {
        await onOpenDevice();
        opened = true;
        return;
      }
      if (loadVault() !== null) {
        const pw = getPendingGiftPassword();
        if (pw === null) {
          startedFreshRef.current = false;
          setPhase("needs-unlock");
          return;
        }
        await onOpenVault(pw);
        opened = true;
        return;
      }
      const mnemonic = await generateMnemonic();
      if (gift.passwordless) {
        // No password to invent, store or show: the wallet is sealed under this device's own key and the next open
        // asks for a real one (PasswordSetupSheet). Persistence is asked for now, since the key lives in IndexedDB.
        await createDeviceVault(mnemonic);
        void requestPersistentStorage({ force: true });
        await onOpenFresh(mnemonic);
        opened = true;
        return;
      }
      const pw = generateGiftPassword();
      const vault = await encryptMnemonic(mnemonic, pw);
      saveVault(vault);
      // Hold the password in the clear until the dashboard has shown it to
      // the user and they've confirmed saving it — set BEFORE the flaky
      // credential-manager call so a mid-flow tab close still leaves it
      // recoverable.
      setPendingGiftPassword(pw);
      // Best-effort hand-off to the OS password manager. Silently no-ops on
      // desktop Safari/Chrome — the dashboard's "save your password" modal
      // (backed by setPendingGiftPassword above) is the real safety net.
      await offerPasswordToManager(CREDENTIAL_USERNAME, pw);
      await onOpenFresh(mnemonic);
      opened = true;
    } catch (e) {
      startedFreshRef.current = false;
      surfaceError(e, setErrorMsg);
      setPhase("error");
    } finally {
      // Only an open session keeps the lock; every other way out hands it back.
      if (!opened) walletTabLock.release();
    }
  }, [onOpenFresh, onOpenDevice, onOpenVault, gift.passwordless, t]);

  // Fresh recipient: eagerly, the moment the modal shows. The actual gift
  // claim waits for liveWallet in the effect below.
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

  // Shared by both steps. Nothing is forwarded before the pull has finished, so a failure in either leaves the
  // gift where it was and a retry goes again from the same point.
  const failClaim = useCallback(
    async (e: unknown, fresh: boolean) => {
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
        // about backing it up or saving a password for it.
        if (fresh) {
          clearNeedsSeedBackup();
          clearPendingGiftPassword();
        }
      }
      if (msg === GIFT_EMPTY_MESSAGE || msg === GIFT_RETRY_MESSAGE) setErrorMsg(msg);
      else surfaceError(e, setErrorMsg);
      setPhase("error");
    },
    [gift.mnemonic, gift.id],
  );

  const runPrepare = useCallback(
    async (fresh: boolean) => {
      if (prepareStartedRef.current) return;
      prepareStartedRef.current = true;
      setPhase("claiming");
      try {
        await prepareGiftClaim(gift.mnemonic, gift.id);
        setPrepared(true);
      } catch (e) {
        prepareStartedRef.current = false;
        await failClaim(e, fresh);
      }
    },
    [gift.mnemonic, gift.id, failClaim],
  );

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
      } catch (e) {
        claimStartedRef.current = false;
        await failClaim(e, fresh);
      }
    },
    [gift.mnemonic, gift.id, gift.passwordless, failClaim],
  );

  // Once a session is open (fresh or unlocked), pull the gift into its wallet.
  useEffect(() => {
    if (!liveWallet || prepared) return;
    if (phase === "preparing" || phase === "claiming") void runPrepare(freshRecipient);
  }, [liveWallet, phase, prepared, freshRecipient, runPrepare]);

  // Pulled and accepted: forward it.
  useEffect(() => {
    if (!liveWallet || !prepared || !proceeding || phase !== "claiming") return;
    void runClaim(liveWallet, freshRecipient);
  }, [liveWallet, prepared, proceeding, phase, freshRecipient, runClaim]);

  const onPrimary = () => {
    if (phase === "ready") {
      onDone();
      return;
    }
    setProceeding(true);
  };

  const onUnlock = async () => {
    setErrorMsg(null);
    setPhase("claiming");
    // "Odemknout a přijmout" is the acceptance.
    setProceeding(true);
    try {
      await onOpenVault(password);
      // liveWallet will arrive via props; the effect above runs the claim.
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : t("Nesprávné heslo."));
      setProceeding(false);
      setPhase("needs-unlock");
    }
  };

  const rate = rates ? rates[cur] : null;
  const shownSats = claimedSats ?? gift.amountSats;
  const busy = phase === "preparing" || phase === "claiming";
  const opened = phase === "ready";

  let screenKey: string;
  let body;

  if (phase === "needs-unlock") {
    screenKey = "unlock";
    body = (
      <Screen>
        <GiftBox opened={false} />
        <p className="gft-kicker">{t("Dostal jsi dárek")}</p>
        <BigAmount sats={gift.amountSats} rate={rate} currency={cur} fmt={fmt} />
        {gift.message && <GiftNote message={gift.message} />}
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
        {errorMsg && <p className="sht-error">{t(errorMsg)}</p>}
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
        {errorMsg && errorMsg !== GIFT_EMPTY_MESSAGE && <p className="sht-sub">{t(errorMsg)}</p>}
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
                  // Back to the step that failed: the effects start it again.
                  prepareStartedRef.current = false;
                  claimStartedRef.current = false;
                  setPhase("claiming");
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
        <GiftBox opened={opened} />
        <p className="gft-kicker">{opened ? t("Je tvůj!") : t("Dostal jsi dárek")}</p>
        <BigAmount sats={shownSats} rate={rate} currency={cur} fmt={fmt} countUp={opened} />
        {gift.message && <GiftNote message={gift.message} />}
        <button
          type="button"
          className="primary sht-wide"
          onClick={onPrimary}
          disabled={busy && proceeding}
        >
          {opened ? t("Hotovo") : busy && proceeding ? t("Přijímám…") : t("Přijmout dárek")}
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

function GiftNote({ message }: { message: string }) {
  return (
    <div className="gft-note">
      <p className="gft-note-body">{message}</p>
    </div>
  );
}

// The box: sits closed while the claim runs, then the lid lifts off and leans aside when the
// claim actually lands. Pure CSS off the `is-open` class, so it plays exactly once, when the
// money is really there, not on a timer. Engraved like the card motifs: cream lines on ink,
// hatched shading, the ribbon the one accent.
function GiftBox({ opened }: { opened: boolean }) {
  return (
    <div className={`gft-box${opened ? " is-open" : ""}`} aria-hidden="true">
      <svg viewBox="0 0 120 120" className="gft-box-svg">
        <defs>
          <pattern id="gft-hf" width="4" height="4.6" patternUnits="userSpaceOnUse">
            <line x1="0" y1="2.3" x2="4" y2="2.3" stroke="#f2ede4" strokeWidth="0.5" opacity="0.55" />
          </pattern>
          <pattern id="gft-hs" width="3.2" height="3.2" patternUnits="userSpaceOnUse" patternTransform="rotate(55)">
            <line x1="0" y1="0" x2="0" y2="3.2" stroke="#f2ede4" strokeWidth="0.55" opacity="0.8" />
          </pattern>
          <pattern id="gft-ht" width="4" height="3.4" patternUnits="userSpaceOnUse">
            <line x1="0" y1="1.7" x2="4" y2="1.7" stroke="#f2ede4" strokeWidth="0.45" opacity="0.3" />
          </pattern>
        </defs>
        {/* Body: front, side, and the opening the lid uncovers. */}
        <polygon className="gft-ink" points="38,48 106,48 90,56 22,56" />
        <polygon className="gft-edge" points="38,48 106,48 90,56 22,56" />
        <polygon className="gft-fine" points="42,50.4 100,50.4 88,54.4 28,54.4" />
        {/* The coin: the Bitcoin logo (the public-domain mark Bitcoin Core uses), behind the front of the box so it
            comes up out of it when the lid is off. 4091 units across, scaled to the 28 of the coin. */}
        <g className="gft-coin">
          <g className="gft-coin-sway">
            <g transform="translate(42 48) scale(0.006844)">
              <path fill="#f7931a" d="M4030.06 2540.77c-273.24,1096.01 -1383.32,1763.02 -2479.46,1489.71 -1095.68,-273.24 -1762.69,-1383.39 -1489.33,-2479.31 273.12,-1096.13 1383.2,-1763.19 2479,-1489.95 1096.06,273.24 1763.03,1383.51 1489.76,2479.57l0.02 -0.02z" />
              <path fill="#fff" d="M2947.77 1754.38c40.72,-272.26 -166.56,-418.61 -450,-516.24l91.95 -368.8 -224.5 -55.94 -89.51 359.09c-59.02,-14.72 -119.63,-28.59 -179.87,-42.34l90.16 -361.46 -224.36 -55.94 -92 368.68c-48.84,-11.12 -96.81,-22.11 -143.35,-33.69l0.26 -1.16 -309.59 -77.31 -59.72 239.78c0,0 166.56,38.18 163.05,40.53 90.91,22.69 107.35,82.87 104.62,130.57l-104.74 420.15c6.26,1.59 14.38,3.89 23.34,7.49 -7.49,-1.86 -15.46,-3.89 -23.73,-5.87l-146.81 588.57c-11.11,27.62 -39.31,69.07 -102.87,53.33 2.25,3.26 -163.17,-40.72 -163.17,-40.72l-111.46 256.98 292.15 72.83c54.35,13.63 107.61,27.89 160.06,41.3l-92.9 373.03 224.24 55.94 92 -369.07c61.26,16.63 120.71,31.97 178.91,46.43l-91.69 367.33 224.51 55.94 92.89 -372.33c382.82,72.45 670.67,43.24 791.83,-303.02 97.63,-278.78 -4.86,-439.58 -206.26,-544.44 146.69,-33.83 257.18,-130.31 286.64,-329.61l-0.07 -0.05zm-512.93 719.26c-69.38,278.78 -538.76,128.08 -690.94,90.29l123.28 -494.2c152.17,37.99 640.17,113.17 567.67,403.91zm69.43 -723.3c-63.29,253.58 -453.96,124.75 -580.69,93.16l111.77 -448.21c126.73,31.59 534.85,90.55 468.94,355.05l-0.02 0z" />
            </g>
            {/* A thin cream edge, and it rests clear of the ribbon below it. */}
            <circle className="gft-coin-edge" cx="56" cy="62" r="14.3" />
          </g>
        </g>
        <polygon className="gft-ink" points="22,56 90,56 90,104 22,104" />
        <polygon fill="url(#gft-hf)" points="22,56 90,56 90,104 22,104" />
        <polygon className="gft-edge" points="22,56 90,56 90,104 22,104" />
        <polygon className="gft-ink" points="90,56 106,48 106,96 90,104" />
        <polygon fill="url(#gft-hs)" points="90,56 106,48 106,96 90,104" />
        <polygon className="gft-edge" points="90,56 106,48 106,96 90,104" />
        <rect className="gft-ribbon" x="50" y="56" width="12" height="48" />
        {/* Lid, with the bow. */}
        <g className="gft-lid">
          <polygon className="gft-ink" points="18,40 94,40 94,56 18,56" />
          <polygon fill="url(#gft-hf)" points="18,40 94,40 94,56 18,56" />
          <polygon className="gft-edge" points="18,40 94,40 94,56 18,56" />
          <polygon className="gft-ink" points="94,40 110,32 110,48 94,56" />
          <polygon fill="url(#gft-hs)" points="94,40 110,32 110,48 94,56" />
          <polygon className="gft-edge" points="94,40 110,32 110,48 94,56" />
          <polygon className="gft-ink" points="18,40 94,40 110,32 34,32" />
          <polygon fill="url(#gft-ht)" points="18,40 94,40 110,32 34,32" />
          <polygon className="gft-edge" points="18,40 94,40 110,32 34,32" />
          <rect className="gft-ribbon" x="50" y="40" width="12" height="16" />
          <polygon className="gft-ribbon" points="50,40 62,40 78,32 66,32" />
          <path className="gft-ribbon" d="M66 31C58 12 38 18 52 31Z" />
          <path className="gft-ribbon" d="M66 31C74 12 94 18 80 31Z" />
          <path className="gft-fine" d="M64 29C58 20 48 22 54 29M68 29C74 20 84 22 78 29" />
          <ellipse className="gft-ribbon" cx="66" cy="31.5" rx="4.2" ry="3" />
        </g>
      </svg>
    </div>
  );
}
