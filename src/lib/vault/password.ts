// The strength gate applied to both wallet creation and password change.
//
// The actual work is in passwordStrength.ts — see that file for why this is
// an entropy estimate rather than the character-class checklist it used to
// be.
import { estimatePasswordStrength, MIN_PASSWORD_BITS, type WeaknessKind } from "./passwordStrength";

export { MIN_PASSWORD_BITS };
export type { WeaknessKind };

// Kept as a hard floor on top of the entropy threshold. Not redundant: a
// 7-character string drawn from the full printable-ASCII alphabet prices out
// at ~46 bits and would otherwise pass, and a password that short is a
// reliable sign of one that's about to be reused somewhere else. It also
// keeps the "too short" case out of the estimator's hands entirely, so the
// hint for it can be specific.
export const PASSWORD_MIN_LENGTH = 8;

export function isPasswordStrong(password: string): boolean {
  return password.length >= PASSWORD_MIN_LENGTH && estimatePasswordStrength(password).ok;
}

// The single most useful thing to tell the user about why their password
// was rejected — Czech, like the rest of the UI copy. Returns null when the
// password is fine.
export function passwordProblem(password: string): string | null {
  if (password.length === 0) return null;
  if (password.length < PASSWORD_MIN_LENGTH) {
    return "Heslo musí mít alespoň 8 znaků.";
  }
  const { ok, weakness } = estimatePasswordStrength(password);
  if (ok) return null;
  switch (weakness) {
    case "common":
      return "Tohle heslo obsahuje běžné slovo, které crackery zkoušejí jako první. Přidej něco nečekaného.";
    case "keyboard":
      return "Tohle je souvislá cesta po klávesnici — crackery ji projdou během chvilky. Zkus něco jiného.";
    case "sequence":
      return "Tohle je posloupnost (abc, 1234) — patří k prvním věcem, které se zkoušejí.";
    case "repeat":
      return "Opakující se část heslo prakticky neprodlouží. Zkus víc různých slov.";
    case "date":
      return "Datum nebo rok je jen pár tisíc možností. Nespoléhej se na něj.";
    default:
      return "Heslo je pořád příliš snadno uhodnutelné. Nejlépe funguje několik nesouvisejících slov.";
  }
}

// 0-4, for a progress-bar style indicator. Deliberately coarse: a precise
// bit count means nothing to most people, and showing one invites treating
// 44 bits as "nearly there" when it's the wrong side of the line.
export function passwordStrengthLevel(password: string): 0 | 1 | 2 | 3 | 4 {
  if (password.length === 0) return 0;
  const { bits } = estimatePasswordStrength(password);
  if (password.length < PASSWORD_MIN_LENGTH || bits < 30) return 1;
  if (bits < MIN_PASSWORD_BITS) return 2;
  if (bits < 70) return 3;
  return 4;
}
