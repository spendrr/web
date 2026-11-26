// Suggested @handle for a wallet whose avatar is a character (avatarFriends.ts).
// The name reads off the picture: the noun belongs to the character family
// ("comet" is an astronaut, "squid" an octopus) and the adjective to the colour it
// is mostly made of ("amber" is orange). Both come from the same seed as the
// picture, so the pair never drifts apart, and a typed name that does not match
// the picture is one more cue that the address is not the one meant.
//
// Pools: 8 colours x 24 words, 7 families x 20 nouns. A wallet always lands in
// one colour and one family, so its own pool is 24 x 20 = 480 bare names; across
// everybody that is 26 880 bare names and 2.7 million with the two digit suffix.
//
// Budget: the longest adjective (8) + "-" + the longest noun (7) + "-12" is 19, one under
// the 20 character limit of a handle. The tests enforce it.
import { friendSpec, type AvatarFamily } from "./avatarFriends";

export type HueGroup = "red" | "orange" | "yellow" | "green" | "cyan" | "blue" | "violet" | "pink";

export const FRIEND_ADJECTIVES: Record<HueGroup, readonly string[]> = {
  red: ["ruby", "cherry", "scarlet", "crimson", "rusty", "poppy", "fiery", "ember", "apple", "berry", "lava", "chili", "brick", "cinder", "garnet", "cayenne", "tomato", "paprika", "rouge", "blazing", "carmine", "flame", "spicy", "radish"],
  orange: ["amber", "tangy", "copper", "ginger", "mango", "citrus", "toasty", "sunset", "peachy", "apricot", "carrot", "pumpkin", "honeyed", "autumn", "bronze", "marigold", "tangelo", "papaya", "cinnamon", "rustic", "sandy", "kumquat", "nectar", "foxy"],
  yellow: ["golden", "sunny", "lemon", "honey", "canary", "butter", "saffron", "straw", "mellow", "zesty", "banana", "bright", "mustard", "gleam", "sunlit", "daisy", "custard", "maize", "corn", "gilded", "pollen", "glowing", "cheery", "brassy"],
  green: ["mossy", "minty", "leafy", "jade", "olive", "fern", "forest", "lime", "clover", "pine", "sage", "emerald", "grassy", "verdant", "spruce", "willow", "basil", "matcha", "mint", "ivy", "herbal", "jungle", "meadow", "pear"],
  cyan: ["aqua", "teal", "lagoon", "ocean", "tidal", "frosty", "misty", "breezy", "reef", "wavy", "icy", "crisp", "cool", "surf", "cyan", "coastal", "dolphin", "splash", "brook", "harbor", "drift", "cove", "riptide", "wavelet"],
  blue: ["cobalt", "azure", "indigo", "navy", "denim", "sapphire", "midnight", "stormy", "lunar", "cloudy", "royal", "calm", "steady", "deep", "sky", "bluebell", "arctic", "jeans", "nordic", "polar", "dawn", "thunder", "regal", "lapis"],
  violet: ["violet", "lilac", "plum", "mauve", "orchid", "grape", "twilight", "mystic", "velvet", "dusk", "cosmic", "dreamy", "moody", "wisteria", "iris", "lavender", "heather", "thistle", "mulberry", "eggplant", "plummy", "ultra", "galaxy", "hazy"],
  pink: ["rosy", "blush", "candy", "bubble", "cotton", "flamingo", "peony", "petal", "sweet", "rose", "taffy", "sherbet", "fluffy", "pinky", "coral", "salmon", "bubbly", "dolly", "magenta", "tulip", "camellia", "lolly", "cupcake", "frosted"],
};

export const FRIEND_NOUNS: Record<AvatarFamily, readonly string[]> = {
  astronaut: ["comet", "orbit", "nova", "rocket", "pilot", "cadet", "probe", "rover", "quasar", "nebula", "meteor", "pulsar", "lander", "capsule", "cosmo", "astro", "shuttle", "zenith", "stellar", "flare"],
  octopus: ["octo", "squid", "kraken", "inky", "jelly", "pearl", "tide", "clam", "shell", "cuttle", "wave", "ink", "medusa", "urchin", "mussel", "oyster", "abalone", "limpet", "whelk", "polyp"],
  angler: ["angler", "lure", "glow", "abyss", "trench", "lantern", "fang", "gulper", "siren", "beam", "fin", "lamp", "lurker", "flash", "shadow", "phantom", "spark", "hook", "eel", "maw"],
  planet: ["moon", "mars", "venus", "saturn", "pluto", "titan", "ceres", "europa", "globe", "orb", "eris", "luna", "mercury", "neptune", "uranus", "jupiter", "triton", "phobos", "deimos", "oberon"],
  cactus: ["cactus", "prickle", "thorn", "spike", "agave", "aloe", "mesa", "saguaro", "cholla", "nopal", "sprout", "bloom", "needle", "desert", "yucca", "pot", "dune", "oasis", "cacti", "barrel"],
  ghost: ["ghost", "boo", "spook", "wisp", "shade", "spirit", "specter", "haunt", "banshee", "ghoul", "bogey", "wraith", "mist", "vapor", "fog", "echo", "puff", "sheet", "gloom", "shroud"],
  robot: ["robot", "bolt", "gear", "bot", "cog", "volt", "droid", "servo", "pixel", "byte", "chip", "bleep", "android", "cyborg", "mecha", "gizmo", "sensor", "motor", "wire", "circuit"],
};

export function hueGroup(hex: string): HueGroup {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d + 6) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  if (h < 12 || h >= 345) return "red";
  if (h < 38) return "orange";
  if (h < 70) return "yellow";
  if (h < 170) return "green";
  if (h < 200) return "cyan";
  if (h < 250) return "blue";
  if (h < 300) return "violet";
  return "pink";
}

// Same idea as handle.ts: display-grade hashing, not a security primitive.
function hash(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 15;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 13;
  return h >>> 0;
}

// How many suggestions a person can page through before the picker wraps round; also the
// number of bare names before a two-digit suffix is added (for a name that is taken).
export const FRIEND_BARE_ATTEMPTS = 5;

// Attempt n only changes the words picked inside the wallet's own colour and
// family, so every attempt still matches the picture. The bare attempts are five
// different names (a repeat is skipped); after them a two-digit suffix is added
// (suggestHandle uses three; two keeps the name short).
export function friendHandle(seed: string, attempt = 0): string {
  const n = Math.max(0, Math.floor(attempt));
  const spec = friendSpec(seed);
  const adjectives = FRIEND_ADJECTIVES[hueGroup(spec.main)];
  const nouns = FRIEND_NOUNS[spec.family];
  const bare = (k: number) =>
    `${adjectives[hash(`${seed}|fadj|${k}`) % adjectives.length]}-${nouns[hash(`${seed}|fnoun|${k}`) % nouns.length]}`;
  if (n < FRIEND_BARE_ATTEMPTS) {
    const seen = new Set<string>();
    for (let k = 0; k < 200; k++) {
      const name = bare(k);
      if (seen.has(name)) continue;
      if (seen.size === n) return name;
      seen.add(name);
    }
  }
  const digits = String(hash(`${seed}|fdigits|${n}`) % 100).padStart(2, "0");
  return `${bare(n)}-${digits}`;
}
