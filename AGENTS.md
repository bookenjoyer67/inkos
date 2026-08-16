# AGENTS.md — InkOS fork design & contribution notes

Notes for any agent or human working in this repo. These are observations from real
usage of the Surge project on the homelab deployment, captured as contribution
candidates. Nothing here is committed or pushed without explicit permission.

## Known UX gaps observed in real use

These three issues compound and are the primary reasons interactive Studio use
feels broken:

1. **Session desync on refresh.**
   When a prompt is in flight and the page is refreshed, the response dies before
   inkos writes a completion marker to the session log. The tool actions already
   executed land on disk (chapter/state files are genuinely updated), but the chat
   UI renders from session events — and those events never got their `completed`
   flag — so the chat shows empty even though the work happened. The prompt text
   itself IS preserved in `.inkos/sessions/*.jsonl`.

2. **Whole-book write lock blocks parallel work.**
   Every write job takes a per-book lock (`.write.lock`, shared process-wide via
   `processBookLocks` in `state/manager.ts`). While a task holds it, any other
   write on the SAME book fails with `BOOK_BUSY`. The lock is the entire book, not
   a chapter/scene, so one long task blocks ALL other writing on that book. With a
   slow model this locks the user out for a long time with nothing to do.

3. **No mid-flight visibility.**
   The Studio server logs stage names only (`[studio] Stage: revising chapter 1`),
   and buffers the model's streamed output in memory — it writes to disk (chapter,
   session file, log) only when the turn completes. So while a long generation
   runs, both the log and the UI are silent. There is no persistent "what job is
   running now" indicator that survives a refresh.

## Model config caveat

DeepSeek v4 is a slow reasoning model (~10 min per chapter; single turns have been
seen streaming 40 MB+ before producing visible output). This is the underlying
trigger for the refresh problem and the lockout. When using this fork, consider a
faster model or a capped reasoning budget for interactive use.

## Suggested directions (not yet implemented)

- Finer-grained locking (per chapter / per file) instead of whole book, so a long
  revision of ch1 doesn't block editing ch2 or writing ch3.
- A job queue so multiple jobs can be submitted and run in sequence instead of
  being rejected with `BOOK_BUSY`.
- A persistent "active job" indicator that reads task state from disk and survives
  refresh (backend endpoint + frontend banner polling it), so users aren't confused
  into button-mashing.

## Where things live

- Local fork: `~/inkos` (Surge novel project).
- Homelab deployment: `/opt/inkos` on `minecraft` (192.168.1.100), Studio on
  port 4567 (LAN only, no auth). DeepSeek key in `/root/.inkos/.env` and
  `/opt/inkos/.inkos/secrets.json`. Service: openrc `inkos`, binary at
  `/usr/local/bin/inkos`, logs `/var/log/inkos-studio.log`.
