import { useCallback, useEffect, useRef, useState } from "react";
import { scanGiftStatus, type WalletClient } from "../lib/wallet/bark";
import {
  decryptGiftMnemonic,
  listGifts,
  readGiftScanCache,
  writeGiftScanCache,
  type OutgoingGift,
} from "../lib/gift/giftStore";
import { buildGiftUrl } from "../lib/gift/giftLink";
import { emptyMeansGone, reclaimGift } from "../lib/gift/giftReclaim";
import {
  canTakeBackScan,
  isDone,
  isLookable,
  scanExpiry,
  scanIds,
  scanStatus,
  type GiftScanEntry,
} from "../lib/gift/giftScan";
import { isOffline } from "../lib/connectivity/connectivity";
import { useT } from "../lib/i18n";
import { surfaceError } from "../lib/appErrors";
import { TIMEOUT_MESSAGE, withTimeout } from "../lib/wallet/walletCall";
import { ErrorCircleIcon } from "./BannerIcons";
import SentGiftsView, { type GiftRowData } from "./SentGiftsView";

const LIST_TIMEOUT_MS = 8_000;

// The sent-gifts list. The status of a waiting gift comes from the recovery scan of a
// fresh throwaway wallet (giftScan.ts), which answers definitely and in about a second, so the list looks at
// the newest gifts by itself, one at a time, and has no "Ověřit" buttons. A look that fails changes nothing.
export default function SentGiftsList({
  wallet,
  encryptionKey,
}: {
  wallet: WalletClient;
  encryptionKey: CryptoKey | null;
}) {
  const t = useT();
  const [gifts, setGifts] = useState<OutgoingGift[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [cache, setCache] = useState<Record<string, GiftScanEntry>>(() => readGiftScanCache());
  const [queued, setQueued] = useState<string[]>([]);
  const [looking, setLooking] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const queueRef = useRef<string[]>([]);
  const runningRef = useRef(false);
  const giftsRef = useRef<OutgoingGift[]>([]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const reload = useCallback(() => {
    setLoadFailed(false);
    withTimeout(listGifts(), LIST_TIMEOUT_MS, TIMEOUT_MESSAGE)
      .then((list) => {
        if (!alive.current) return;
        giftsRef.current = list;
        setGifts(list);
      })
      .catch(() => {
        if (alive.current) setLoadFailed(true);
      });
  }, []);
  useEffect(() => reload(), [reload]);

  const pump = useCallback(async () => {
    if (runningRef.current || !encryptionKey) return;
    runningRef.current = true;
    try {
      while (alive.current && queueRef.current.length > 0) {
        const id = queueRef.current.shift() as string;
        const g = giftsRef.current.find((x) => x.id === id);
        setQueued([...queueRef.current]);
        if (!g || !isLookable(g) || isOffline()) continue;
        setLooking(id);
        try {
          const mnemonic = await decryptGiftMnemonic(encryptionKey, g.mnemonicCipher);
          const result = await scanGiftStatus(mnemonic, g.id);
          if (!alive.current) return;
          if (result !== "unknown") {
            const entry: GiftScanEntry = { hint: result, at: Date.now() };
            writeGiftScanCache(
              giftsRef.current.filter(isLookable).map((x) => x.id),
              { [id]: entry },
            );
            setCache((prev) => ({ ...prev, [id]: entry }));
          }
        } catch {
          // Not checked: whatever was remembered stays.
        }
        setLooking(null);
      }
    } finally {
      runningRef.current = false;
      if (alive.current) setLooking(null);
    }
  }, [encryptionKey]);

  // Once per opening of the list, when the gifts are in.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (!gifts || !encryptionKey || autoStarted.current) return;
    autoStarted.current = true;
    writeGiftScanCache(gifts.filter(isLookable).map((g) => g.id));
    const pruned = readGiftScanCache();
    setCache(pruned);
    const ids = scanIds(gifts, pruned, Date.now());
    if (ids.length === 0) return;
    queueRef.current = ids;
    setQueued([...ids]);
    void pump();
  }, [gifts, encryptionKey, pump]);

  const takeBack = async (id: string) => {
    const g = giftsRef.current.find((x) => x.id === id);
    if (!g || !encryptionKey) return;
    setBusyId(id);
    setError(null);
    try {
      const outcome = await reclaimGift(wallet, encryptionKey, g, { terminalWhenEmpty: emptyMeansGone(g) });
      if (outcome === "already-claimed") {
        setError(
          g.state === "creating"
            ? t("V tomhle nedokončeném dárku nic nezůstalo. Platba se nejspíš nikdy neodeslala.")
            : t("Tento dárek už byl mezitím vyzvednut."),
        );
      }
      reload();
    } catch (e) {
      surfaceError(e, setError);
    } finally {
      setBusyId(null);
    }
  };

  const copyLink = async (id: string) => {
    const g = giftsRef.current.find((x) => x.id === id);
    if (!g || !encryptionKey) return;
    try {
      const mnemonic = await decryptGiftMnemonic(encryptionKey, g.mnemonicCipher);
      const url = buildGiftUrl(window.location.origin, {
        mnemonic,
        amountSats: g.amountSats,
        message: g.message,
        id: g.id,
      });
      await navigator.clipboard.writeText(url);
    } catch {
      setError(t("Kopírování selhalo."));
    }
  };

  if (loadFailed) {
    return (
      <div className="settings-body">
        <div className="banner banner-danger">
          <ErrorCircleIcon />
          <span>{t("Dárky se nepodařilo načíst.")}</span>
        </div>
        <button className="secondary small" onClick={reload}>
          {t("Zkusit znovu")}
        </button>
      </div>
    );
  }
  if (gifts === null) return <div className="settings-body" />;

  const now = Date.now();
  const rows: GiftRowData[] = gifts.map((g) => {
    const status = scanStatus(g, cache[g.id]);
    return {
      id: g.id,
      amountSats: g.amountSats,
      createdAt: g.createdAt,
      status,
      expiry: scanExpiry(g, status, now),
      canTakeBack: !!encryptionKey && canTakeBackScan(g, status),
      canCopy: !!encryptionKey && !isDone(status) && status !== "creating",
      looking: looking === g.id,
      busy: busyId === g.id,
    };
  });

  return (
    <div className="settings-body">
      {!encryptionKey && (
        <p className="muted">{t("Zálohy jsou pro tuto relaci nedostupné. Správu dárků nelze zobrazit.")}</p>
      )}
      {error && (
        <div className="banner banner-danger">
          <ErrorCircleIcon />
          <span>{error}</span>
        </div>
      )}
      {gifts.length === 0 && <p className="muted">{t("Zatím jsi žádný dárkový odkaz nevytvořil.")}</p>}
      <SentGiftsView
        rows={rows}
        checking={looking !== null || queued.length > 0}
        onTakeBack={(id) => void takeBack(id)}
        onCopy={(id) => void copyLink(id)}
      />
    </div>
  );
}
