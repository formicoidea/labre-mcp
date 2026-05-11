// In-process event bus backed by RxJS Subject (ARCH-10).
// Stateless from the caller perspective: emit fires-and-forgets;
// subscribe returns an AsyncIterable filtered to the caller's interest.
// One bus instance per recipe execution (scoped, not global) — V2 may add
// session-level scope without breaking the interface.

import { Subject, filter as rxFilter, firstValueFrom } from "rxjs";
import type { Observable } from "rxjs";
import type { PipelineEvent } from "./event.schema.mjs";

export type EventFilter = (event: PipelineEvent) => boolean;

export interface EventBus {
  emit(event: PipelineEvent): void;
  observe(filter?: EventFilter): Observable<PipelineEvent>;
  subscribe(filter?: EventFilter): AsyncIterable<PipelineEvent>;
}

export function createEventBus(): EventBus {
  const subject = new Subject<PipelineEvent>();

  const observe = (predicate?: EventFilter): Observable<PipelineEvent> =>
    predicate ? subject.asObservable().pipe(rxFilter(predicate)) : subject.asObservable();

  return {
    emit(event) {
      subject.next(event);
    },
    observe,
    subscribe(predicate) {
      return iterableFromObservable(observe(predicate));
    },
  };
}

// Bridge an Observable to AsyncIterable so consumers can use for-await.
async function* iterableFromObservable(
  source: Observable<PipelineEvent>,
): AsyncIterable<PipelineEvent> {
  // any: deferred queue without bounded backpressure — fits in-process scale
  const queue: PipelineEvent[] = [];
  let resolveNext: ((v: IteratorResult<PipelineEvent>) => void) | null = null;
  let completed = false;

  const subscription = source.subscribe({
    next: (value) => {
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r({ value, done: false });
      } else {
        queue.push(value);
      }
    },
    complete: () => {
      completed = true;
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r({ value: undefined as unknown as PipelineEvent, done: true });
      }
    },
  });

  try {
    while (true) {
      if (queue.length > 0) {
        yield queue.shift() as PipelineEvent;
        continue;
      }
      if (completed) return;
      const next = await new Promise<IteratorResult<PipelineEvent>>((resolve) => {
        resolveNext = resolve;
      });
      if (next.done) return;
      yield next.value;
    }
  } finally {
    subscription.unsubscribe();
  }
}

// Helper: await the first event matching a predicate (handy for tests).
export async function waitForEvent(
  bus: EventBus,
  predicate: EventFilter,
): Promise<PipelineEvent> {
  return firstValueFrom(bus.observe(predicate));
}
