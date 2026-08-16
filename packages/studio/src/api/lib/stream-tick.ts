export interface StreamProgressLike {
  readonly status: string;
  readonly elapsedMs: number;
  readonly totalChars: number;
  readonly chineseChars: number;
}

export interface StreamTickContext {
  readonly taskId?: string;
  readonly sessionId?: string;
  readonly stage?: string;
}

const STAGE_PREFIXES = ["Stage: ", "阶段："] as const;

export function stripStagePrefix(message: string): string {
  for (const prefix of STAGE_PREFIXES) {
    if (message.startsWith(prefix)) return message.slice(prefix.length);
  }
  return message;
}

export function formatStreamProgressTick(progress: StreamProgressLike, ctx?: StreamTickContext): string {
  const elapsedSec = Math.max(0, Math.round(progress.elapsedMs / 1000));
  let line = `streaming ${elapsedSec}s, ${progress.totalChars} chars (${progress.chineseChars} CJK)`;
  const details: string[] = [];
  if (ctx?.taskId) details.push(`task=${ctx.taskId}`);
  if (ctx?.sessionId) details.push(`session=${ctx.sessionId}`);
  if (ctx?.stage) details.push(`stage=${stripStagePrefix(ctx.stage)}`);
  if (details.length > 0) line += ` [${details.join(", ")}]`;
  return line;
}
