import {
  createElement,
  lazy,
  type ComponentType,
  type LazyExoticComponent,
} from "react";

// React.lazy suspends on the first render of every lazy component, even when
// the chunk is long downloaded, and React then holds the content back until
// 300 ms after the fallback appeared (FALLBACK_THROTTLE_MS). With a null
// fallback that is a blank beat on the first open of a screen. This keeps the
// resolved component itself and renders it directly; Suspense only matters
// while the chunk is still on its way. Callers keep their <Suspense> wrapper.
export type LazyReady<P extends object> = ComponentType<P> & {
  // Starts the download (idempotent) and resolves once the component is stored.
  preload: () => Promise<void>;
  // True once the component can render without suspending.
  isReady: () => boolean;
};

export function lazyReady<P extends object>(
  load: () => Promise<{ default: ComponentType<P> }>,
): LazyReady<P> {
  let resolved: ComponentType<P> | null = null;
  let pending: Promise<void> | null = null;

  const preload = (): Promise<void> => {
    pending ??= load().then(
      (m) => {
        resolved = m.default;
      },
      (err) => {
        // A failed download may be retried by the next preload.
        pending = null;
        throw err;
      },
    );
    return pending;
  };

  // Suspends (as plain lazy would) only while the chunk is not here yet.
  const Fallback: LazyExoticComponent<ComponentType<P>> = lazy(async () => {
    await preload();
    return { default: resolved as ComponentType<P> };
  });

  const Ready = ((props: P) =>
    createElement(resolved ?? Fallback, props)) as LazyReady<P>;
  Ready.preload = preload;
  Ready.isReady = () => resolved !== null;
  return Ready;
}
