// Shake-to-hide-balance: an alternate trigger for the same balanceHidden
// toggle Dashboard.tsx already drives via swipe — this module only detects
// the gesture and persists whether it's opted in, it doesn't own the hidden
// state itself.
//
// iOS 13+ Safari requires an explicit DeviceMotionEvent.requestPermission()
// call, made from a user gesture (a tap on the Settings toggle), before
// devicemotion events fire at all. Other browsers (Android Chrome, desktop)
// don't gate it and have no such method.
const STORAGE_KEY = "btc-wallet-shake-hide-enabled";

type MotionPermissionRequester = {
  requestPermission: () => Promise<"granted" | "denied">;
};

function permissionRequester(): MotionPermissionRequester | null {
  const ctor = window.DeviceMotionEvent as unknown as Partial<MotionPermissionRequester>;
  return typeof ctor.requestPermission === "function" ? (ctor as MotionPermissionRequester) : null;
}

export function isShakeSupported(): boolean {
  return typeof window !== "undefined" && "DeviceMotionEvent" in window;
}

// True only on platforms that require the explicit permission prompt above.
export function needsMotionPermission(): boolean {
  return isShakeSupported() && permissionRequester() !== null;
}

export function isShakeEnabled(): boolean {
  return isShakeSupported() && localStorage.getItem(STORAGE_KEY) === "1";
}

export async function enableShake(): Promise<boolean> {
  if (!isShakeSupported()) return false;
  const requester = permissionRequester();
  if (requester) {
    try {
      if ((await requester.requestPermission()) !== "granted") return false;
    } catch {
      return false;
    }
  }
  localStorage.setItem(STORAGE_KEY, "1");
  return true;
}

export function disableShake(): void {
  localStorage.removeItem(STORAGE_KEY);
}

// A deliberate shake is the phone going back and forth: its acceleration
// swings between two opposite directions, several times, at hand speed.
// The previous detector counted large jumps between *consecutive* samples
// and fired on three within 800ms, which one jolt satisfies on its own: a
// phone set down on a table rings for a few samples (+, -, + 16ms apart),
// and a single swing of the hand crosses it too.
//
// Now: take linear acceleration (gravity removed), and count "lobes", runs
// of samples above SHAKE_THRESHOLD pointing the same way along the axis of
// the first one. A lobe only counts if it points opposite to the previous
// one and starts SHAKE_MIN_GAP_MS..SHAKE_MAX_GAP_MS after it. Faster than
// that is ringing from an impact (it resets the count), slower is two
// unrelated movements. There-back-there is + - + - (each stroke accelerates
// and brakes, the braking merging with the next stroke's start), so it
// takes SHAKE_LOBES_NEEDED = 4; one swing is + - and a swing there and back
// + - +, neither enough.
const SHAKE_THRESHOLD = 10; // m/s^2, about 1 g (12 was a little too stiff)
const SHAKE_MIN_GAP_MS = 60;
const SHAKE_MAX_GAP_MS = 450;
const SHAKE_LOBES_NEEDED = 4;
// A sample pointing mostly sideways to the shake's axis belongs to neither lobe.
const SHAKE_MIN_ALIGNMENT = 0.5;
const SHAKE_DEBOUNCE_MS = 1200;
// Low-pass for gravity where the device gives no `acceleration` (some
// Android devices). Slow enough (~330ms at 60Hz) not to follow the shake.
const GRAVITY_ALPHA = 0.05;

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface MotionSample {
  t: number; // ms
  linear: Vec3 | null; // DeviceMotionEvent.acceleration
  withGravity: Vec3 | null; // DeviceMotionEvent.accelerationIncludingGravity
}

// Pure, exported for tests: feed samples in order, returns true when a shake completes.
export function createShakeDetector(): (s: MotionSample) => boolean {
  let gravity: Vec3 | null = null;
  let axis: Vec3 | null = null; // unit vector of the chain's first lobe
  let lastSign = 0; // sign of the latest counted lobe along `axis`
  let lastLobeAt = 0;
  let lobes = 0;
  let lastShakeAt = -Infinity;

  const startChain = (a: Vec3, mag: number, t: number) => {
    axis = { x: a.x / mag, y: a.y / mag, z: a.z / mag };
    lastSign = 1;
    lastLobeAt = t;
    lobes = 1;
  };

  return ({ t, linear, withGravity }) => {
    let a: Vec3;
    if (linear) {
      a = linear;
    } else if (withGravity) {
      const g = gravity ?? withGravity;
      gravity = {
        x: g.x + GRAVITY_ALPHA * (withGravity.x - g.x),
        y: g.y + GRAVITY_ALPHA * (withGravity.y - g.y),
        z: g.z + GRAVITY_ALPHA * (withGravity.z - g.z),
      };
      a = { x: withGravity.x - gravity.x, y: withGravity.y - gravity.y, z: withGravity.z - gravity.z };
    } else {
      return false;
    }

    const mag = Math.hypot(a.x, a.y, a.z);
    if (mag < SHAKE_THRESHOLD) return false;
    if (!axis || t - lastLobeAt > SHAKE_MAX_GAP_MS) {
      startChain(a, mag, t);
      return false;
    }
    const proj = (a.x * axis.x + a.y * axis.y + a.z * axis.z) / mag;
    if (Math.abs(proj) < SHAKE_MIN_ALIGNMENT) return false;
    const sign = proj > 0 ? 1 : -1;
    if (sign === lastSign) {
      // The same lobe, back above the threshold after a dip. A second push
      // the same way just ages out through SHAKE_MAX_GAP_MS.
      return false;
    }
    if (t - lastLobeAt < SHAKE_MIN_GAP_MS) {
      // Too fast for a hand: ringing after an impact.
      axis = null;
      lobes = 0;
      return false;
    }
    lastSign = sign;
    lastLobeAt = t;
    lobes++;
    if (lobes < SHAKE_LOBES_NEEDED) return false;
    axis = null;
    lobes = 0;
    if (t - lastShakeAt < SHAKE_DEBOUNCE_MS) return false;
    lastShakeAt = t;
    return true;
  };
}

const vec = (v: DeviceMotionEventAcceleration | null): Vec3 | null =>
  v && v.x !== null && v.y !== null && v.z !== null ? { x: v.x, y: v.y, z: v.z } : null;

export function startShakeDetection(onShake: () => void): () => void {
  const detect = createShakeDetector();
  const handler = (e: DeviceMotionEvent) => {
    // e.timeStamp is when the sample was taken; reading the clock in the
    // handler would squeeze samples a busy main thread delivered late
    // together, and that would read as ringing.
    const t = e.timeStamp > 0 ? e.timeStamp : performance.now();
    if (detect({ t, linear: vec(e.acceleration), withGravity: vec(e.accelerationIncludingGravity) })) onShake();
  };

  window.addEventListener("devicemotion", handler);
  return () => window.removeEventListener("devicemotion", handler);
}
