// Settings → Záznamník ťuknutí: collects labelled raw sensor recordings for
// tuning tap-to-pay's detector (see src/lib/bump/bumpRecorder.ts).
import { useCallback, useEffect, useRef, useState } from "react";
import { useT, tf } from "../lib/i18n";
import {
  BumpRecorder,
  loadRecorderPrefs,
  MAX_SESSION_MS,
  RECORDER_GESTURES,
  requestRecorderPermissions,
  saveRecorderPrefs,
  type GestureId,
  type RecorderPrefs,
  type RecorderStats,
} from "../lib/bump/bumpRecorder";
import { ErrorCircleIcon } from "./BannerIcons";
import "./BumpRecorderPage.css";

// This phone's own history, so the person can see which gestures still
// need recordings. Local only.
const HISTORY_KEY = "btc-wallet-bump-rec-history";

interface HistoryEntry {
  sessionId: string;
  gesture: GestureId;
  at: number;
  hard: number;
  soft: number;
  count: number | null;
  uploaded: boolean;
}

function loadHistory(): HistoryEntry[] {
  try {
    const raw = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]") as HistoryEntry[];
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function saveHistory(entries: HistoryEntry[]): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(entries.slice(-200)));
  } catch {
    // Best-effort only.
  }
}

type Phase = "setup" | "recording" | "finishing" | "done";

