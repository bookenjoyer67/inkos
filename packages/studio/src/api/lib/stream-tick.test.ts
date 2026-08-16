import { describe, expect, it } from "vitest";
import { formatStreamProgressTick, stripStagePrefix } from "./stream-tick";

describe("formatStreamProgressTick", () => {
  it("formats like the CLI tick line", () => {
    expect(
      formatStreamProgressTick({ status: "streaming", elapsedMs: 210_000, totalChars: 18432, chineseChars: 13204 }),
    ).toBe("streaming 210s, 18432 chars (13204 CJK)");
  });

  it("appends task and session ids when present", () => {
    expect(
      formatStreamProgressTick(
        { status: "streaming", elapsedMs: 60_500, totalChars: 1024, chineseChars: 512 },
        { taskId: "direct-write_next-abc", sessionId: "session-1" },
      ),
    ).toBe("streaming 61s, 1024 chars (512 CJK) [task=direct-write_next-abc, session=session-1]");
  });

  it("appends the stage without its localized prefix", () => {
    expect(
      formatStreamProgressTick(
        { status: "streaming", elapsedMs: 1000, totalChars: 10, chineseChars: 10 },
        { taskId: "t", stage: "阶段：撰写章节草稿" },
      ),
    ).toBe("streaming 1s, 10 chars (10 CJK) [task=t, stage=撰写章节草稿]");
    expect(
      formatStreamProgressTick(
        { status: "streaming", elapsedMs: 1000, totalChars: 10, chineseChars: 10 },
        { stage: "Stage: writing chapter draft" },
      ),
    ).toBe("streaming 1s, 10 chars (10 CJK) [stage=writing chapter draft]");
  });

  it("rounds sub-second runs up to at least zero seconds", () => {
    expect(formatStreamProgressTick({ status: "done", elapsedMs: 0, totalChars: 0, chineseChars: 0 })).toBe(
      "streaming 0s, 0 chars (0 CJK)",
    );
  });
});

describe("stripStagePrefix", () => {
  it("strips only the known stage prefixes", () => {
    expect(stripStagePrefix("Stage: auditing draft")).toBe("auditing draft");
    expect(stripStagePrefix("阶段：审计草稿")).toBe("审计草稿");
    expect(stripStagePrefix("some other message")).toBe("some other message");
  });
});
