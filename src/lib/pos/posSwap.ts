import { flushSync } from "react-dom";
import { isMotionOn } from "../ui/motion";

// Runs a state change that swaps the whole Pokladna panel inside a View
// Transition, so the old stage fades out while the new one rises in. The
// attribute names the stage element only for the length of the transition
// (PosPanel.css), and without motion or the API it is a plain update.
// "checkout": the hub's header folds away or comes back, so it fades as a
// whole. "manage" (price list editor): the header stays, only its right slot
// (pencil or empty) changes, so only that slot fades.
// The view chips do not use it: a running View Transition takes every tap
// for itself, so quick chip taps were lost (they animate in CSS instead).
export type SwapScope = "checkout" | "manage";

export function swapStage(update: () => void, scope: SwapScope): void {
  const doc = document as Document & {
    startViewTransition?: (cb: () => void) => {
      finished: Promise<unknown>;
      ready: Promise<unknown>;
      updateCallbackDone: Promise<unknown>;
    };
  };
  const root = document.documentElement;
  // A second swap while one is still running (fast taps) is applied at once:
  // queued transitions stutter when switching quickly.
  if (!isMotionOn() || document.hidden || !doc.startViewTransition || root.hasAttribute("data-pos-vt")) {
    update();
    return;
  }
  root.setAttribute("data-pos-vt", scope);
  const done = () => root.removeAttribute("data-pos-vt");
  const transition = doc.startViewTransition(() => flushSync(update));
  transition.finished.then(done, done);
  // A skipped transition or a throwing update rejects these too; nothing
  // listens, and an unhandled rejection would reach the app's error reporting.
  transition.ready.catch(() => {});
  transition.updateCallbackDone.catch(() => {});
}
