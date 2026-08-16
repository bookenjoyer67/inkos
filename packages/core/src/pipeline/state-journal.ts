import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { RuntimeStateDelta } from "../models/runtime-state.js";
import { RuntimeStateDeltaSchema } from "../models/runtime-state.js";
import type { RuntimeStateSnapshot } from "../state/state-reducer.js";
import { applyRuntimeStateDelta } from "../state/state-reducer.js";
import { loadRuntimeStateSnapshot } from "../state/runtime-state-store.js";
import {
  renderChapterSummariesProjection,
  renderCurrentStateProjection,
  renderHooksProjection,
} from "../state/state-projections.js";
import { commitAtomicFileSet, type AtomicFileWrite } from "../utils/atomic-file-set.js";

/**
 * Durable per-chapter state-mutation journal.
 *
 * A write job's settle step produces a structured `RuntimeStateDelta`. Instead
 * of writing the whole truth files from a possibly-stale in-memory snapshot,
 * the chapter's delta is journaled here and the serialized applier folds the
 * pending deltas over the freshest on-disk snapshot (see
 * `applyPendingJournalDeltas`). Journals are kept permanently so out-of-order
 * commits and crash recovery can replay history deterministically.
 */

const DELTA_FILE_RE = /^chapter-(\d{4})\.delta\.json$/;

export function chapterDeltaJournalPath(bookDir: string, chapterNumber: number): string {
  return join(bookDir, "story", "runtime", `chapter-${String(chapterNumber).padStart(4, "0")}.delta.json`);
}

export async function writeChapterDeltaJournal(
  bookDir: string,
  chapterNumber: number,
  delta: RuntimeStateDelta,
): Promise<void> {
  const path = chapterDeltaJournalPath(bookDir, chapterNumber);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(RuntimeStateDeltaSchema.parse(delta), null, 2)}\n`, "utf-8");
    await rename(tmp, path);
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
}

export async function readChapterDeltaJournal(
  bookDir: string,
  chapterNumber: number,
): Promise<RuntimeStateDelta | null> {
  try {
    const raw = await readFile(chapterDeltaJournalPath(bookDir, chapterNumber), "utf-8");
    return RuntimeStateDeltaSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

export interface JournalDeltaEntry {
  readonly chapter: number;
  readonly delta: RuntimeStateDelta;
}

export async function collectJournalDeltas(
  bookDir: string,
  uptoChapter: number,
): Promise<ReadonlyArray<JournalDeltaEntry>> {
  const runtimeDir = join(bookDir, "story", "runtime");
  let files: string[];
  try {
    files = await readdir(runtimeDir);
  } catch {
    return [];
  }

  const entries: JournalDeltaEntry[] = [];
  for (const file of files) {
    const match = DELTA_FILE_RE.exec(file);
    if (!match) continue;
    const chapter = Number.parseInt(match[1] ?? "", 10);
    if (!Number.isFinite(chapter) || chapter <= 0 || chapter > uptoChapter) continue;
    const delta = await readChapterDeltaJournal(bookDir, chapter);
    if (!delta) continue;
    entries.push({ chapter, delta });
  }

  return entries.sort((left, right) => left.chapter - right.chapter);
}

export interface ApplyJournalDeltasResult {
  readonly snapshot: RuntimeStateSnapshot;
  readonly applied: ReadonlyArray<number>;
  readonly outOfOrder: boolean;
}

/**
 * Fold all journaled deltas (ascending chapter order) over the given base
 * snapshot. Re-folding already-applied chapters is idempotent: summary rows
 * are replaced, hook upserts merge, and current-state slots are re-patched.
 * A delta whose chapter is <= the base's lastAppliedChapter is an out-of-order
 * commit — it is applied with `allowOutOfOrder` so `lastAppliedChapter` never
 * regresses.
 */
export function applyPendingJournalDeltas(params: {
  readonly snapshot: RuntimeStateSnapshot;
  readonly deltas: ReadonlyArray<JournalDeltaEntry>;
}): ApplyJournalDeltasResult {
  let snapshot = params.snapshot;
  const applied: number[] = [];
  let outOfOrder = false;

  const ordered = [...params.deltas].sort((left, right) => left.chapter - right.chapter);
  for (const { chapter, delta } of ordered) {
    const backward = chapter <= snapshot.manifest.lastAppliedChapter;
    if (backward) outOfOrder = true;
    snapshot = applyRuntimeStateDelta({
      snapshot,
      delta,
      allowReapply: true,
      allowOutOfOrder: backward,
    });
    applied.push(chapter);
  }

  return { snapshot, applied, outOfOrder };
}

export interface ApplyJournalToStateResult {
  readonly applied: ReadonlyArray<number>;
  readonly outOfOrder: boolean;
}

/**
 * The serialized state applier. Must run inside the book's `commit` lock.
 *
 * Re-reads the freshest on-disk snapshot, folds every journaled delta
 * (ascending, out-of-order allowed), and writes back the canonical state JSON
 * plus the rendered truth markdown. Re-folding already-applied chapters is
 * idempotent, so this is safe to run on every commit even when journals for
 * previously-committed chapters are present.
 *
 * Known limitation: with out-of-order commits the per-chapter snapshot dirs
 * are written from the merged state (see the runner), so temporal fact history
 * can be imprecise for the affected range. The journal is retained so a
 * deterministic snapshot-range reconciliation can be added later.
 */
export async function applyJournalToState(params: {
  readonly bookDir: string;
  readonly uptoChapter: number;
  readonly language: "zh" | "en";
}): Promise<ApplyJournalToStateResult> {
  const deltas = await collectJournalDeltas(params.bookDir, params.uptoChapter);
  if (deltas.length === 0) {
    return { applied: [], outOfOrder: false };
  }

  const snapshot = await loadRuntimeStateSnapshot(params.bookDir);
  const folded = applyPendingJournalDeltas({ snapshot, deltas });
  if (folded.applied.length === 0) {
    return { applied: [], outOfOrder: folded.outOfOrder };
  }

  const { snapshot: next } = folded;
  const writes: AtomicFileWrite[] = [
    { relativePath: join("story", "state", "manifest.json"), content: `${JSON.stringify(next.manifest, null, 2)}\n` },
    { relativePath: join("story", "state", "current_state.json"), content: `${JSON.stringify(next.currentState, null, 2)}\n` },
    { relativePath: join("story", "state", "hooks.json"), content: `${JSON.stringify(next.hooks, null, 2)}\n` },
    { relativePath: join("story", "state", "chapter_summaries.json"), content: `${JSON.stringify(next.chapterSummaries, null, 2)}\n` },
    { relativePath: join("story", "current_state.md"), content: renderCurrentStateProjection(next.currentState, params.language) },
    { relativePath: join("story", "pending_hooks.md"), content: renderHooksProjection(next.hooks, params.language, {
      currentChapter: next.currentState.chapter,
    }) },
    { relativePath: join("story", "chapter_summaries.md"), content: renderChapterSummariesProjection(next.chapterSummaries, params.language) },
  ];

  await commitAtomicFileSet({
    rootDir: params.bookDir,
    writes,
    deletes: [],
  });

  return { applied: folded.applied, outOfOrder: folded.outOfOrder };
}
