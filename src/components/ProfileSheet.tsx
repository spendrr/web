import { useEffect, useState } from "react";
import Avatar from "./Avatar";
import { BooleanSwitch } from "./BooleanSwitch";
import { Screen, Sheet, useSheetClose } from "./sheet/PaySheet";
import { ShareLinkResult, useCopyLink } from "./sheet/ShareLink";
import type { WalletClient } from "../lib/wallet/bark";
import { NAME_DOMAIN, checkHandle, handleUrl, suggestHandle, type HandleProblem } from "../lib/names/handle";
import { useT } from "../lib/i18n";
import { fetchMyName, lookupName, releaseMyName, saveName, setMyLnAddress, type NameError } from "../lib/names/names";
import { getCachedName, setCachedName, setHasHandle } from "../lib/names/nameTouch";
import { invalidateChatNameBinding } from "../lib/chat/chatClient";
import { reportError } from "../lib/appErrors";
import "./ProfileSheet.css";

// "Profil": the user's public @handle, an abstract avatar drawn from their
// address, and a QR that points at spendrr.app/@handle.
//
// The registry (worker/names.ts) is the source of truth, not this component:
// on open it asks the server which name, if any, this wallet's mailbox owns,
// and every change goes back through the same mailbox proof. It
// first shows the last name it saw (nameTouch.ts's getCachedName) and skips
// the server entirely: the proof queues behind the wallet worker's post-unlock
// work, so right after a reload the question alone took tens of seconds.
// "Zkusit znovu" and every change still go to the server. A failed read is
// its own state and is never treated as "no name", so a network blip can't
// offer a second registration on top of a real one.
//
// Nothing is registered without a tap. The suggested name (anonymous-pea and
// friends, derived from the address) is only a proposal until "Zaregistrovat".

type Mine =
  | { state: "loading" }
  | { state: "error" }
  | { state: "none" }
  | { state: "registered"; name: string; address: string; lnAddress: boolean };

type Phase = "profile" | "edit" | "release";

// How many suggestions to try before giving up on an auto-registration: the
// bare "anonymous-pea" is common, so the first few can already be taken.
const SUGGESTION_ATTEMPTS = 6;

function problemText(problem: HandleProblem, t: (cs: string) => string): string {
  switch (problem) {
    case "empty":
      return t("Napiš jméno.");
    case "too-short":
      return t("Jméno má mít aspoň 3 znaky.");
    case "too-long":
      return t("Jméno může mít nejvýš 20 znaků.");
    case "chars":
      return t("Použij jen malá písmena bez diakritiky, čísla, _ a -.");
    case "edge":
      return t("Jméno nesmí začínat ani končit znakem _ nebo -.");
    case "reserved":
      return t("Tohle jméno je vyhrazené.");
  }
}

function errorText(error: NameError, t: (cs: string) => string): string {
  switch (error) {
    case "taken":
      return t("Tohle jméno už má někdo jiný.");
    case "quarantined":
      return t("Tohle jméno se teď nedá použít. Zkus jiné.");
    case "rate-limited":
      return t("Jméno jsi měnil/a příliš často. Zkus to později, limit je 5 změn za 30 dní.");
    case "throttled":
      return t("Moc požadavků najednou. Zkus to za chvíli.");
    case "invalid":
      return t("Neplatné jméno.");
    case "reserved":
      return t("Tohle jméno je vyhrazené.");
    case "bad-address":
      return t("Adresa peněženky není platná.");
    case "banned":
      return t("Tahle peněženka nemůže registrovat jména.");
    case "clock":
      return t("Čas na tomhle zařízení se liší od skutečného. Zapni v nastavení telefonu automatický čas a zkus to znovu.");
    case "auth":
      return t("Server neuznal ověření peněženky. Zkus to za chvíli znovu.");
    case "network":
      return t("Server nedostupný");
  }
}

// What the live check in the edit screen knows about the typed name.
type Availability =
  | { query: string; state: "free" | "yours" | "taken" | "quarantined" | "reserved" | "invalid" | "unknown" }
  | null;

