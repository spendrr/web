import { useCallback, useState } from "react";
import { useT } from "../lib/i18n";
import { isMaintenanceSuppressed, setMaintenanceSuppressed } from "../lib/maintenance/maintenanceSuppress";

// Not mounted anywhere since 2026-09-21: the manual switch was no longer needed,
// so it was taken out of Settings. Kept so it can be dropped back in (it used to
// sit in its own `settings-group` at the bottom of the v2 Settings list, next to
// the wallet log) if an Ark round-coordinator stall ever needs it again.
// maintenanceSuppress.ts and its readers (Dashboard.tsx refresh(), backup.ts)
// are untouched, so a flag still set in localStorage keeps working.
// See maintenanceSuppress.ts's file comment for the full reasoning.
export function MaintenanceSuppressToggle() {
  const t = useT();
  const [suppressed, setSuppressed] = useState(isMaintenanceSuppressed());

  const choose = useCallback((value: boolean) => {
    setMaintenanceSuppressed(value);
    setSuppressed(value);
  }, []);

  return (
    <button
      type="button"
      role="switch"
      aria-checked={suppressed}
      aria-label={t("Potlačit automatickou obnovu VTXO")}
      className={`boolean-switch${suppressed ? " on" : ""}`}
      onClick={() => choose(!suppressed)}
    >
      <span className="boolean-switch-thumb" />
    </button>
  );
}
