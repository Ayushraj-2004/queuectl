# queuectl

A CLI-based background job queue system with worker processes, automatic
retries with exponential backoff, and a Dead Letter Queue (DLQ) for
permanently failed jobs.

Built for the Flam Backend Developer internship assignment.

## Setup

Requires Node.js 18+.

```bash
git clone <this-repo-url>
cd queuectl
npm install
npm link          # makes `queuectl` available as a global command
```

Everything queuectl needs (the SQLite DB, worker PID tracking, worker logs)
lives under a `.queuectl/` directory created in whatever folder you run it
from — same idea as `.git`. Nothing is installed system-wide.

If you'd rather not `npm link`, replace `queuectl` with
`node /path/to/queuectl/bin/queuectl.js` in every example below.

## Usage examples

```bash
$ queuectl enqueue '{"id":"job1","command":"echo Hello World"}'
Enqueued job "job1" (state=pending)

$ queuectl enqueue '{"id":"job2","command":"sleep 2"}'
Enqueued job "job2" (state=pending)

$ queuectl worker start --count 3
Started 3 worker(s): 4821, 4822, 4823
Workers run detached in the background; logs are in .queuectl/logs/

$ queuectl status
Job states:
  pending    0
  processing 0
  completed  2
  failed     0
  dead       0
Active workers: 3 (4821, 4822, 4823)

$ queuectl list --state completed
job1            state=completed  attempts=0/3  echo Hello World
job2            state=completed  attempts=0/3  sleep 2

$ queuectl dlq list
DLQ is empty.

$ queuectl config set max-retries 5
Set max-retries = 5

$ queuectl worker stop
Sent SIGTERM to 3 worker(s): 4821, 4822, 4823
Each will finish its current job before exiting.
```

A job that fails and exhausts its retries:

```bash
$ queuectl enqueue '{"id":"bad1","command":"exit 1","max_retries":2}'
$ queuectl worker start --count 1
# ... time passes, retries happen with backoff ...
$ queuectl dlq list
bad1            attempts=2  last_error="Command failed: exit 1"

$ queuectl dlq retry bad1
Job "bad1" requeued (state=pending)
```

## Architecture overview

### Job lifecycle

```
pending --(worker claims it)--> processing --(exit code 0)--> completed
                                     |
                                     +--(non-zero exit / cmd not found)--> failed*
                                                                              |
                                            attempts < max_retries? -----> pending (after backoff delay)
                                            attempts >= max_retries? ----> dead (DLQ)
```

`failed*` isn't actually a distinct row state that lingers — a failure is
resolved immediately into either `pending` (with a future `run_at`) or
`dead`. There's no window where a job sits visibly in `failed`; it's really
a transition, not a resting state.

### Storage: SQLite via `better-sqlite3`, not a JSON file

This is the load-bearing decision for the whole "no duplicate processing"
requirement. Two workers are separate OS processes with no shared memory,
so preventing them from both grabbing the same job means the *claim* itself
has to be atomic across process boundaries. A JSON file gives you no such
primitive for free — you'd have to write your own cross-process file lock
and get it exactly right.

SQLite already serializes writers at the file level. So the claim is a
single UPDATE statement:

```sql
UPDATE jobs
SET state = 'processing', locked_by = @workerId, updated_at = @now
WHERE id = (
  SELECT id FROM jobs
  WHERE state = 'pending' AND (run_at IS NULL OR run_at <= @now)
  ORDER BY created_at ASC LIMIT 1
)
AND state = 'pending'
```

Because the SELECT-and-UPDATE happens as one statement, not two round
trips, there's no gap for a second worker to sneak in and claim the same
row. If worker B's UPDATE runs after worker A's has already committed,
worker B's `WHERE state = 'pending'` no longer matches anything —
`changes === 0` — and worker B correctly finds no work. No mutex, no
lockfile, no distributed lock service. The DB is in WAL (Write-Ahead
Logging) mode with a 5s `busy_timeout`, so contending writers queue and
retry instead of erroring.

This was verified directly: `test/test-flows.sh` runs 4 concurrent worker
processes against 15 jobs, each job appending its own id to a shared log
file on execution, and asserts zero duplicate lines.

### Workers are real processes, not async tasks

`worker start --count N` spawns N independent `node` processes
(`child_process.spawn`, detached, PID tracked in `.queuectl/workers.pid`).
This matters because JS's async concurrency within one process is
cooperative, not preemptive — testing "duplicate processing" against
Promises in one process wouldn't actually exercise the failure mode the
assignment is worried about. Separate OS processes with separate DB
connections do.

Each worker logs to its own file under `.queuectl/logs/` (not inherited
stdio) — a detached process inheriting the parent's stdio keeps that file
descriptor open for its whole lifetime, which would hang anything waiting
on the parent CLI's output stream to close (a shell pipeline, a CI runner).

### Backoff

