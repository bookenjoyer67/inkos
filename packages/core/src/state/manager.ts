import { readFile, writeFile, mkdir, readdir, rm, stat, unlink, open, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type { BookConfig } from "../models/book.js";
import type { ChapterMeta } from "../models/chapter.js";
import { bootstrapStructuredStateFromMarkdown, resolveDurableStoryProgress } from "./state-bootstrap.js";

const BOOK_LOCK_HEARTBEAT_MS = 30_000;
const BOOK_LOCK_LEASE_MS = 3 * 60_000;
const BOOK_LOCK_RELEASE_RETRIES = 4;

// Chapter-number reservation file + lease. A write job reserves its target
// chapter under the commit lock before the long phase; the reservation is what
// prevents two concurrent writers from allocating the same chapter number. It
// is released on success/abort and pruned lazily when the owner pid dies or
// the lease expires (crash safety).
const CHAPTER_RESERVATIONS_FILE = ".chapter-reservations.json";
const CHAPTER_RESERVATION_LEASE_MS = 30 * 60_000;

interface ChapterReservation {
  readonly chapter: number;
  readonly pid: number;
  readonly startedAt: number;
}

interface ChapterReservationsFile {
  readonly version: 1;
  readonly reservations: ReadonlyArray<ChapterReservation>;
}

// Defaults for waiting lock acquires (Phase 1: infra only; consumers opt in by
// passing a timeoutMs > 0). Book-scope waits can legitimately span a whole
// write job (~10 min), so the default is generous; commit-scope holds are
// sub-second by design.
export const BOOK_LOCK_WAIT_TIMEOUT_MS = 30 * 60_000;
export const BOOK_LOCK_POLL_MS = 2_000;
// Commit-scope critical sections are sub-second by design (deterministic tail
// only), so a 60s wait is generous headroom and fails fast if something stalls.
export const BOOK_LOCK_COMMIT_WAIT_TIMEOUT_MS = 60_000;

// A lock scope selects which lock file is acquired for a book. Distinct
// scopes are independent locks: two tasks holding different scopes can run
// concurrently, while same-scope holders serialize.
export type BookLockScope =
  | { readonly kind: "book" }
  | { readonly kind: "commit" }
  | { readonly kind: "chapter"; readonly chapter: number };

export interface AcquireBookLockOptions {
  readonly scope?: BookLockScope;
  // >0: poll for the lock up to this many ms instead of failing immediately.
  readonly timeoutMs?: number;
  readonly pollMs?: number;
}

interface BookLockMetadata {
  readonly version: 1;
  readonly pid: number;
  readonly token: string;
  readonly startedAt: number;
  heartbeatAt: number;
}

interface ProcessBookLock {
  readonly metadata: BookLockMetadata;
  heartbeatTimer?: ReturnType<typeof setInterval>;
  heartbeatTask?: Promise<void>;
}

// Studio creates a PipelineRunner per request. Lock ownership therefore has to
// be shared by every StateManager in this process, not stored on one instance.
const processBookLocks = new Map<string, ProcessBookLock>();

export class BookWriteLockError extends Error {
  readonly code = "BOOK_BUSY";

  constructor(
    readonly bookId: string,
    readonly lockPath: string,
    lockData?: string,
  ) {
    super(
      `Book "${bookId}" is locked by an active InkOS write${lockData ? ` (${lockData})` : ""}. ` +
      "Wait for it to finish or stop the running task, then retry. Stale locks are recovered automatically.",
    );
    this.name = "BookWriteLockError";
  }
}

export class StateManager {
  constructor(private readonly projectRoot: string) {}

  private static defaultAuthorIntent(language: "zh" | "en"): string {
    return language === "zh"
      ? "# 作者意图\n\n（在这里描述这本书的长期创作方向。）\n"
      : "# Author Intent\n\n(Describe the long-horizon vision for this book here.)\n";
  }

  private static defaultCurrentFocus(language: "zh" | "en"): string {
    return language === "zh"
      ? "# 当前聚焦\n\n## 当前重点\n\n（描述接下来 1-3 章最需要优先推进的内容。）\n"
      : "# Current Focus\n\n## Active Focus\n\n(Describe what the next 1-3 chapters should prioritize.)\n";
  }

  async ensureControlDocuments(bookId: string, authorIntent?: string): Promise<void> {
    const language = await this.resolveControlDocumentLanguage(bookId);
    await this.ensureControlDocumentsAt(this.bookDir(bookId), language, authorIntent);
  }

  async ensureControlDocumentsAt(
    bookDir: string,
    language: "zh" | "en",
    authorIntent?: string,
  ): Promise<void> {
    const storyDir = join(bookDir, "story");
    const runtimeDir = join(storyDir, "runtime");
    const outlineDir = join(storyDir, "outline");
    const rolesMajorDir = join(storyDir, "roles", "主要角色");
    const rolesMinorDir = join(storyDir, "roles", "次要角色");

    await mkdir(storyDir, { recursive: true });
    await mkdir(runtimeDir, { recursive: true });
    await mkdir(outlineDir, { recursive: true });
    await mkdir(rolesMajorDir, { recursive: true });
    await mkdir(rolesMinorDir, { recursive: true });

    await this.writeIfMissing(
      join(storyDir, "author_intent.md"),
      authorIntent?.trim()
        ? authorIntent.trimEnd() + "\n"
        : StateManager.defaultAuthorIntent(language),
    );

    await this.writeIfMissing(
      join(storyDir, "current_focus.md"),
      StateManager.defaultCurrentFocus(language),
    );

    // Ensure style_guide includes writing methodology even without reference text
    const styleGuidePath = join(storyDir, "style_guide.md");
    try {
      const existing = await readFile(styleGuidePath, "utf-8");
      if (!existing.includes("写作方法论") && !existing.includes("Writing Methodology")) {
        const { buildWritingMethodologySection } = await import("../utils/writing-methodology.js");
        await writeFile(styleGuidePath, `${existing}\n\n${buildWritingMethodologySection(language)}`, "utf-8");
      }
    } catch {
      const { buildWritingMethodologySection } = await import("../utils/writing-methodology.js");
      await writeFile(styleGuidePath, buildWritingMethodologySection(language), "utf-8");
    }
  }

  async loadControlDocuments(bookId: string): Promise<{
    authorIntent: string;
    currentFocus: string;
    runtimeDir: string;
  }> {
    await this.ensureControlDocuments(bookId);

    const storyDir = join(this.bookDir(bookId), "story");
    const runtimeDir = join(storyDir, "runtime");
    const [authorIntent, currentFocus] = await Promise.all([
      readFile(join(storyDir, "author_intent.md"), "utf-8"),
      readFile(join(storyDir, "current_focus.md"), "utf-8"),
    ]);

    return { authorIntent, currentFocus, runtimeDir };
  }

  private async resolveControlDocumentLanguage(bookId: string): Promise<"zh" | "en"> {
    try {
      const raw = await readFile(join(this.bookDir(bookId), "book.json"), "utf-8");
      const parsed = JSON.parse(raw) as { language?: unknown };
      return parsed.language === "zh" ? "zh" : "en";
    } catch {
      return "en";
    }
  }

  async acquireBookLock(bookId: string, options: AcquireBookLockOptions = {}): Promise<() => Promise<void>> {
    const scope = options.scope ?? { kind: "book" as const };
    const timeoutMs = options.timeoutMs ?? 0;
    if (timeoutMs > 0) {
      const deadline = Date.now() + timeoutMs;
      const pollMs = options.pollMs ?? BOOK_LOCK_POLL_MS;
      for (;;) {
        try {
          return await this.acquireBookLockOnce(bookId, scope);
        } catch (error) {
          if (!(error instanceof BookWriteLockError)) throw error;
          if (Date.now() >= deadline) throw error;
          await new Promise((resolveDelay) => setTimeout(resolveDelay, pollMs));
        }
      }
    }
    return this.acquireBookLockOnce(bookId, scope);
  }

  private lockFileNameForScope(scope: BookLockScope): string {
    switch (scope.kind) {
      case "book":
        return ".write.lock";
      case "commit":
        return ".commit.lock";
      case "chapter":
        return `.chapter-${scope.chapter}.lock`;
    }
  }

  private async acquireBookLockOnce(bookId: string, scope: BookLockScope): Promise<() => Promise<void>> {
    await mkdir(this.bookDir(bookId), { recursive: true });
    const lockPath = join(this.bookDir(bookId), this.lockFileNameForScope(scope));
    const lockKey = this.normalizeLockKey(lockPath);
    const existingOwner = processBookLocks.get(lockKey);
    if (existingOwner) {
      throw new BookWriteLockError(bookId, lockPath, this.describeLock(existingOwner.metadata));
    }

    const now = Date.now();
    const owner: ProcessBookLock = {
      metadata: {
        version: 1,
        pid: process.pid,
        token: randomUUID(),
        startedAt: now,
        heartbeatAt: now,
      },
    };
    // Reserve synchronously before the first filesystem await so two
    // StateManager instances in this process cannot race through EEXIST and
    // mistake the other one's live file for a stale same-process lock.
    processBookLocks.set(lockKey, owner);

    try {
      let acquired = false;
      for (let attempt = 0; attempt < 4 && !acquired; attempt++) {
        try {
          await this.createLockFile(lockPath, owner.metadata);
          acquired = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException | undefined)?.code !== "EEXIST") {
            throw error;
          }

          let snapshot: Awaited<ReturnType<StateManager["readLockSnapshot"]>>;
          try {
            snapshot = await this.readLockSnapshot(lockPath);
          } catch (snapshotError) {
            if ((snapshotError as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
              continue;
            }
            throw snapshotError;
          }
          if (!this.isStaleLock(snapshot.metadata, snapshot.mtimeMs)) {
            throw new BookWriteLockError(bookId, lockPath, snapshot.raw);
          }
          await this.removeStaleLock(lockPath, snapshot.raw);
        }
      }

      if (!acquired) {
        throw new BookWriteLockError(bookId, lockPath);
      }

      this.startLockHeartbeat(lockPath, lockKey, owner);
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        if (owner.heartbeatTimer) clearInterval(owner.heartbeatTimer);
        await owner.heartbeatTask;
        if (processBookLocks.get(lockKey)?.metadata.token === owner.metadata.token) {
          processBookLocks.delete(lockKey);
        }
        try {
          const snapshot = await this.readLockSnapshot(lockPath);
          if (snapshot.metadata?.token !== owner.metadata.token) {
            return;
          }
          await this.unlinkWithRetry(lockPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
            console.warn(`[inkos] Failed to release book lock ${lockPath}: ${String(error)}`);
          }
        }
      };
    } catch (error) {
      if (processBookLocks.get(lockKey)?.metadata.token === owner.metadata.token) {
        processBookLocks.delete(lockKey);
      }
      throw error;
    }
  }

  private normalizeLockKey(lockPath: string): string {
    const absolute = resolve(lockPath);
    return process.platform === "win32" ? absolute.toLowerCase() : absolute;
  }

  private serializeLock(metadata: BookLockMetadata): string {
    return JSON.stringify(metadata);
  }

  private describeLock(metadata: BookLockMetadata): string {
    return `pid:${metadata.pid} started:${new Date(metadata.startedAt).toISOString()}`;
  }

  private async createLockFile(lockPath: string, metadata: BookLockMetadata): Promise<void> {
    const handle = await open(lockPath, "wx");
    try {
      await handle.writeFile(this.serializeLock(metadata), "utf-8");
    } catch (error) {
      await handle.close().catch(() => undefined);
      await this.unlinkWithRetry(lockPath).catch(() => undefined);
      throw error;
    }
    await handle.close();
  }

  private parseLockMetadata(lockData: string): Partial<BookLockMetadata> | undefined {
    try {
      const parsed = JSON.parse(lockData) as Record<string, unknown>;
      const pid = typeof parsed.pid === "number" ? parsed.pid : undefined;
      const startedAt = typeof parsed.startedAt === "number" ? parsed.startedAt : undefined;
      const heartbeatAt = typeof parsed.heartbeatAt === "number" ? parsed.heartbeatAt : startedAt;
      return {
        ...(parsed.version === 1 ? { version: 1 as const } : {}),
        ...(pid !== undefined ? { pid } : {}),
        ...(typeof parsed.token === "string" ? { token: parsed.token } : {}),
        ...(startedAt !== undefined ? { startedAt } : {}),
        ...(heartbeatAt !== undefined ? { heartbeatAt } : {}),
      };
    } catch {
      const pid = this.extractLockPid(lockData);
      const timestampMatch = lockData.match(/ts:(\d+)/);
      const startedAt = timestampMatch ? Number.parseInt(timestampMatch[1] ?? "", 10) : undefined;
      if (pid === undefined && startedAt === undefined) return undefined;
      return {
        ...(pid !== undefined ? { pid } : {}),
        ...(Number.isFinite(startedAt) ? { startedAt, heartbeatAt: startedAt } : {}),
      };
    }
  }

  private async readLockSnapshot(lockPath: string): Promise<{
    readonly raw: string;
    readonly metadata?: Partial<BookLockMetadata>;
    readonly mtimeMs: number;
  }> {
    const [raw, lockStat] = await Promise.all([
      readFile(lockPath, "utf-8"),
      stat(lockPath),
    ]);
    return { raw, metadata: this.parseLockMetadata(raw), mtimeMs: lockStat.mtimeMs };
  }

  private isStaleLock(metadata: Partial<BookLockMetadata> | undefined, mtimeMs: number): boolean {
    if (metadata?.pid === process.pid) {
      // No processBookLocks owner existed before this acquisition reserved its
      // slot, so a same-pid file here can only be orphaned from an older task.
      return true;
    }
    if (metadata?.pid !== undefined && !this.isProcessAlive(metadata.pid)) {
      return true;
    }
    const heartbeatAt = metadata?.heartbeatAt ?? mtimeMs;
    const hasLeaseMetadata = metadata?.version === 1 && typeof metadata.token === "string";
    return hasLeaseMetadata && Date.now() - heartbeatAt > BOOK_LOCK_LEASE_MS;
  }

  private async removeStaleLock(lockPath: string, expectedRaw: string): Promise<void> {
    const currentRaw = await readFile(lockPath, "utf-8").catch(() => undefined);
    if (currentRaw === undefined) return;
    if (currentRaw !== expectedRaw) {
      return;
    }
    await this.unlinkWithRetry(lockPath);
  }

  private startLockHeartbeat(lockPath: string, lockKey: string, owner: ProcessBookLock): void {
    const refresh = async () => {
      if (processBookLocks.get(lockKey)?.metadata.token !== owner.metadata.token) return;
      const handle = await open(lockPath, "r+");
      try {
        const currentRaw = await handle.readFile("utf-8");
        if (this.parseLockMetadata(currentRaw)?.token !== owner.metadata.token) return;
        owner.metadata.heartbeatAt = Date.now();
        const serialized = Buffer.from(this.serializeLock(owner.metadata), "utf-8");
        await handle.write(serialized, 0, serialized.length, 0);
        await handle.truncate(serialized.length);
      } finally {
        await handle.close();
      }
    };
    owner.heartbeatTimer = setInterval(() => {
      if (owner.heartbeatTask) return;
      const task = refresh()
        .catch((error) => {
          console.warn(`[inkos] Failed to refresh book lock ${lockPath}: ${String(error)}`);
        })
        .finally(() => {
          if (owner.heartbeatTask === task) owner.heartbeatTask = undefined;
        });
      owner.heartbeatTask = task;
    }, BOOK_LOCK_HEARTBEAT_MS);
    owner.heartbeatTimer.unref?.();
  }

  private async unlinkWithRetry(lockPath: string): Promise<void> {
    for (let attempt = 0; attempt < BOOK_LOCK_RELEASE_RETRIES; attempt++) {
      try {
        await unlink(lockPath);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        if (code === "ENOENT") return;
        const retryable = code === "EPERM" || code === "EACCES" || code === "EBUSY";
        if (!retryable || attempt === BOOK_LOCK_RELEASE_RETRIES - 1) throw error;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25 * (attempt + 1)));
      }
    }
  }

  private extractLockPid(lockData: string): number | undefined {
    const match = lockData.match(/pid:(\d+)/);
    if (!match) return undefined;
    const pid = Number.parseInt(match[1] ?? "", 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ESRCH") {
        return false;
      }
      return true;
    }
  }

  get booksDir(): string {
    return join(this.projectRoot, "books");
  }

  bookDir(bookId: string): string {
    return join(this.booksDir, bookId);
  }

  stateDir(bookId: string): string {
    return join(this.bookDir(bookId), "story", "state");
  }

  async loadProjectConfig(): Promise<Record<string, unknown>> {
    const configPath = join(this.projectRoot, "inkos.json");
    const raw = await readFile(configPath, "utf-8");
    return JSON.parse(raw);
  }

  async saveProjectConfig(config: Record<string, unknown>): Promise<void> {
    const configPath = join(this.projectRoot, "inkos.json");
    await writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
  }

  async loadBookConfig(bookId: string): Promise<BookConfig> {
    const configPath = join(this.bookDir(bookId), "book.json");
    const raw = await readFile(configPath, "utf-8");
    if (!raw.trim()) {
      throw new Error(`book.json is empty for book "${bookId}"`);
    }
    return JSON.parse(raw) as BookConfig;
  }

  async saveBookConfig(bookId: string, config: BookConfig): Promise<void> {
    await this.saveBookConfigAt(this.bookDir(bookId), config);
  }

  async saveBookConfigAt(bookDir: string, config: BookConfig): Promise<void> {
    await mkdir(bookDir, { recursive: true });
    await writeFile(
      join(bookDir, "book.json"),
      JSON.stringify(config, null, 2),
      "utf-8",
    );
  }

  async ensureRuntimeState(bookId: string, fallbackChapter = 0): Promise<void> {
    await bootstrapStructuredStateFromMarkdown({
      bookDir: this.bookDir(bookId),
      fallbackChapter,
    });
  }

  async listBooks(): Promise<ReadonlyArray<string>> {
    try {
      const entries = await readdir(this.booksDir);
      const bookIds: string[] = [];
      for (const entry of entries) {
        const bookJsonPath = join(this.booksDir, entry, "book.json");
        try {
          await stat(bookJsonPath);
          bookIds.push(entry);
        } catch {
          // not a book directory
        }
      }
      return bookIds;
    } catch {
      return [];
    }
  }

  async getNextChapterNumber(bookId: string): Promise<number> {
    const durableChapter = await resolveDurableStoryProgress({
      bookDir: this.bookDir(bookId),
    });
    // Ensure structured state is bootstrapped (side-effect: creates missing
    // JSON files), but do NOT trust its chapter number for progress — only
    // the contiguous durable artifact chain is authoritative.
    await bootstrapStructuredStateFromMarkdown({
      bookDir: this.bookDir(bookId),
      fallbackChapter: durableChapter,
    });
    return durableChapter + 1;
  }

  private chapterReservationsPath(bookId: string): string {
    return join(this.bookDir(bookId), CHAPTER_RESERVATIONS_FILE);
  }

  private async loadChapterReservations(bookId: string): Promise<ChapterReservationsFile> {
    try {
      const raw = await readFile(this.chapterReservationsPath(bookId), "utf-8");
      const parsed = JSON.parse(raw) as { version?: unknown; reservations?: unknown };
      if (parsed.version !== 1 || !Array.isArray(parsed.reservations)) {
        return { version: 1, reservations: [] };
      }
      const reservations: ChapterReservation[] = [];
      for (const entry of parsed.reservations as Array<Record<string, unknown>>) {
        if (
          typeof entry.chapter !== "number" || !Number.isInteger(entry.chapter) || entry.chapter <= 0
          || typeof entry.pid !== "number"
          || typeof entry.startedAt !== "number"
        ) {
          continue;
        }
        reservations.push({ chapter: entry.chapter, pid: entry.pid, startedAt: entry.startedAt });
      }
      return { version: 1, reservations };
    } catch {
      return { version: 1, reservations: [] };
    }
  }

  private async saveChapterReservations(bookId: string, file: ChapterReservationsFile): Promise<void> {
    const path = this.chapterReservationsPath(bookId);
    const tmpPath = join(this.bookDir(bookId), `${CHAPTER_RESERVATIONS_FILE}.${process.pid}.${randomUUID()}.tmp`);
    try {
      await writeFile(tmpPath, `${JSON.stringify(file, null, 2)}\n`, "utf-8");
      await rename(tmpPath, path);
    } catch (error) {
      await unlink(tmpPath).catch(() => undefined);
      throw error;
    }
  }

  private isReservationStale(reservation: ChapterReservation, durableChapter: number): boolean {
    if (reservation.chapter <= durableChapter) return true; // already committed
    if (reservation.pid !== process.pid && !this.isProcessAlive(reservation.pid)) return true;
    return Date.now() - reservation.startedAt > CHAPTER_RESERVATION_LEASE_MS;
  }

  /** Allocate the next free chapter number and record a reservation. The
   * caller must hold the book's `commit` lock while calling this, so two
   * writers cannot allocate the same number. */
  async reserveNextChapterNumber(bookId: string): Promise<number> {
    const durableChapter = await resolveDurableStoryProgress({
      bookDir: this.bookDir(bookId),
    });
    const file = await this.loadChapterReservations(bookId);
    const live = file.reservations.filter((reservation) => !this.isReservationStale(reservation, durableChapter));
    const taken = new Set(live.map((reservation) => reservation.chapter));
    let next = durableChapter + 1;
    while (taken.has(next)) next += 1;
    await this.saveChapterReservations(bookId, {
      version: 1,
      reservations: [...live, { chapter: next, pid: process.pid, startedAt: Date.now() }],
    });
    return next;
  }

  /** Remove this process's reservation for a chapter (success or abort). */
  async releaseChapterReservation(bookId: string, chapterNumber: number): Promise<void> {
    const file = await this.loadChapterReservations(bookId);
    const reservations = file.reservations.filter(
      (reservation) => !(reservation.chapter === chapterNumber && reservation.pid === process.pid),
    );
    await this.saveChapterReservations(bookId, { ...file, reservations });
  }

  /** Pruned list of currently-live reservations (for diagnostics/tests). */
  async listActiveChapterReservations(bookId: string): Promise<ReadonlyArray<number>> {
    const durableChapter = await resolveDurableStoryProgress({
      bookDir: this.bookDir(bookId),
    });
    const file = await this.loadChapterReservations(bookId);
    return file.reservations
      .filter((reservation) => !this.isReservationStale(reservation, durableChapter))
      .map((reservation) => reservation.chapter)
      .sort((left, right) => left - right);
  }

  async getPersistedChapterCount(bookId: string): Promise<number> {
    const chaptersDir = join(this.bookDir(bookId), "chapters");
    const chapterNumbers = new Set<number>();

    try {
      const files = await readdir(chaptersDir);
      for (const file of files) {
        const match = file.match(/^(\d+)_.*\.md$/);
        if (!match) continue;
        chapterNumbers.add(parseInt(match[1]!, 10));
      }
    } catch {
      return 0;
    }

    return chapterNumbers.size;
  }

  async loadChapterIndex(bookId: string): Promise<ReadonlyArray<ChapterMeta>> {
    const indexPath = join(this.bookDir(bookId), "chapters", "index.json");
    try {
      const raw = await readFile(indexPath, "utf-8");
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed) && parsed.length > 0) return parsed as ReadonlyArray<ChapterMeta>;
      if (Array.isArray(parsed)) {
        const rebuilt = await this.rebuildChapterIndexFromFiles(bookId);
        return rebuilt.length > 0 ? rebuilt : parsed as ReadonlyArray<ChapterMeta>;
      }
    } catch {
      const rebuilt = await this.rebuildChapterIndexFromFiles(bookId);
      if (rebuilt.length > 0) return rebuilt;
    }
    return [];
  }

  private async rebuildChapterIndexFromFiles(bookId: string): Promise<ReadonlyArray<ChapterMeta>> {
    return this.rebuildChapterIndexFromFilesAt(this.bookDir(bookId));
  }

  private async rebuildChapterIndexFromFilesAt(bookDir: string): Promise<ReadonlyArray<ChapterMeta>> {
    const chaptersDir = join(bookDir, "chapters");
    let files: string[];
    try {
      files = await readdir(chaptersDir);
    } catch {
      return [];
    }

    const rows = await Promise.all(files.flatMap(async (file) => {
      const match = file.match(/^(\d+)[_-]?(.*?)\.md$/);
      if (!match) return [];
      const number = parseInt(match[1]!, 10);
      if (!Number.isFinite(number) || number <= 0) return [];
      const filePath = join(chaptersDir, file);
      const [metadata, content] = await Promise.all([
        stat(filePath).catch(() => null),
        readFile(filePath, "utf-8").catch(() => ""),
      ]);
      const timestamp = (metadata?.mtime ?? new Date()).toISOString();
      const rawTitle = match[2]?.replace(/^_+/, "").replace(/_/g, " ").trim();
      return [{
        number,
        title: rawTitle || `第${number}章`,
        status: "ready-for-review" as const,
        wordCount: content.replace(/\s+/g, "").length,
        createdAt: timestamp,
        updatedAt: timestamp,
        auditIssues: [],
        lengthWarnings: [],
      }];
    }));

    return rows
      .flat()
      .sort((a, b) => a.number - b.number);
  }

  async saveChapterIndex(
    bookId: string,
    index: ReadonlyArray<ChapterMeta>,
    options: { readonly allowEmptyWithChapterFiles?: boolean } = {},
  ): Promise<void> {
    await this.saveChapterIndexAt(this.bookDir(bookId), index, options);
  }

  async saveChapterIndexAt(
    bookDir: string,
    index: ReadonlyArray<ChapterMeta>,
    options: { readonly allowEmptyWithChapterFiles?: boolean } = {},
  ): Promise<void> {
    const chaptersDir = join(bookDir, "chapters");
    await mkdir(chaptersDir, { recursive: true });
    const safeIndex = index.length === 0 && !options.allowEmptyWithChapterFiles
      ? await this.rebuildChapterIndexFromFilesAt(bookDir).then((rebuilt) => rebuilt.length > 0 ? rebuilt : index)
      : index;
    const indexPath = join(chaptersDir, "index.json");
    const tmpPath = join(chaptersDir, `index.json.${process.pid}.${randomUUID()}.tmp`);
    try {
      await writeFile(tmpPath, JSON.stringify(safeIndex, null, 2), "utf-8");
      await rename(tmpPath, indexPath);
    } catch (error) {
      await unlink(tmpPath).catch(() => undefined);
      throw error;
    }
  }

  async snapshotState(bookId: string, chapterNumber: number): Promise<void> {
    await this.snapshotStateAt(this.bookDir(bookId), chapterNumber);
  }

  async snapshotStateAt(bookDir: string, chapterNumber: number): Promise<void> {
    const storyDir = join(bookDir, "story");
    const snapshotDir = join(storyDir, "snapshots", String(chapterNumber));
    await mkdir(snapshotDir, { recursive: true });

    const files = [
      "current_state.md", "particle_ledger.md", "pending_hooks.md",
      "chapter_summaries.md", "subplot_board.md", "emotional_arcs.md", "character_matrix.md",
    ];
    await Promise.all(
      files.map(async (f) => {
        try {
          const content = await readFile(join(storyDir, f), "utf-8");
          await writeFile(join(snapshotDir, f), content, "utf-8");
        } catch {
          // file doesn't exist yet
        }
      }),
    );

    const stateDir = join(bookDir, "story", "state");
    const snapshotStateDir = join(snapshotDir, "state");
    try {
      const stateFiles = await readdir(stateDir);
      if (stateFiles.length > 0) {
        await mkdir(snapshotStateDir, { recursive: true });
        await Promise.all(
          stateFiles.map(async (fileName) => {
            const content = await readFile(join(stateDir, fileName), "utf-8");
            await writeFile(join(snapshotStateDir, fileName), content, "utf-8");
          }),
        );
      }
    } catch {
      // state directory missing — skip
    }
  }

  async isCompleteBookDirectory(bookDir: string): Promise<boolean> {
    // Phase 5 cleanup: prefer outline/* paths, fall back to legacy flat files
    // so older books on disk still resolve as complete.
    const requiredSingle = [
      join(bookDir, "book.json"),
      join(bookDir, "story", "book_rules.md"),
      join(bookDir, "story", "current_state.md"),
      join(bookDir, "story", "pending_hooks.md"),
      join(bookDir, "chapters", "index.json"),
    ];

    const eitherOr: Array<ReadonlyArray<string>> = [
      // story_frame (new) OR story_bible (legacy)
      [
        join(bookDir, "story", "outline", "story_frame.md"),
        join(bookDir, "story", "story_bible.md"),
      ],
      // volume_map (new) OR volume_outline (legacy)
      [
        join(bookDir, "story", "outline", "volume_map.md"),
        join(bookDir, "story", "volume_outline.md"),
      ],
    ];

    for (const requiredPath of requiredSingle) {
      try {
        await stat(requiredPath);
      } catch {
        return false;
      }
    }

    for (const alternatives of eitherOr) {
      let found = false;
      for (const candidate of alternatives) {
        try {
          await stat(candidate);
          found = true;
          break;
        } catch {
          // try next alternative
        }
      }
      if (!found) return false;
    }

    return true;
  }

  async restoreState(bookId: string, chapterNumber: number): Promise<boolean> {
    const storyDir = join(this.bookDir(bookId), "story");
    const snapshotDir = join(storyDir, "snapshots", String(chapterNumber));

    const files = [
      "current_state.md", "particle_ledger.md", "pending_hooks.md",
      "chapter_summaries.md", "subplot_board.md", "emotional_arcs.md", "character_matrix.md",
    ];
    try {
      // current_state.md and pending_hooks.md are required;
      // particle_ledger.md is optional (numericalSystem=false genres don't have it)
      // the rest are optional (may not exist in older snapshots)
      const requiredFiles = ["current_state.md", "pending_hooks.md"];
      const optionalFiles = files.filter((f) => !requiredFiles.includes(f));

      await Promise.all(
        requiredFiles.map(async (f) => {
          const content = await readFile(join(snapshotDir, f), "utf-8");
          await writeFile(join(storyDir, f), content, "utf-8");
        }),
      );

      await Promise.all(
        optionalFiles.map(async (f) => {
          const targetPath = join(storyDir, f);
          try {
            const content = await readFile(join(snapshotDir, f), "utf-8");
            await writeFile(targetPath, content, "utf-8");
          } catch {
            await rm(targetPath, { force: true });
          }
        }),
      );

      const stateDir = this.stateDir(bookId);
      let restoredStructuredState = false;
      try {
        const snapshotStateDir = join(snapshotDir, "state");
        const stateFiles = await readdir(snapshotStateDir);
        if (stateFiles.length > 0) {
          restoredStructuredState = true;
          await mkdir(stateDir, { recursive: true });
          await Promise.all(
            stateFiles.map(async (fileName) => {
              const content = await readFile(join(snapshotStateDir, fileName), "utf-8");
              await writeFile(join(stateDir, fileName), content, "utf-8");
            }),
          );
        }
      } catch {
        // snapshot structured state missing — skip
      }
      if (!restoredStructuredState) {
        await rm(stateDir, { recursive: true, force: true });
      }

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Roll back state to the snapshot at `targetChapter`, removing all chapters
   * after it and their associated files (chapter markdown, snapshots, runtime).
   * Used by review reject to undo a bad chapter and everything that followed.
   *
   * Returns the list of chapter numbers that were discarded.
   */
  async rollbackToChapter(
    bookId: string,
    targetChapter: number,
  ): Promise<ReadonlyArray<number>> {
    const restored = await this.restoreState(bookId, targetChapter);
    if (!restored) {
      throw new Error(`Cannot restore snapshot for chapter ${targetChapter} in "${bookId}"`);
    }

    const bookDir = this.bookDir(bookId);
    const chaptersDir = join(bookDir, "chapters");
    const index = await this.loadChapterIndex(bookId);

    const kept: ChapterMeta[] = [];
    const discarded: number[] = [];

    for (const entry of index) {
      if (entry.number <= targetChapter) {
        kept.push(entry);
      } else {
        discarded.push(entry.number);
      }
    }

    // Delete chapter markdown files for discarded chapters
    try {
      const files = await readdir(chaptersDir);
      for (const file of files) {
        const match = file.match(/^(\d+)_.*\.md$/);
        if (!match) continue;
        const num = parseInt(match[1]!, 10);
        if (num > targetChapter) {
          await unlink(join(chaptersDir, file)).catch(() => {});
        }
      }
    } catch {
      // chapters directory missing
    }

    // Delete snapshots for discarded chapters
    const snapshotsDir = join(bookDir, "story", "snapshots");
    try {
      const snapshots = await readdir(snapshotsDir);
      for (const snap of snapshots) {
        const num = parseInt(snap, 10);
        if (Number.isFinite(num) && num > targetChapter) {
          await rm(join(snapshotsDir, snap), { recursive: true, force: true });
        }
      }
    } catch {
      // snapshots directory missing
    }

    // Delete runtime artifacts for discarded chapters
    const runtimeDir = join(bookDir, "story", "runtime");
    try {
      const runtimeFiles = await readdir(runtimeDir);
      for (const file of runtimeFiles) {
        const match = file.match(/^chapter-(\d+)\./);
        if (!match) continue;
        const num = parseInt(match[1]!, 10);
        if (num > targetChapter) {
          await unlink(join(runtimeDir, file)).catch(() => {});
        }
      }
    } catch {
      // runtime directory missing
    }

    // Also check story/drafts/ for discarded chapter files
    const draftsDir = join(bookDir, "story", "drafts");
    try {
      const draftFiles = await readdir(draftsDir);
      for (const file of draftFiles) {
        const match = file.match(/^(\d+)_.*\.md$/);
        if (!match) continue;
        const num = parseInt(match[1]!, 10);
        if (num > targetChapter) {
          await unlink(join(draftsDir, file)).catch(() => {});
        }
      }
    } catch {
      // drafts directory missing
    }

    // Drop any persisted sqlite acceleration index so discarded chapters
    // cannot leak back into retrieval after the markdown/state rollback.
    await Promise.all([
      rm(join(bookDir, "story", "memory.db"), { force: true }),
      rm(join(bookDir, "story", "memory.db-shm"), { force: true }),
      rm(join(bookDir, "story", "memory.db-wal"), { force: true }),
    ]);

    await this.saveChapterIndex(bookId, kept);
    return discarded;
  }

  private async writeIfMissing(path: string, content: string): Promise<void> {
    try {
      await stat(path);
    } catch {
      await writeFile(path, content, "utf-8");
    }
  }
}
