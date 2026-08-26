// In-process event bus backed by RxJS Subject (ARCH-10).
// Stateless from the caller perspective: emit fires-and-forgets;
// observe returns an Observable filtered to the caller's interest.
// One bus instance per recipe execution (scoped, not global) — V2 may add
// session-level scope without breaking the interface.

import { Subject, filter as rxFilter } from "rxjs";
import type { Observable } from "rxjs";
import type { PipelineEvent } from "./event.schema.mjs";

export type EventFilter = (event: PipelineEvent) => boolean;

export interface EventBus {
  emit(event: PipelineEvent): void;
  observe(filter?: EventFilter): Observable<PipelineEvent>;
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
  };
}