`delay = base ^ attempts` seconds, exactly as specified. Implemented not as
a `setTimeout`/sleep but as a `run_at` timestamp written on the job row;
the claim query's `WHERE run_at <= @now` is what actually enforces the
wait. This means backoff survives worker restarts — a job scheduled to
retry in 8 seconds is still not eligible if the original worker died and a
new one starts up 3 seconds later.

### Graceful shutdown

`worker stop` sends `SIGTERM` to every tracked worker PID. Each worker's
main loop is: claim → execute (synchronously, via `execSync`) → repeat.
Because job execution is synchronous, a signal arriving mid-job is only
handled by Node once the current `execSync` call returns — so a worker
never abandons a job partway through; it always finishes what it's
running, then exits on the next loop check. It does not claim a new job
after the shutdown flag is set.

### Crash recovery (orphaned jobs)

A graceful `worker stop` always resolves a job to a terminal-ish state
before the process exits. A **hard** kill (`kill -9`, OOM, host crash)
does not — the job is left sitting in `processing` forever, since nothing
else knows to reclaim it. I added a small reaper (`reapStaleJobs`) that
runs on every worker startup: any job still `processing` with an
`updated_at` older than 5 minutes is put back to `pending`. This was
validated by manually `kill -9`-ing a worker mid-job and confirming the
next worker startup requeues it (see Assumptions & Trade-offs for the
staleness-threshold caveat).

### Config

`config set max-retries 3` / `config set backoff-base 2` write to a
`config` table and become the *default* applied to jobs enqueued without
an explicit `max_retries`/`backoff_base` in their JSON. Each job still
carries its own `max_retries`/`backoff_base` on its row (per the required
job schema), so changing config doesn't retroactively affect
already-enqueued jobs — only future ones.

## Assumptions & trade-offs

- **Single-machine, single-directory scope.** `.queuectl/` is relative to
  the current working directory, like `.git`. Running `queuectl` from two
  different directories gives you two independent queues. This wasn't
  specified either way, so I kept it simple rather than adding a
  `--data-dir` flag or a daemon.
- **Poll-based claiming, not push-based.** Workers poll every 500ms when
  idle rather than being notified of new jobs. Simpler and sufficient at
  this scale; a production system with high throughput would want
  something event-driven (e.g. `LISTEN/NOTIFY` in Postgres) instead of
  polling.
- **Stale-job reaper uses a fixed 5-minute threshold**, not a heartbeat.
  A job that's still legitimately running past 5 minutes would incorrectly
  get requeued and potentially double-executed. I chose this over building
  a heartbeat mechanism because the assignment's example jobs are all
  short-lived (`sleep 2`, `echo hello`); a real system would want workers
  to periodically touch `updated_at` while a long job is in flight, and
  the reaper threshold would be based on that heartbeat instead.
- **Command failure detection is exit-code-based only.** stdout is not
  captured for the job record (stderr is, for `last_error`), since the
  spec only asks for success/failure via exit code.
- **`worker stop` doesn't block until workers have actually exited** — it
  sends SIGTERM and returns immediately. Re-run `queuectl status` a moment
  later to confirm `Active workers: 0`. I chose this over a blocking wait
  so the CLI stays responsive even if a worker is mid-way through a long
  job.
- **Scheduled jobs (`run_at`) are supported at the storage layer** (every
  job has a `run_at` column, defaulting to "now") but there's no CLI flag
  to set a future one yet — this was one of the optional bonus features
  and I prioritized the required robustness/testing work given the
  deadline.

## Testing instructions

```bash
npm test
# or directly:
bash test/test-flows.sh
```

This runs all 5 scenarios the assignment calls out, end to end, against a
real temp directory and real SQLite file (not mocked):

1. Basic job completes successfully
2. Failed job retries with backoff, then moves to DLQ
3. 4 concurrent workers process 15 jobs with zero duplicate claims
   (this is the concurrency/locking correctness check)
4. An invalid/nonexistent command fails gracefully and reaches the DLQ
   without crashing a worker
5. Job data survives a fresh CLI process reading the same `.queuectl/` dir
   (simulating a restart)

Each assertion is a real behavioral check (grep-ing actual CLI output,
counting actual file lines), not a unit test against mocked internals —
given the assignment's emphasis on robustness and concurrency, I wanted
the tests to catch the actual race-condition class of bug, not just
confirm functions return the right type.

## Demo

<!-- Add your recorded CLI demo link here before submitting -->

## Project structure

```
queuectl/
  bin/queuectl.js       # CLI entrypoint (commander) — thin, wires flags to src/
  src/
    db.js                # SQLite connection, schema, WAL mode
    config.js             # config table get/set
    backoff.js             # delay = base^attempts
    jobStore.js             # enqueue, atomic claim, state transitions, DLQ, reaper
    worker.js                # worker process: poll loop, execution, graceful shutdown
    workerManager.js          # spawns/stops worker processes, PID tracking
  test/test-flows.sh          # end-to-end scenario tests
```