export default function ProfileSheet({
  wallet,
  address,
  onClose,
}: {
  wallet: WalletClient;
  address: string | null;
  onClose: () => void;
}) {
  const t = useT();
  const { closing, closeThen } = useSheetClose();
  const close = () => closeThen(onClose);

  const [phase, setPhase] = useState<Phase>("profile");
  const [mine, setMine] = useState<Mine>(() => {
    const cached = address ? getCachedName(address) : null;
    return cached ? { state: "registered", ...cached } : { state: "loading" };
  });
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [touched, setTouched] = useState(false);
  const [availability, setAvailability] = useState<Availability>(null);
  // Turning the Lightning address on asks first (it puts a service in the
  // payment path); turning it off does not.
  const [lnConfirm, setLnConfirm] = useState(false);

  useEffect(() => {
    if (!address) return;
    if (attempt === 0) {
      const cached = getCachedName(address);
      if (cached) {
        setMine({ state: "registered", ...cached });
        return;
      }
    }
    let cancelled = false;
    fetchMyName(wallet)
      .then((result) => {
        if (cancelled) return;
        setHasHandle(result !== null);
        setMine(
          result
            ? { state: "registered", name: result.name, address: result.address, lnAddress: result.lnAddress }
            : { state: "none" },
        );
      })
      .catch(() => {
        if (!cancelled) setMine({ state: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [wallet, address, attempt]);

  // Every answer the server gives (the read above and each change below ends
  // in setMine) is the new cached state; a loading or failed read says nothing.
  useEffect(() => {
    if (!address) return;
    if (mine.state === "registered") {
      setCachedName(address, { name: mine.name, address: mine.address, lnAddress: mine.lnAddress });
    } else if (mine.state === "none") {
      setCachedName(address, null);
    }
  }, [mine, address]);

  // A reserved name is not turned away here: a mailbox the Worker names as its
  // owner may register it, and the server is the one that knows.
  const check = checkHandle(input, { allowReserved: true });
  const typed = check.ok ? check.handle : null;

  // Live "is it free?" for the edit screen, debounced. Keyed by the name it
  // was asked about, so an answer for an earlier keystroke is never shown.
  useEffect(() => {
    if (phase !== "edit" || typed === null) return;
    let cancelled = false;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      const result = await lookupName(typed, controller.signal);
      if (cancelled) return;
      if (result.kind === "found") {
        const own = mine.state === "registered" && mine.name === result.name;
        setAvailability({ query: typed, state: own ? "yours" : "taken" });
      } else if (result.kind === "absent") {
        setAvailability({ query: typed, state: result.status });
      } else {
        setAvailability({ query: typed, state: "unknown" });
      }
    }, 350);
    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [phase, typed, mine]);

  const currentAvailability = availability && availability.query === typed ? availability.state : null;

  // Mirrors worker/names.ts's SetResult: only address-updated/unchanged leave
  // lnAddress as it was; a fresh claim or a rename always starts it off.
  const lnAddressAfterSave = (action: string, previous: boolean): boolean =>
    action === "address-updated" || action === "unchanged" ? previous : false;

  const registerSuggestion = async () => {
    if (!address || busy) return;
    setBusy(true);
    setMessage(null);
    for (let i = 0; i < SUGGESTION_ATTEMPTS; i++) {
      const result = await saveName(wallet, suggestHandle(address, i), address);
      if (result.ok) {
        setHasHandle(true);
        invalidateChatNameBinding();
        setMine({ state: "registered", name: result.name, address: result.address, lnAddress: false });
        setBusy(false);
        return;
      }
      if (result.error !== "taken" && result.error !== "quarantined") {
        fail(result.error);
        setBusy(false);
        return;
      }
    }
    setMessage(t("Nepodařilo se najít volné jméno. Zvol si vlastní."));
    setBusy(false);
  };

  const saveTyped = async () => {
    setTouched(true);
    if (!address || busy || !check.ok) return;
    setBusy(true);
    setMessage(null);
    const previousLnAddress = mine.state === "registered" ? mine.lnAddress : false;
    const result = await saveName(wallet, check.handle, address);
    setBusy(false);
    if (!result.ok) {
      fail(result.error);
      return;
    }
    setHasHandle(true);
    invalidateChatNameBinding();
    setMine({
      state: "registered",
      name: result.name,
      address: result.address,
      lnAddress: lnAddressAfterSave(result.action, previousLnAddress),
    });
    setPhase("profile");
  };

  const fixAddress = async () => {
    if (!address || busy || mine.state !== "registered") return;
    setBusy(true);
    setMessage(null);
    const previousLnAddress = mine.lnAddress;
    const result = await saveName(wallet, mine.name, address);
    setBusy(false);
    if (!result.ok) {
      fail(result.error);
      return;
    }
    setMine({
      state: "registered",
      name: result.name,
      address: result.address,
      lnAddress: lnAddressAfterSave(result.action, previousLnAddress),
    });
  };

  const toggleLnAddress = async (enabled: boolean) => {
    if (busy || mine.state !== "registered") return;
    setBusy(true);
    setMessage(null);
    const result = await setMyLnAddress(wallet, enabled);
    setBusy(false);
    if (!result.ok) {
      fail(result.error);
      return;
    }
    setMine({ ...mine, lnAddress: result.lnAddress });
    setLnConfirm(false);
  };

  const release = async () => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    const result = await releaseMyName(wallet);
    setBusy(false);
    if (!result.ok) {
      fail(result.error);
      return;
    }
    setHasHandle(false);
    invalidateChatNameBinding();
    setMine({ state: "none" });
    setPhase("profile");
  };

  const avatarSeed = mine.state === "registered" ? mine.address : (address ?? "");
  const lnAddressText = mine.state === "registered" ? `${mine.name}@${NAME_DOMAIN}` : null;
  const { copied: lnCopied, copy: copyLnAddress } = useCopyLink(lnAddressText);
  // The standalone page where anyone picks an amount and gets an invoice (spendrr.app/tip/<name>).
  const { copied: tipCopied, copy: copyTipLink } = useCopyLink(
    mine.state === "registered" && mine.lnAddress ? `${window.location.origin}/tip/${mine.name}` : null,
  );

  // A connection or server failure is not about anything on this screen, so it
  // goes to the island; the inline slot stays for errors about the typed name.
  // Without a Dashboard to show it, it stays inline.
  const fail = (error: NameError) => {
    if (error === "network" && reportError(new Error(errorText(error, (cs) => cs)))) {
      setMessage(null);
      return;
    }
    setMessage(errorText(error, t));
  };

  const startEdit = () => {
    if (mine.state !== "registered") return;
    setInput(`@${mine.name}`);
    setTouched(false);
    setMessage(null);
    setAvailability(null);
    setPhase("edit");
  };

  let body;
  let screenKey: string = phase;
  if (!address) {
    screenKey = "no-address";
    body = (
      <Screen>
        <h2 className="sht-title">{t("Profil")}</h2>
        <p className="sht-sub">{t("Zatím nemáme tvoji adresu. Zkus to za chvíli znovu.")}</p>
        <button type="button" className="secondary sht-wide" onClick={close}>
          {t("Zavřít")}
        </button>
      </Screen>
    );
  } else if (phase === "release") {
    body = (
      <Screen>
        <h2 className="sht-title">{t("Odebrat jméno?")}</h2>
        <p className="sht-sub">
          {t("Lidé ti přes @jméno přestanou moct platit. Jméno se 30 dní nikomu jinému nepřidělí a ty si ho můžeš vzít zpět.")}
        </p>
        {message && <p className="sht-error">{message}</p>}
        <div className="sht-actions">
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => {
              setMessage(null);
              setPhase("profile");
            }}
          >
            {t("Zrušit")}
          </button>
          <button type="button" className="primary" disabled={busy} onClick={() => void release()}>
            {busy ? t("Odebírám…") : t("Odebrat jméno")}
          </button>
        </div>
      </Screen>
    );
  } else if (phase === "edit") {
    const showProblem = touched && !check.ok;
    const status =
      currentAvailability === "free"
        ? t("Jméno je volné.")
        : currentAvailability === "yours"
          ? t("Tohle jméno už máš.")
          : currentAvailability === "taken"
            ? t("Tohle jméno už má někdo jiný.")
            : currentAvailability === "quarantined"
              ? t("Tohle jméno se teď nedá použít.")
              : currentAvailability === "reserved"
                ? t("Vyhrazené jméno. Uložit ho jde jen jeho majiteli.")
                : currentAvailability === "unknown"
                  ? t("Dostupnost neověřena")
                  : null;
    const statusBad =
      currentAvailability === "taken" || currentAvailability === "quarantined";
    body = (
      <Screen>
        <h2 className="sht-title">{t("Změnit jméno")}</h2>
        <input
          className="sht-field"
          value={input}
          placeholder="@jmeno"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          maxLength={40}
          aria-invalid={showProblem}
          onChange={(e) => {
            setInput(e.target.value);
            setTouched(true);
            setMessage(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") void saveTyped();
          }}
        />
        {showProblem && !check.ok ? (
          <p className="sht-error">{problemText(check.problem, t)}</p>
        ) : status ? (
          <p className={statusBad ? "sht-error" : "sht-sub"}>{status}</p>
        ) : (
          <p className="sht-sub">{t("3 až 20 znaků: malá písmena, čísla, _ a -. Bez diakritiky.")}</p>
        )}
        {message && <p className="sht-error">{message}</p>}
        <p className="sht-sub">
          {t("Jméno je veřejné. Staré jméno se 30 dní nikomu jinému nepřidělí a platby na něj přestanou fungovat.")}
        </p>
        <div className="sht-actions">
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => {
              setMessage(null);
              setPhase("profile");
            }}
          >
            {t("Zrušit")}
          </button>
          <button type="button" className="primary" disabled={busy} onClick={() => void saveTyped()}>
            {busy ? t("Ukládám…") : t("Uložit jméno")}
          </button>
        </div>
        {mine.state === "registered" && (
          <button
            type="button"
            className="sht-link"
            disabled={busy}
            onClick={() => {
              setMessage(null);
              setPhase("release");
            }}
          >
            {t("Odebrat jméno")}
          </button>
        )}
      </Screen>
    );
  } else if (mine.state === "loading") {
    screenKey = "loading";
    body = (
      <Screen>
        <div className="prf-head">
          <Avatar seed={avatarSeed} size={88} />
          <p className="sht-sub">{t("Načítám…")}</p>
        </div>
      </Screen>
    );
  } else if (mine.state === "error") {
    screenKey = "error";
    body = (
      <Screen>
        <div className="prf-head">
          <Avatar seed={avatarSeed} size={88} />
          <h2 className="sht-title prf-handle">{t("Profil")}</h2>
        </div>
        <p className="sht-sub">{t("Jméno se nepodařilo načíst. Zkontroluj připojení a zkus to znovu.")}</p>
        <div className="sht-actions">
          <button type="button" className="secondary" onClick={close}>
            {t("Zavřít")}
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => {
              setMine({ state: "loading" });
              setAttempt((n) => n + 1);
            }}
          >
            {t("Zkusit znovu")}
          </button>
        </div>
      </Screen>
    );
  } else if (mine.state === "none") {
    screenKey = "none";
    const suggestion = suggestHandle(address);
    body = (
      <Screen>
        <div className="prf-head">
          <Avatar seed={avatarSeed} size={88} />
          <h2 className="sht-title prf-handle">{t("Zatím nemáš jméno")}</h2>
        </div>
        <p className="sht-sub">
          {t("S veřejným @jménem ti kdokoli ve Spendrru pošle platbu, aniž by potřeboval tvoji adresu.")}
        </p>
        {message && <p className="sht-error">{message}</p>}
        <button type="button" className="primary sht-wide" disabled={busy} onClick={() => void registerSuggestion()}>
          {busy ? t("Registruji…") : `${t("Zaregistrovat")} @${suggestion}`}
        </button>
        <button
          type="button"
          className="secondary sht-wide"
          disabled={busy}
          onClick={() => {
            setInput("");
            setTouched(false);
            setMessage(null);
            setAvailability(null);
            setPhase("edit");
          }}
        >
          {t("Vybrat vlastní jméno")}
        </button>
        <button type="button" className="secondary sht-wide" onClick={close}>
          {t("Zavřít")}
        </button>
      </Screen>
    );
  } else {
    screenKey = "registered";
    const registered = mine;
    // Asking before the Lightning address goes on: the question and its two
    // buttons take the place of the QR, so they are never below the fold of a
    // phone-sized sheet, and no switch claims "on" before the server says so.
    const confirming = lnConfirm && !registered.lnAddress;
    body = (
      <Screen>
        <div className="prf-body">
          <button type="button" className="prf-close" onClick={close} aria-label={t("Zavřít")}>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
          {/* One address in two spellings: the full "pavel@spendrr.app" is what
              is shown, "@pavel" is the short way to type it in Spendrr. The
              domain is muted and dashed while the Lightning address is off,
              because until then the full form only works from Spendrr; tapping
              it offers to turn it on, and once on, tapping copies it. */}
          <div className="prf-head">
            <Avatar seed={avatarSeed} size={88} />
            <div className="prf-addr-card">
              <h2 className="sht-title prf-handle prf-address">
                <button
                  type="button"
                  className={`prf-address-btn${registered.lnAddress ? " is-on" : ""}`}
                  disabled={busy}
                  title={registered.lnAddress ? t("Kopírovat") : t("Zapnout Lightning adresu")}
                  onClick={() => (registered.lnAddress ? copyLnAddress() : setLnConfirm(true))}
                >
                  {registered.name}
                  <span className="prf-address-domain">@{NAME_DOMAIN}</span>
                </button>
              </h2>
              <p className="sht-sub prf-address-hint">
                {registered.lnAddress && lnCopied ? (
                  t("Zkopírováno")
                ) : (
                  <>
                    {t("Ve Spendrru stačí napsat")} <strong>@{registered.name}</strong>
                  </>
                )}
              </p>
            </div>
          </div>
          {registered.address !== address && (
            <p className="prf-preview">
              {t("Jméno ukazuje na jinou adresu, než má tahle peněženka. Lidé by ti platili jinam.")}{" "}
              <button type="button" className="link-btn" disabled={busy} onClick={() => void fixAddress()}>
                {t("Opravit adresu")}
              </button>
            </p>
          )}
          {message && <p className="sht-error">{message}</p>}
          {!confirming && (
            <>
          <ShareLinkResult
            link={handleUrl(window.location.origin, registered.name)}
            shareText={
              registered.lnAddress
                ? `${t("Pošli mi bitcoin na")} ${registered.name}@${NAME_DOMAIN} (${t("ve Spendrru stačí")} @${registered.name})`
                : t("Pošli mi bitcoin ve Spendrru")
            }
            qrSize={232}
            compact
            hideLink
          />
          <p className="prf-quiet">
            <button type="button" onClick={startEdit}>
              {t("Změnit jméno")}
            </button>
            {registered.lnAddress && (
              <>
                <span aria-hidden="true">·</span>
                <button type="button" onClick={copyTipLink}>
                  {tipCopied ? t("Zkopírováno") : t("Zkopírovat donate odkaz")}
                </button>
              </>
            )}
          </p>
            </>
          )}
          <div className={`prf-ln${confirming ? " is-confirming" : ""}`}>
            {!confirming && (
              <div className="boolean-switch-row">
                <span className="boolean-switch-copy">{t("Lightning adresa")}</span>
                <BooleanSwitch
                  checked={registered.lnAddress}
                  disabled={busy}
                  onChange={(v) => (v ? setLnConfirm(true) : void toggleLnAddress(false))}
                  label={t("Lightning adresa")}
                />
              </div>
            )}
            {confirming ? (
              <div className="prf-ln-confirm">
                <p className="prf-ln-ask">{t("Zapnout Lightning adresu?")}</p>
                <p className="sht-sub prf-ln-note">{t("Platby procházejí službou Spendrr. Vidí výši, utratit je nemůže.")}</p>
                <div className="sht-actions">
                  <button type="button" className="secondary" disabled={busy} onClick={() => setLnConfirm(false)}>
                    {t("Teď ne")}
                  </button>
                  <button type="button" className="primary" disabled={busy} onClick={() => void toggleLnAddress(true)}>
                    {t("Zapnout")}
                  </button>
                </div>
              </div>
            ) : (
              !registered.lnAddress && (
                <p className="sht-sub prf-ln-note">{t("Aby ti mohl poslat bitcoin kdokoli, i bez Spendrru.")}</p>
              )
            )}
          </div>
        </div>
      </Screen>
    );
  }

  return (
    <Sheet closing={closing} onBackdrop={phase === "profile" ? close : undefined} screenKey={screenKey}>
      {body}
    </Sheet>
  );
}
