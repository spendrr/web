// The safety code two people compare to know that the key behind a name is
// really the other person's, and not one the name registry (or someone who
// took it over) put there. Like Signal's safety numbers: the same digits on
// both phones, because the two keys go in sorted. Pure, unit-tested.
//
// Eight groups of five digits, each from five bytes of SHA-512, about 132 bits:
// far beyond making a second key with the same code.
const SAFETY_PREFIX = "spendrr-safety-v1:";
const GROUPS = 8;

export async function safetyCode(a: string, b: string): Promise<string[]> {
  const [x, y] = [a, b].sort();
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-512", new TextEncoder().encode(SAFETY_PREFIX + x + y)));
  const groups: string[] = [];
  for (let g = 0; g < GROUPS; g++) {
    let n = 0;
    for (let i = 0; i < 5; i++) n = n * 256 + digest[g * 5 + i];
    groups.push(String(n % 100000).padStart(5, "0"));
  }
  return groups;
}
