const COLLECTOR_KEY = "__opencodeBenchmarkCollector";

/** Builds the renderer expression that installs low-overhead performance observers. */
export function installCollectorExpression() {
  return `(() => {
    const key = ${JSON.stringify(COLLECTOR_KEY)};
    globalThis[key]?.stop?.();
    const supported = new Set(globalThis.PerformanceObserver?.supportedEntryTypes ?? []);
    const observers = [];
    const startedAt = performance.now();
    const state = {
      startedAt,
      lastMutationAt: startedAt,
      mutationRecords: 0,
      sawBusy: false,
      currentBusyCount: 0,
      maxBusyCount: 0,
      busySessionViewsSeen: 0,
      sessionViewCount: document.querySelectorAll('.opencode-session-view').length,
      longTasks: { count: 0, totalMs: 0, maxMs: 0 },
      longAnimationFrames: { count: 0, totalMs: 0, maxMs: 0 },
      layoutShiftScore: 0,
      heapPeakBytes: performance.memory?.usedJSHeapSize ?? 0,
      supportedEntryTypes: [...supported],
    };
    const observe = (type, callback) => {
      if (!supported.has(type)) return;
      const observer = new PerformanceObserver((list) => callback(list.getEntries()));
      observer.observe({ type, buffered: true });
      observers.push(observer);
    };
    const recordDurations = (target, entries) => {
      for (const entry of entries) {
        target.count += 1;
        target.totalMs += entry.duration;
        target.maxMs = Math.max(target.maxMs, entry.duration);
      }
    };
    observe('longtask', (entries) => recordDurations(state.longTasks, entries));
    observe('long-animation-frame', (entries) => recordDurations(state.longAnimationFrames, entries));
    observe('layout-shift', (entries) => {
      for (const entry of entries) if (!entry.hadRecentInput) state.layoutShiftScore += entry.value;
    });
    const seenBusyViews = new WeakSet();
    const sampleBusy = () => {
      const views = [...document.querySelectorAll('.opencode-session-view')];
      state.sessionViewCount = views.length;
      const busyViews = views.filter((view) => view.querySelector('.opencode-session-view__composer-send.is-stop'));
      for (const view of busyViews) {
        if (seenBusyViews.has(view)) continue;
        seenBusyViews.add(view);
        state.busySessionViewsSeen += 1;
      }
      state.currentBusyCount = busyViews.length;
      state.maxBusyCount = Math.max(state.maxBusyCount, state.currentBusyCount);
      if (state.currentBusyCount > 0) state.sawBusy = true;
    };
    sampleBusy();
    const mutations = new MutationObserver((records) => {
      state.mutationRecords += records.length;
      state.lastMutationAt = performance.now();
      sampleBusy();
    });
    mutations.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
    const heapTimer = globalThis.setInterval(() => {
      state.heapPeakBytes = Math.max(state.heapPeakBytes, performance.memory?.usedJSHeapSize ?? 0);
    }, 250);
    state.snapshot = () => ({ ...state, now: performance.now(), elapsedMs: performance.now() - startedAt });
    state.stop = () => {
      mutations.disconnect();
      for (const observer of observers) observer.disconnect();
      globalThis.clearInterval(heapTimer);
      sampleBusy();
      return state.snapshot();
    };
    globalThis[key] = state;
    return state.snapshot();
  })()`;
}

/** Builds the renderer expression used to poll collector completion state. */
export function readCollectorExpression() {
  return `globalThis[${JSON.stringify(COLLECTOR_KEY)}]?.snapshot?.() ?? null`;
}

/** Builds the renderer expression that stops observers and returns final state. */
export function stopCollectorExpression() {
  return `globalThis[${JSON.stringify(COLLECTOR_KEY)}]?.stop?.() ?? null`;
}