export default function BumpRecorderPage() {
  const t = useT();
  const [prefs, setPrefs] = useState<RecorderPrefs>(loadRecorderPrefs);
  const [gesture, setGesture] = useState<GestureId>("tap-side");
  const [note, setNote] = useState("");
  const [phase, setPhase] = useState<Phase>("setup");
  const [stats, setStats] = useState<RecorderStats | null>(null);
  const [permError, setPermError] = useState<string | null>(null);
  const [count, setCount] = useState("");
  const [countSaved, setCountSaved] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const [history, setHistory] = useState<HistoryEntry[]>(loadHistory);
  const [flash, setFlash] = useState<"hard" | "soft" | null>(null);
  const recorderRef = useRef<BumpRecorder | null>(null);
  const lastHitRef = useRef<number | null>(null);

  const selected = RECORDER_GESTURES.find((g) => g.id === gesture)!;

  const updatePrefs = (next: RecorderPrefs) => {
    setPrefs(next);
    saveRecorderPrefs(next);
  };

  const onStats = useCallback((s: RecorderStats) => {
    setStats(s);
    if (s.lastHit && s.lastHit.t !== lastHitRef.current) {
      lastHitRef.current = s.lastHit.t;
      setFlash(s.lastHit.strength);
    }
  }, []);

  useEffect(() => {
    if (!flash) return;
    const id = setTimeout(() => setFlash(null), 350);
    return () => clearTimeout(id);
  }, [flash]);

  const finish = useCallback(async () => {
    const rec = recorderRef.current;
    if (!rec) return;
    setPhase("finishing");
    await rec.stop();
    setPhase("done");
  }, []);

  // Leaving the page mid-recording still uploads what was captured.
  useEffect(
    () => () => {
      void recorderRef.current?.stop();
    },
    [],
  );

  const start = useCallback(async () => {
    setPermError(null);
    const perms = await requestRecorderPermissions();
    if (!perms.motion) {
      setPermError(t("Přístup k pohybovým senzorům byl zamítnut. Povol ho v nastavení prohlížeče a zkus to znovu."));
      return;
    }
    const rec = new BumpRecorder({ gesture, note: note.trim(), prefs }, onStats, () => setPhase("done"));
    recorderRef.current = rec;
    lastHitRef.current = null;
    setCount("");
    setCountSaved("idle");
    setStats(null);
    setPhase("recording");
    await rec.start();
  }, [gesture, note, prefs, onStats, t]);

  // Record the finished session in the local history once, when it ends.
  const recordedRef = useRef<string | null>(null);
  useEffect(() => {
    const rec = recorderRef.current;
    if (phase !== "done" || !rec || !stats || recordedRef.current === rec.sessionId) return;
    recordedRef.current = rec.sessionId;
    const entry: HistoryEntry = {
      sessionId: rec.sessionId,
      gesture,
      at: Date.now(),
      hard: stats.hard,
      soft: stats.soft,
      count: null,
      uploaded: stats.chunksPending === 0 && stats.uploadError === null,
    };
    setHistory((h) => {
      const next = [...h, entry];
      saveHistory(next);
      return next;
    });
  }, [phase, stats, gesture]);

  const saveCount = useCallback(async () => {
    const rec = recorderRef.current;
    const n = Number(count);
    if (!rec || !Number.isInteger(n) || n < 0 || n > 500) return;
    setCountSaved("saving");
    const ok = await rec.saveCount(n);
    setCountSaved(ok ? "saved" : "failed");
    if (ok) {
      setHistory((h) => {
        const next = h.map((e) => (e.sessionId === rec.sessionId ? { ...e, count: n } : e));
        saveHistory(next);
        return next;
      });
    }
  }, [count]);

  const perGesture = (id: GestureId) => history.filter((h) => h.gesture === id).length;

  if (phase === "recording" || phase === "finishing") {
    const s = stats;
    const elapsed = s ? Math.floor(s.elapsedMs / 1000) : 0;
    const progress = s ? Math.min(1, s.elapsedMs / MAX_SESSION_MS) : 0;
    const level = s ? Math.min(1, s.level / 20) : 0;
    return (
      <div className="settings-body rec-live">
        <div className={`rec-hero${flash ? ` rec-hero--${flash}` : ""}`}>
          <div className="rec-dot" aria-hidden />
          <div className="rec-gesture">{t(selected.label)}</div>
          <div className="rec-timer">
            {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}
          </div>
          <div className="rec-progress" aria-hidden>
            <div style={{ transform: `scaleX(${progress})` }} />
          </div>
          <div className="rec-meter" aria-hidden>
            <div style={{ transform: `scaleX(${level})` }} />
          </div>
          <div className="rec-counts">
            <span>
              <b>{s?.hard ?? 0}</b> {t("silných")}
            </span>
            <span>
              <b>{s?.soft ?? 0}</b> {t("slabých")}
            </span>
          </div>
          <p className="muted small rec-hint">
            {t(
              selected.positive
                ? "Ťukej v klidném tempu, mezi ťuknutími vždy aspoň vteřinu počkej."
                : "Opakuj pohyb v klidném tempu, klidně i víckrát za sebou.",
            )}
          </p>
        </div>

        <div className="settings-group rec-sensors">
          <SensorRow label={t("Vzorkování")} value={s ? `${s.sampleHz} Hz` : "…"} ok={s ? s.sampleHz >= 30 : null} />
          <SensorRow label={t("Zrychlení bez gravitace")} value={okLabel(t, s?.hasLinear ?? null)} ok={s?.hasLinear ?? null} />
          <SensorRow label={t("Gyroskop")} value={okLabel(t, s?.hasRotation ?? null)} ok={s?.hasRotation ?? null} />
          <SensorRow label={t("Kompas")} value={okLabel(t, s ? s.hasCompass : null)} ok={s ? s.hasCompass : null} />
          <SensorRow
            label={t("Odesláno")}
            value={s ? tf(t("{sent} částí, {pending} čeká"), { sent: s.chunksSent, pending: s.chunksPending }) : "…"}
            ok={s ? s.uploadError === null : null}
          />
        </div>
        {s?.uploadError && <p className="error small">{s.uploadError}</p>}

        <button className="rec-stop" onClick={() => void finish()} disabled={phase === "finishing"}>
          {phase === "finishing" ? t("Odesílám…") : t("Hotovo")}
        </button>
      </div>
    );
  }

  if (phase === "done") {
    const s = stats;
    const allSent = s !== null && s.chunksPending === 0 && s.uploadError === null;
    return (
      <div className="settings-body">
        <div className="settings-group rec-done">
          <div className={`rec-done-mark${allSent ? "" : " rec-done-mark--warn"}`} aria-hidden>
            {allSent ? "✓" : "!"}
          </div>
          <div className="rec-done-title">{allSent ? t("Záznam odeslán") : t("Část záznamu se nepodařilo odeslat")}</div>
          <p className="muted small">
            {tf(t("{gesture}: detektor zachytil {hard} silných a {soft} slabých."), {
              gesture: t(selected.label),
              hard: s?.hard ?? 0,
              soft: s?.soft ?? 0,
            })}
          </p>
          {s?.uploadError && <p className="error small">{s.uploadError}</p>}
        </div>

        <div className="settings-group rec-count">
          <div className="settings-label">{t("Kolikrát jsi to doopravdy udělal?")}</div>
          <p className="muted small rec-pad">
            {t("Nejcennější údaj: podle něj poznám, kolik skutečných ťuknutí detektor minul nebo si přimyslel.")}
          </p>
          <div className="rec-count-row">
            <input
              type="number"
              inputMode="numeric"
              min={0}
              max={500}
              placeholder="12"
              value={count}
              onChange={(e) => {
                setCount(e.target.value);
                setCountSaved("idle");
              }}
            />
            <button disabled={count === "" || countSaved === "saving" || countSaved === "saved"} onClick={() => void saveCount()}>
              {countSaved === "saved" ? t("Uloženo") : countSaved === "saving" ? t("Ukládám…") : t("Uložit")}
            </button>
          </div>
          {countSaved === "failed" && <p className="error small rec-pad">{t("Nepodařilo se uložit, zkus to znovu.")}</p>}
        </div>

        <button onClick={() => setPhase("setup")}>{t("Nahrát další")}</button>
      </div>
    );
  }

  return (
    <div className="settings-body">
      <p className="settings-intro">
        {t(
          "Pomoz naladit rozpoznávání ťuknutí. Záznamník nahrává jen data z pohybových senzorů, nic z peněženky. Nahrávej vždy na obou telefonech současně.",
        )}
      </p>

      <div className="settings-group rec-form">
        <div className="settings-label">{t("Tento telefon")}</div>
        <input
          className="rec-input"
          placeholder={t("Název, třeba iPhone 13")}
          value={prefs.name}
          maxLength={40}
          onChange={(e) => updatePrefs({ ...prefs, name: e.target.value })}
        />
        <label className="rec-check">
          <input type="checkbox" checked={prefs.inCase} onChange={(e) => updatePrefs({ ...prefs, inCase: e.target.checked })} />
          <span>{t("Telefon je v obalu")}</span>
        </label>
      </div>

      <div className="settings-group">
        <div className="settings-label">{t("Co budeš dělat")}</div>
        <div className="rec-gestures" role="radiogroup">
          {RECORDER_GESTURES.map((g) => {
            const n = perGesture(g.id);
            return (
              <button
                key={g.id}
                role="radio"
                aria-checked={gesture === g.id}
                className={`rec-gesture-opt${gesture === g.id ? " is-on" : ""}${g.positive ? " is-tap" : ""}`}
                onClick={() => setGesture(g.id)}
              >
                <span className="rec-gesture-label">{t(g.label)}</span>
                {n > 0 && <span className="rec-gesture-n">{n}×</span>}
              </button>
            );
          })}
        </div>
      </div>

      <div className="settings-group rec-form">
        <div className="settings-label">{t("Poznámka (nepovinné)")}</div>
        <input
          className="rec-input"
          placeholder={t("Třeba: druhý telefon leží na stole")}
          value={note}
          maxLength={200}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>

      <p className="muted small rec-pad">
        {t(
          selected.positive
            ? "Spusť nahrávání na obou telefonech, pak ťukni 10 až 20krát. Nakonec zadej, kolikrát jsi ťukl."
            : "Spusť nahrávání na obou telefonech, pak pohyb 10 až 20krát zopakuj. Nakonec zadej, kolikrát."
        )}
      </p>

      {permError && (
        <div className="banner banner-danger">
          <ErrorCircleIcon />
          <span>{permError}</span>
        </div>
      )}

      <button className="rec-start" onClick={() => void start()}>
        {t("Začít nahrávat")}
      </button>
    </div>
  );
}

function okLabel(t: (s: string) => string, ok: boolean | null): string {
  if (ok === null) return "…";
  return ok ? t("ano") : t("ne");
}

function SensorRow({ label, value, ok }: { label: string; value: string; ok: boolean | null }) {
  return (
    <div className="info-row">
      <span>{label}</span>
      <code className={ok === false ? "rec-bad" : undefined}>{value}</code>
    </div>
  );
}
