import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  applyPendingJournalDeltas,
  collectJournalDeltas,
  readChapterDeltaJournal,
  writeChapterDeltaJournal,
  type JournalDeltaEntry,
} from "../pipeline/state-journal.js";
import { RuntimeStateDeltaSchema } from "../models/runtime-state.js";

function baseSnapshot(chapter = 0) {
  return {
    manifest: {
      schemaVersion: 2 as const,
      language: "en" as const,
      lastAppliedChapter: chapter,
      projectionVersion: 1,
      migrationWarnings: [],
    },
    currentState: {
      chapter,
      facts: [],
    },
    hooks: {
      hooks: [],
    },
    chapterSummaries: {
      rows: [],
    },
  };
}

function deltaFor(chapter: number, goal: string) {
  return RuntimeStateDeltaSchema.parse({
    chapter,
    currentStatePatch: {
      currentGoal: goal,
    },
    hookOps: {
      upsert: [],
      resolve: [],
      defer: [],
    },
    chapterSummary: {
      chapter,
      title: `Chapter ${chapter}`,
      characters: "Lin Yue",
      events: `Chapter ${chapter} events.`,
      stateChanges: `Chapter ${chapter} state changes.`,
      hookActivity: "none",
      mood: "tight",
      chapterType: "mainline",
    },
    notes: [],
  });
}

describe("state-journal", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-journal-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("round-trips a chapter delta journal atomically without temp files", async () => {
    const delta = deltaFor(7, "Find the ledger.");
    await writeChapterDeltaJournal(root, 7, delta);

    await expect(readChapterDeltaJournal(root, 7)).resolves.toEqual(delta);
    await expect(readChapterDeltaJournal(root, 8)).resolves.toBeNull();

    const files = await readdir(join(root, "story", "runtime"));
    expect(files.filter((file) => file.includes(".tmp"))).toHaveLength(0);
    expect(files).toContain("chapter-0007.delta.json");
  });

  it("collects journaled deltas in ascending chapter order up to the limit", async () => {
    await writeChapterDeltaJournal(root, 3, deltaFor(3, "Goal 3"));
    await writeChapterDeltaJournal(root, 1, deltaFor(1, "Goal 1"));
    await writeChapterDeltaJournal(root, 5, deltaFor(5, "Goal 5"));
    await writeChapterDeltaJournal(root, 2, deltaFor(2, "Goal 2"));

    const entries = await collectJournalDeltas(root, 4);
    expect(entries.map((entry) => entry.chapter)).toEqual([1, 2, 3]);
  });

  it("skips corrupt journal files when collecting", async () => {
    await writeChapterDeltaJournal(root, 1, deltaFor(1, "Goal 1"));
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(join(root, "story", "runtime"), { recursive: true });
    await writeFile(join(root, "story", "runtime", "chapter-0002.delta.json"), "{broken", "utf-8");

    const entries = await collectJournalDeltas(root, 4);
    expect(entries.map((entry) => entry.chapter)).toEqual([1]);
  });

  it("folds deltas in order over a base snapshot", () => {
    const deltas: JournalDeltaEntry[] = [
      { chapter: 1, delta: deltaFor(1, "Goal 1") },
      { chapter: 2, delta: deltaFor(2, "Goal 2") },
    ];
    const result = applyPendingJournalDeltas({ snapshot: baseSnapshot(0), deltas });

    expect(result.outOfOrder).toBe(false);
    expect(result.applied).toEqual([1, 2]);
    expect(result.snapshot.manifest.lastAppliedChapter).toBe(2);
    expect(result.snapshot.chapterSummaries.rows.map((row) => row.chapter)).toEqual([1, 2]);
    expect(result.snapshot.currentState.facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ predicate: "Current Goal", object: "Goal 2", sourceChapter: 2 }),
      ]),
    );
  });

  it("handles out-of-order deltas without regressing the applied chapter", () => {
    // Base snapshot already reflects chapters 1..3. A later chapter 5 landed
    // first (lastApplied = 5), then chapter 4's journal arrives late. The fold
    // must apply 4 with out-of-order semantics and never regress lastApplied.
    const deltas: JournalDeltaEntry[] = [
      { chapter: 1, delta: deltaFor(1, "Goal 1") },
      { chapter: 2, delta: deltaFor(2, "Goal 2") },
      { chapter: 3, delta: deltaFor(3, "Goal 3") },
      { chapter: 4, delta: deltaFor(4, "Goal 4") },
      { chapter: 5, delta: deltaFor(5, "Goal 5") },
    ];
    const result = applyPendingJournalDeltas({ snapshot: baseSnapshot(5), deltas });

    expect(result.outOfOrder).toBe(true);
    expect(result.applied).toEqual([1, 2, 3, 4, 5]);
    expect(result.snapshot.manifest.lastAppliedChapter).toBe(5);
    expect(result.snapshot.currentState.chapter).toBe(5);
    expect(result.snapshot.chapterSummaries.rows.map((row) => row.chapter)).toEqual([1, 2, 3, 4, 5]);
    expect(result.snapshot.currentState.facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ predicate: "Current Goal", object: "Goal 5", sourceChapter: 5 }),
      ]),
    );
  });

  it("re-folding already-applied deltas is idempotent", () => {
    const deltas: JournalDeltaEntry[] = [
      { chapter: 1, delta: deltaFor(1, "Goal 1") },
      { chapter: 2, delta: deltaFor(2, "Goal 2") },
    ];
    const once = applyPendingJournalDeltas({ snapshot: baseSnapshot(0), deltas });
    const twice = applyPendingJournalDeltas({ snapshot: once.snapshot, deltas });

    expect(twice.snapshot).toEqual(once.snapshot);
    expect(twice.outOfOrder).toBe(true); // re-folded chapters are backward
  });
});
