// System "back" (Android button or gesture, browser back) steps back inside
// the app instead of leaving it. Every open layer (sheet, page, conversation)
// owns one history entry; a popstate closes the topmost layer.
//
// History entries are anonymous, so the stack here is the truth: the entry
// count always equals the layer count. A layer closed by the app itself gives
// its entry back with history.back(), and that popstate is swallowed.
// History operations run one at a time (a back() is awaited before the next
// pushState), otherwise a close followed by an open can land on the wrong
// entry.
//
// A layer with no handler (a sheet mid-send) swallows back: the entry is
// pushed again and nothing closes. Back never confirms or submits anything.

import { useEffect, useRef } from "react";

interface Layer {
  handler: () => (() => void) | undefined;
  popped: boolean;
}

const stack: Layer[] = [];
const ops: ("push" | "back")[] = [];
let waiting = false;
let waitTimer: number | undefined;

function run() {
  while (!waiting && ops.length > 0) {
    if (ops.shift() === "push") {
      window.history.pushState({ spendrrLayer: true }, "");
    } else {
      waiting = true;
      // popstate normally ends the wait; this is only the backstop.
      waitTimer = window.setTimeout(() => {
        waiting = false;
        run();
      }, 600);
      window.history.back();
    }
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => {
    if (waiting) {
      window.clearTimeout(waitTimer);
      waiting = false;
      run();
      return;
    }
    const top = stack[stack.length - 1];
    if (!top) return;
    const fire = top.handler();
    if (!fire) {
      ops.push("push");
      run();
      return;
    }
    stack.pop();
    top.popped = true;
    fire();
  });
}

// `active` while the layer is open. `onBack` closes it; undefined blocks
// back for as long as it is undefined.
export function useBackLayer(active: boolean, onBack: (() => void) | undefined) {
  const ref = useRef(onBack);
  useEffect(() => {
    ref.current = onBack;
  });
  useEffect(() => {
    if (!active) return;
    const layer: Layer = { handler: () => ref.current, popped: false };
    stack.push(layer);
    ops.push("push");
    run();
    return () => {
      if (layer.popped) return;
      const i = stack.indexOf(layer);
      if (i >= 0) stack.splice(i, 1);
      ops.push("back");
      run();
    };
  }, [active]);
}
