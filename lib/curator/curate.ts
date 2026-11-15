import pTimeout from "p-timeout";
import { now, type Clock } from "../clock";
import type { Store } from "../store";
import { configuredCuratorModel, type CuratorModel } from "./model";
import { validateExtraction } from "./schema";
import type { ModelSelection } from "../model-selection";

export type CuratorStore = Pick<Store, "pendingCurations" | "applyCuration" | "memoryFor" | "threadsFor">;
export type CurationResult = { completed: number; failed: number; deferred: boolean };

/** Run only after persistence and streaming. Failed jobs remain pending for the next turn. */
export async function curate(userId: string, options: {
  store: CuratorStore; turnId?: number; model?: CuratorModel; clock?: () => Clock; signal?: AbortSignal;
  selection?: ModelSelection;
}): Promise<CurationResult> {
  const result: CurationResult = { completed: 0, failed: 0, deferred: false };
  try {
    const jobs = await options.store.pendingCurations(userId, 2, options.turnId);
    if (!jobs.length) return result;
    const model = options.model ?? await configuredCuratorModel(options.selection);
    const deadline = AbortSignal.timeout(12_000);
    for (const job of jobs) {
      const controller = new AbortController();
      const signal = AbortSignal.any([deadline, controller.signal, ...(options.signal ? [options.signal] : [])]);
      try {
        signal.throwIfAborted();
        const [memory, threads] = await Promise.all([options.store.memoryFor(userId), options.store.threadsFor(userId)]);
        const output = await pTimeout(model({ ...job, memory: memory.slice(0, 100), threads }, signal), { milliseconds: 6000, signal });
        const extraction = validateExtraction(output, job);
        if (!extraction) throw new Error("Invalid curator output");
        signal.throwIfAborted();
        if (await options.store.applyCuration(userId, job.assistant.id, extraction, (options.clock ?? now)().instant)) result.completed++;
      } catch { result.failed++; }
      finally { controller.abort(); }
    }
  } catch { result.failed++; }
  return result;
}
