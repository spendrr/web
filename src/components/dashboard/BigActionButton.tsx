import { type ReactNode } from "react";
import ActionMenuButton, { type ActionMenuItem } from "../ActionMenu";

export function BigActionButton({
  kind,
  label,
  icon,
  onClick,
  menu,
  innerRef,
  onMenuOpen,
}: {
  kind: "receive" | "send";
  label: string;
  icon: ReactNode;
  onClick: () => void;
  // When present, holding the button opens these instead of firing onClick —
  // see ActionMenu.tsx. Empty/absent keeps it an ordinary button, so the
  // menu never appears with nothing in it (the gift entry, for one, is
  // unavailable without a backup key).
  menu?: ActionMenuItem[];
  innerRef?: React.Ref<HTMLButtonElement>;
  onMenuOpen?: () => void;
}) {
  const body = (
    <>
      <span className="big-action-icon">{icon}</span>
      <span className="big-action-label">{label}</span>
    </>
  );
  const className = `big-action-btn big-action-btn--${kind}`;
  if (!menu || menu.length === 0) {
    return (
      <button type="button" className={className} onClick={onClick} ref={innerRef}>
        {body}
      </button>
    );
  }
  return (
    <ActionMenuButton
      className={className}
      items={menu}
      onClick={onClick}
      align={kind === "receive" ? "left" : "right"}
      innerRef={innerRef}
      onOpen={onMenuOpen}
    >
      {body}
    </ActionMenuButton>
  );
}
