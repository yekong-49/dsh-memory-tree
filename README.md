# dsh-memory-tree

Cross-session memory for DeepSeek Harness agents, as a **lazily grown,
time-layered tree** on disk.

The tree's normative spec lives in the tree itself: **`<MEMORY_ROOT>\index.md`**.
This README explains the plugin; that file explains the memory.

```
index.md                                   ← root entry: structure + read protocol (human/agent maintained
longterm.md                                ← one line per year            (highest level)
<年>/<年>.md                                ← one line per month of a year
<年>/<月>/<年>-<月>.md                      ← one line per day of a month
<年>/<月>/<日>/<年>-<月>-<日>.md            ← day: prose summary + snapshot index + per-turn log
<年>/<月>/<日>/<时间>-<触发>-<会话>.md       ← the verbatim slice                 (authoritative)
```

Drilling down one level at a time is what keeps recall cheap: every level
except the last costs tens of tokens, and only reading a snapshot can cost
thousands. The higher levels are **lossy by design**; the snapshot is verbatim,
so any summary can always be checked against the original.

## What it does

| | |
|---|---|
| **Every turn** | appends ONE mechanical line — `时间 \| 轮次 \| Δtoken \| 改动的文件 \| 一句话`. Zero model calls: derived from session events already in memory. |
| **On context pressure** | at `totalTokens ≥ 500k` (the harness compacts at 80% of 1M = 800k), writes a snapshot and refreshes all four summary levels. |
| **On compaction** | when the harness compacts — detected from the durable **`compaction/start`** event it appends *before* summarizing and replacing the surface, with the surface generation as a secondary signal. |
| **On demand** | `memory_snapshot`. |
| **Every N turns** | optional, off by default. |

`compaction` and `manual` deliberately **bypass** the automatic cooldown: both are
hard boundaries, and compaction detection is incremental (one schedule per real
event), so nothing can storm.

### Why a snapshot is always complete

Compaction never takes events away from this plugin. The session's durable log is
**append-only** — `session.snapshotEvents()` returns `[...session.log]` — while
compaction only rewrites the **surface**: the derived view the model sees, marked
by a `replace` op and reported as `surface.replaceGeneration`.

So the save is complete regardless of *when* it happens:

* the slice is built from the log, not the surface, so shadowed history is still there;
* the coverage window (`fromSeq`/`toSeq`) is over log positions, which are never
  reused or renumbered;
* `maxSliceBytes` (4 MB) is therefore a safety valve against a pathological file,
  **not** a per-session limit — and each snapshot only covers events since the
  previous one.

A useful consequence: a snapshot taken after a compaction also captures the
harness's own `compaction/start` / `compaction/end` / `compaction/summary` events
and its checkpoint message — so the tree records *that* a compaction happened and
what the harness summarized, verbatim, right next to our own summary.

Noticing a compaction a step "late" therefore costs nothing. Detecting it from the
durable event rather than a private surface field also means the trigger still
works for a compaction performed by something other than the built-in backend.

### Two model calls per snapshot

```
call 1   the verbatim slice + the recent entries             → THIS slice's one-liner
                                                               + NEW day entries (a delta)
call 2   the whole day's entries + this month's other days
         + this year's months + every year                   → day + month + year + long-term
```

Each level's input is only the level below it, so the upper call stays tiny no
matter how long the day was. Splitting it into more calls would multiply
snapshot latency for no extra information.

**Three one-liners, three different jobs, and they must not be conflated:**

| line | written by | describes | lives in |
|---|---|---|---|
| the slice's | call 1 | what THIS snapshot covered | the snapshot's header → its row in the day's index |
| the day's | call 2 | the whole day | the day file's `summary:` |
| the month's / year's / long-term | call 2 | that whole unit | those files' `summary:` |

The first two were briefly the same line, and the result was visibly wrong: every
new row in the day's snapshot index repeated the day's summary verbatim, so the
index — the thing a day is navigated BY — stopped indexing anything. The fix is
not cosmetic. Call 1 is the only call that can see one slice, so it is the only
call that can describe one.

**Why the day's line belongs to call 2.** Call 1 asks *what happened since last
time*; its answer is appended to the day's log and can therefore never remove
anything. Call 2 asks *what was this day, all of it*; its answer replaces one
index line, which is safe **only** because what it summarises is the permanent
entry list one level down, so it can be recomputed from the whole day every time.

The model's **only** durable output is those gists plus the day's entries. It
never writes a roll-up row: every roll-up is re-derived from the filesystem
(`tree.js`), which is what makes recomputation idempotent and self-healing.

### Each level must let you READ its child, not just name it

The month file is not a table. It has one block per day — `### 13 日 · 2026-09-13`
— and inside that block it reproduces **that day's own entries, verbatim**.

It used to be a table with one 60-character line per day, and that line was a
rewrite of the model's previous answer. So drilling long-term → year → month
landed on a row that could name a day but not show it, and what it did show was
whatever had happened most recently: a day that began by building a
computer-control plugin read as a day spent editing these docs.

The year and the long-term levels stay **one line per child**. That is the
owner's call and it is a real distinction, not an oversight: those two exist to
locate a month or a year, while the month exists to tell you what a day
contained. The practical cost is that a month file grows with the month — it is
the sum of its days' entries — so `memory_read`'s `maxChars` matters there in a
way it does not at the levels above.

**A level that can only answer "what is this called" is a signpost, not a
level**, and the tree is meant to be walked downward, not through signposts.

### The day's log can only grow

Each snapshot may only **add** entries to the day's region. Earlier entries are
re-emitted straight from a parse, so no later model answer can shorten the day.

This replaced a single prose blob that every snapshot REPLACED with the model's
newest answer. The prompt said to prioritise the latest progress, and the model
obeyed: a day that began by building a plugin ended up described by its last hour
alone, and the beginning was gone — not compressed, gone. Worse, the same line
cascaded: the day's `summary:` fed the month's row, which fed the year's row,
which fed `longterm.md`, so all four levels collapsed onto whatever happened most
recently. Three separate mechanisms keep that from coming back:

* **Entries are appended, never rewritten** (`appendDayEntries`). Rewriting the
  region goes through a parse → render pair, so an append cannot lose an entry.
* **Each level's line is recomputed from its whole child unit**, not carried
  forward from the model's last answer.
* **A pre-log day file is migrated, not converted.** Its prose moves verbatim
  below `<!-- legacy-summary:begin -->` on the first append. Text is not deleted
  to make room for a format that exists to stop text being deleted.

The one way an append-only log can still rot is a model that echoes the recent
entries it was shown, so duplicates are suppressed by normalized comparison. The
guard deliberately errs toward **keeping**: a restatement that adds information
is recorded, because dropping a real event is the failure this design exists to
prevent.

| Bound | Default | Why |
|---|---|---|
| `dayEntryMax` | 8 | what ONE snapshot may contribute; the rest are counted as `dropped` in the report. It was 4 until the first live run after the rewrite had a 389-event slice produce six legitimate entries and dropped two of them — a cap that discards real events is the failure this design exists to prevent, so it guards against a runaway answer rather than rationing a busy day. |
| `dayEntryChars` | 400 | per-entry cap |
| `dayEntryRecent` | 12 | how many recent entries are shown to call 1 so it can avoid repeating itself |

## Four regions, four contracts

Each node file separates machine-owned text from hand-written text with
sentinel comments. **Nothing outside a region is ever touched.**

| Region | Mutability | Source |
|---|---|---|
| `MACHINE ROLLUP` | replaced wholesale | the filesystem: child nodes, their `summary:`, their snapshot counts, and — in a month file — each day's own entries |
| `DAY SUMMARY` | **append-only** | the model's event entries for that day, each stamped with the snapshot's clock |
| `TURN LOG` | **append-only** | one row per turn, derived mechanically |
| `MEDIA` | replaced whenever the day's images change | the `media/` directory listing |

Because `MACHINE ROLLUP` and `MEDIA` are pure functions of tree truth, a row lost
to a crash **comes back** on the next snapshot or the next image instead of being
carried forward — verified by `test/tree.mjs` and `test/service.mjs`. Because
`DAY SUMMARY` and `TURN LOG` are append-only, the day's account and the
individual turns are durable even though they are not reconstructable.

### Images live beside their day

An image that enters the conversation — a `computer_screenshot`, or any picture
pasted in — is copied into the day it belongs to and indexed:

```
<MEMORY_ROOT>\<yyyy>\<mm>\<dd>\
├── 2026-09-13.md
├── 2026-09-13T051047-compaction-deadbeef.md
└── media\
    └── 2026-09-13T062501-T57-deadbeef-c0ffee00.png
          ↑date-time     ↑turn ↑session   ↑sha256[:8]
```

Three decisions worth knowing:

* **The name carries the whole provenance.** Time first, so lexicographic order
  is chronological like every other file in the tree; then the turn, the session
  token, and the first 8 hex digits of the image's own sha256. Moved out of its
  directory, the file still says which conversation and which turn it came from.
* **The index links rather than embeds.** The day file stays readable as plain
  text and an image is one click away, instead of dragging megabytes of base64
  into every read of the node.
* **Deduplication is by sha256 prefix across the day.** The attachment store is
  content-addressed, so the same screenshot committed twice is the same image and
  should not occupy two files; one image mentioned by three turns costs one file
  and three index rows.

Archiving never costs a turn its log line: it runs **after** the row is
committed, and a store that throws is absorbed rather than propagated.

### The tree also holds the escape hatch

`_bootstrap/` inside the tree root is a **disaster-recovery bundle**: real copies
of every plugin's source, the agent preset, the skills, the rule files,
the helper scripts, and — separately — the **install state** (the profile's
`package.json` / `cordis.patch.yml` and the global `settings.yaml`).

Two decisions there are load-bearing:

* **It lives in the tree, and its code lives in this plugin.** A workspace
  switch takes the workspace files and may take `~/.dsh` with it; the tree is the
  only path this deployment chose for itself. An earlier version of this was a
  script under the workspace, which works right up until the workspace is the
  thing that disappeared. the generator script survives only as a thin
  shell over `lib/backup.js`.
* **Source and install state are recorded separately**, because restoring one
  without the other gives you files that do nothing.

Every entry is verified by SHA-256 after writing. That catches a copy that
FAILED — full disk, permissions, silent truncation — but not a source that was
already wrong, since the destination is overwritten from it. It is redundancy,
not validation.

## Rules the implementation enforces

* **Lazy creation.** A directory or file appears only when it has content.
  Never pre-created, never deleted, no gap filling — a day with no activity
  gets no directory. `index.md` is never created or rewritten by the plugin.
* **Idempotent by construction.** Snapshots record the event range they cover
  (`fromSeq`/`toSeq`), so the next snapshot starts where the last ended.
  Re-running after a crash neither loses events nor accounts for them twice.
* **The coverage window is per session.** `fromSeq`/`toSeq` are offsets into
  one session's log, so two sessions working on the same day each get their own
  window. (Treating the day as one shared window made session B silently skip
  its own early events — a bug the test suite caught.)
* **Durable before lossy.** The snapshot is written *before* any model call, so
  a failed summarization costs prose, never the original text.
* **Atomic writes.** Temp file + rename, with retries for a transient Windows
  sharing violation. Templates are created with an exclusive open, so two
  sessions racing into the same day cannot both write a header.
* **Concurrency.** A per-path mutex serializes read-modify-write cycles;
  appends open-append-close; roll-ups recompute from truth.
* **Permanent retention.** Nothing is ever deleted or aged out.
* **Sensitive literals never enter the tree.** The tree is append-only, so "written
  once" is "there forever" — which makes the *write* the only moment where removing a
  value is still possible. `lib/redact.js` therefore scrubs three shapes before any
  byte reaches the disk, at the single choke point in `lib/atomic.js` (used by every
  writer, including the mechanical turn log, which no model ever sees):

  | Shape | Marker |
  |---|---|
  | 32 consecutive hex digits (QQ openid / peerId) | `[REDACTED]` |
  | routable IPv4 | `[REDACTED-IP]` |
  | `sk-…` API key | `[REDACTED-KEY]` |

  Loopback, `0.0.0.0` and the RFC1918 ranges are **kept on purpose** — they carry
  meaning here (the cloud NIC, the home LAN) and are not reachable from outside.
  A numeric QQ AppID is **not** matchable by shape (it is a bare 10-digit run), so it
  must be kept out at the source; documented in `redact.js` so nobody "fixes" that into
  a rule that eats dates and byte counts.
  The summarizer prompts say the same thing one level earlier, so the record stays
  readable instead of degrading into a row of markers.
  `memory_backup` applies the identical rules to the copies it writes **inside the
  tree**, after the SHA-256 fidelity check — so the recovery bundle's copies differ
  from the workspace only at the masked spans, and a restorer must re-enter values
  such as the bridge `host` (the bundle's README says so).
* **A scrubber is verified, not trusted.** `scrubVerified` refuses a result whose line
  count moved or whose byte delta does not equal `Σ(marker − match)`: that proves only
  the matched spans changed, which is what makes it safe to run over a file the tree
  treats as append-only.
* **Local dates.** `Asia/Shanghai` by default decides which day a write belongs
  to, and every timestamp records its offset.

## Tools

| Tool | Purpose |
|---|---|
| `memory_read` | Read one level: `index` / `longterm` / `year` / `month` / `day` / `snapshot`. Every answer names the next drill-down step. |
| `memory_search` | Keyword search over index and roll-up lines (cheap). `includeSnapshots=true` also searches verbatim bodies. |
| `memory_snapshot` | Take a snapshot now. Reports `empty` when nothing new happened. |
| `memory_import` | Replay historical DSH session logs into the tree, so a fresh install is not memoryless on a machine with months of conversation on disk. **Dry run by default.** See [Importing history](#importing-history). |
| `memory_status` | Diagnostics: config, tree shape, this session's trigger state, counters, last error. `probe=true` makes one live model call to verify the route and the streaming protocol. |
| `memory_backup` | Refresh the disaster-recovery bundle at `<root>\_bootstrap`. Run it after changing a plugin, the persona, a skill or the AGENTS rules — the bundle does not update itself. |

A snapshot runs in stages — `slice` → `day` → `upper` → `rollup` — and a
counter only advances when its stage *finishes*. A status read taken mid-run
therefore shows zeros that are indistinguishable from a dead feature, so the
report names the running stage (`session.phase`) and marks the counters as
provisional (`stats.midFlight`) whenever a run is live.

### Reaching back to earlier work

When the human's *own* message contains a cross-session phrase ("上次", "我们之前",
"last time"), the plugin appends **one** user-role message naming the memory tools
and the cheap read path. It is a nudge, not automation: the text states outright
that the model may ignore it, so a borderline match costs a line instead of
producing a confidently wrong answer.

Two details are load-bearing:

* It rides `decision.messages` from `agent/pre-step`, **not** a
  `systemPrompt.variable()` provider. `AgentLoop.preStep()` assembles the system
  prompt *before* dispatching that hook (verified against `dsh-agent-loop`), so a
  variable would only ever describe the *previous* step — one step too late for
  the exact case this exists to serve.
* It is registered with `{ prepend: true }`, the same shape `dsh-time-context`
  uses for its runtime context, so `next()` resolves to the final decision and a
  later listener cannot drop the reminder by rebuilding `messages`.

Injected context is tagged `source.kind: 'plugin'`, never `'user'` — the
harness's own discriminator for what a human typed — so neither DSH nor this
plugin's own turn log can mistake it for a request. Detection and throttling cost
nothing: one substring scan, no model call, no file read.

The plugin also registers a **system-prompt section** telling the agent the tree
exists and how to walk it. Being a prompt section, it survives context
compaction — unlike an injected message, which does not.

## Configuration

Every key is a default in `cordis.patch.yml` and can be overridden by row id in
the profile's own patch layer.

| Key | Default | Meaning |
|---|---|---|
| `root` | `<MEMORY_ROOT>` | Tree root. |
| `timezone` | `Asia/Shanghai` | IANA zone deciding `{yyyy}/{mm}/{dd}`. |
| `enabled` | `true` | Master switch. |
| `turnLog` | `true` | One mechanical line per turn. |
| `snapshotTriggerRatio` | `0.5` | Snapshot at this fraction of the routed model's own window. |
| `snapshotTriggerTokens` | `500000` | Absolute trigger while the window is unknown, and a floor under the ratio. |
| `snapshotGrowthTokens` | `100000` | How far the context must GROW past the last snapshot before pressure fires again. Without it the trigger is a state, and a state a snapshot cannot change stays true forever — measured live at 22 snapshots in 25 minutes. |
| `minSnapshotIntervalMs` | `60000` | Floor between *automatic* snapshots of one session (`compaction`/`manual` bypass it). A rate limit, not the thing that stops repetition. |
| `compactionTrigger` | `true` | Snapshot when the durable `compaction/start` event appears. |
| `snapshotOnTurns` | `0` | Also snapshot every N turns (0 = off). |
| `maxSliceBytes` | `4194304` | Verbatim slice budget per snapshot (safety valve; see above). |
| `maxInputChars` | `120000` | Slice budget fed to the day-entry call. |
| `maxTokens` | `8000` | Output budget per model call. |
| `timeoutMs` | `180000` | Per-call deadline. |
| `rollup` | `true` | Run call 2 (day + month/year/long-term gists). `false` costs every level above the day. |
| `dayEntryMax` | `8` | Most entries ONE snapshot may append (runaway guard, not a ration). |
| `dayEntryChars` | `400` | Per-entry character cap. |
| `dayEntryRecent` | `12` | Recent entries shown to call 1 so it can avoid repeating itself. |
| `includeSubagents` | `true` | Record subagent sessions separately. **Changed from `false` on 2026-09-30**: the work most worth keeping (the local-model / embedding investigation) ran inside delegated child sessions, and with this off the tree kept nothing of it — the parent logs only its own turns. Set `false` for the old behaviour. |
| `readMaxChars` | `24000` | Default truncation for `memory_read`. |
| `reminderOn` | `true` | Append one cross-session reminder when the human's own message refers back to earlier work. |
| `reminderMinGapTurns` | `3` | Turns to stay quiet after one reminder. |
| `mediaArchive` | `true` | Copy each turn's images into that day's `media/` directory and index them. |
| `dshHome` | `%USERPROFILE%\.dsh` | DSH state directory; only the asset backup needs it. |

## Install

> **Something is broken?** [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) is organised by the
> error message you are actually looking at — install failures, a plugin that
> registers but never loads, the embedding model, the corpus builder, backups.
> Each entry is *what it says* → *why* → *the command to fix it*.


The plugin is a `link:` (local, unpacked) dependency of a DSH profile. Four
steps, in this order — skipping the last one is the usual reason a plugin
"installs fine and then does nothing".

### 1. Unpack it somewhere permanent

Put this directory where it will live long-term. It is linked, not copied, so
**moving it later breaks the link**. Do not put it inside the profile's own
`node_modules`.

### 2. Install the runtime dependency

```bash
pnpm install          # or: npm install
```

Only one package is needed — `@huggingface/transformers` — and it is reached
through a **dynamic** import, so a missing install degrades recall instead of
crashing the plugin at load time.

For recall you additionally need the embedding model on disk. The default
location is **`<tree root>/models/bge-small-zh-v1.5-onnx/`** — i.e. with the
default root:

```
~/.dsh/DSHMemory/models/bge-small-zh-v1.5-onnx/
  config.json               tokenizer.json        tokenizer_config.json
  special_tokens_map.json   vocab.txt
  onnx/model_quantized.onnx
```

All six files matter; `tokenizer.json` in particular is easy to leave out when
copying by hand, and the loader's complaint about a missing file is long and
does not name the directory it looked in.

`BAAI/bge-small-zh-v1.5` is a public download and the quantized ONNX build is
about 23 MB. If you keep it somewhere else, point **`routerOnnxDir`** at the
directory that *contains* `bge-small-zh-v1.5-onnx` — one level **above** it, not
at it. `routerOnnxModel` names the folder itself and already defaults correctly.

**Two ways this goes wrong quietly**, both worth recognising up front:

* **The folder is one level off.** `routerOnnxDir` pointing at
  `.../bge-small-zh-v1.5-onnx` instead of its parent produces "file not found
  locally" from the loader — a message that never says which path was tried.
* **Nothing is configured, so it falls back to HTTP.** With no model on disk the
  plugin retries `routerBaseUrl` (default `http://127.0.0.1:1234`, an
  OpenAI-compatible embeddings server). If nothing is listening there you get a
  bare `ECONNREFUSED 127.0.0.1:1234`, which reads like a broken install rather
  than a missing model.

**Recall is optional**: with no model the tree still records and reads memory, it
simply never produces a recall hint.

### 3. Register it in a profile

> **Prerequisite: `pnpm` must be on `PATH`.** `dsh plugin add` shells out to it
> **even for a local `link:` directory** — the `link:` form only means "do not
> copy", not "do not run the package manager". Without `pnpm` the command fails
> **halfway**: it creates the profile directory and `cordis.patch.yml`, prints an
> initialization line, and then stops — leaving `dependencies` and
> `dsh.profile.bundles` **empty**. That looks like a successful install and is
> not one. Check with `pnpm --version` before you start.
>
> Note that DSH Desktop ships its own `pnpm` under
> `resources/runtime/pnpm/bin/pnpm.mjs`; it is **not** added to `PATH` for you.

```bash
dsh plugin --profile <PROFILE> add link:<PLUGIN_DIR>
```

Replace `<PROFILE>` with the profile you actually run (`desktop` for DSH
Desktop). This one command does three things that must happen together: writes
the `dependencies` entry, registers the bundle in `dsh.profile.bundles`, and
creates the `node_modules` symlink. Verify all three — a half-completed run is
the failure mode to watch for:

```bash
# dependencies must contain it, and bundles must list it by package name
cat ~/.dsh/profiles/<PROFILE>/package.json
```

**If the profile is `desktop`, the CLI refuses outright** — recent DSH builds
reject `desktop` with *"profile desktop is managed exclusively by the Electron
application"*. Test the packaging against a throwaway profile name first
(`dsh plugin --profile isotest add link:<PLUGIN_DIR>`); for `desktop` itself you
edit `package.json` by hand and restart. Either way both fields must be written:
`dependencies` **and** `dsh.profile.bundles`.

> **A `link:` dependency DOES appear in `pnpm-lock.yaml`** (measured: an
> `importers` entry with `specifier: link:...` and `version: link:...`). It needs
> no *resolution*, but the lockfile is still rewritten — so do not treat the
> lockfile as the place to detect whether a local plugin was registered. Read
> `package.json` instead.

### 4. Pre-flight, then restart

```bash
node test/loader-precheck.mjs   # patch parses, module contract, every lib module resolves, root is writable
node test/pure.mjs              # naming, dates, regions, event projection, summarizer, reminder
node test/tree.mjs              # lazy creation, sentinels, roll-ups, concurrency, coverage
node test/service.mjs           # the full snapshot pipeline against a faked harness
node test/router.mjs            # recall scoring, gating and exclusions
node test/apply.mjs             # plugin lifecycle
```

`loader-precheck.mjs` locates the profile through `DSH_PROFILE_DIR` (default
`~/.dsh/profiles/desktop`). On a fresh checkout with nothing installed yet, set
`DSH_ALLOW_MISSING_DEPS=1` to check everything else without failing on the
absent `node_modules`.

**Then restart DSH Desktop.** Host-side code (`lib/*.js`) and configuration are
read **once at startup** — a plugin that is registered but not restarted is
simply never loaded. There is one exception: the client script
(`ui-switch.js`) is re-fetched by the running page on a 60-second poll and
hot-swaps itself, so client-only edits need no restart. Do not confuse the two.

After the restart, call **`memory_status`** with `probe=true`: it exercises the
live path end to end rather than reporting only what it believes.

### Rehearsing the install

The install procedure itself is testable, and `scripts/iso-env.mjs` does it: it builds
a **throwaway DSH home**, runs the four steps above against a copy of the plugin,
and then runs the whole test suite **at the installed location** — which is the
only place that catches a half-finished registration.

Why a fresh home and not a copy of your real one: the copy would already have the
plugin wired up, so it proves nothing about installing. Three things make it work,
and each fails differently if you miss it:

| requirement | why | how it fails |
|---|---|---|
| `DSH_HOME` points at an empty directory | precedence is *explicit config > `DSH_HOME` > `~/.dsh`*, so setting it isolates completely | silently uses your real `~/.dsh` |
| the profile name is **not** `desktop` | the CLI refuses `desktop` outright ("managed exclusively by the Electron application") | the run dies before installing |
| `pnpm` is on `PATH` | `dsh plugin add` shells out to it even for a local `link:` | **half-finished**: profile created, `dependencies` empty — looks like success |

```bash
node scripts/iso-env.mjs full       # build → install → verify, end to end
node scripts/iso-env.mjs status     # read-only: what it resolved, and from where
node scripts/iso-env.mjs destroy    # remove the rehearsal tree
```

> ⚠ Never kill those processes by matching their command line: the shell running
> the match **contains those paths in its own command line** and will kill itself
> (observed: `Windows Job runner exited`). Kill by PID only.

### Uninstall

```bash
dsh plugin --profile <PROFILE> remove dsh-memory-tree
```

Your tree at `<root>` is **never modified** by removal — the plugin only ever
appends, so uninstalling leaves every memory file exactly where it was.

## Recall: building the corpus

Recall compares each incoming message against every remembered utterance, so
those utterances must exist as a corpus plus a vector index. **Nothing creates
them for you** — `scripts/build-corpus.mjs` does, reading the session logs DSH
already keeps on disk.

```bash
node scripts/build-corpus.mjs          # build / update
node scripts/build-corpus.mjs --dry    # report only, write nothing
node scripts/build-corpus.mjs --force  # rebuild even with nothing new
```

It writes, under the tree root:

```
<root>/router/corpus.jsonl          one row per remembered utterance
<root>/router/index/embed.bin       Float32 vectors, row-for-row with the corpus
<root>/router/index/embed_meta.json { model, dim, count, dates, builtAt }
```

Those are exactly the paths the plugin derives when `routerCorpus` /
`routerIndex` are left blank, so no configuration is needed. Run the builder
once after installing, then on a schedule (a scheduled task on Windows, cron on
POSIX). It is safe to run while the plugin is live: writes are atomic
(`.tmp` + rename), and finding nothing new means writing nothing at all.

What gets indexed — and what deliberately does not. Measured on one real
session log (83.5 MB decompressed, 120,621 events):

| part of the log | share | indexed |
|---|---|---|
| human messages | 1.8% | **yes** |
| assistant messages | 12.5% | no |
| streaming fragments (`reasoning-chunks`, `assistant/chunk`, `tool-call-chunks`, …) | 85.7% | no |

Indexing the fragments would bury the signal. Human turns are indexed because
recall matches a question against something the human actually said.

### Two traps worth knowing

* **A session log is not one zstd frame.** DSH appends one frame per line —
  measured 82,309 frames in a 36 MB log. `zstdDecompressSync(wholeFile)` stops
  at the first frame and returns only the session header: a silent 178-byte
  "success" that looks exactly like an empty log. The builder walks frame
  boundaries instead.
* **The plugin's own injected notes are excluded** by `source.kind === 'user'`.
  Without that filter, recall scores our reminders against themselves — the
  measurement above skipped 1,261 of them against 778 real turns.

### The embedding model

`routerOnnxDir` (default `<root>/models`) must hold a `bge-small-zh-v1.5-onnx`
directory containing `config.json`, `tokenizer_config.json`, `vocab.txt` and
`onnx/model_quantized.onnx`. `BAAI/bge-small-zh-v1.5` is a public download, and
the quantized ONNX build is about 23 MB.

With no model the builder falls back to an HTTP embedding server on
`127.0.0.1:1234`. With neither it reports the failure and exits non-zero
**before** writing anything — a corpus with no vectors is worse than no corpus,
because the plugin would load it and answer wrongly instead of reporting that
recall is unavailable.

## Importing history

The tree records only what happened while the plugin was running, so a fresh
install starts empty — even on a machine whose session logs go back months.
`memory_import` replays those logs through the **same snapshot pipeline a live
turn uses**, so an imported day is indistinguishable from a recorded one.

| Mode | Cost | What you get |
|---|---|---|
| `summarize: false` (default) | **no model calls** | verbatim snapshots for every day the session touched |
| `summarize: true` | two model calls per snapshot | plus real day summaries and roll-ups |

**Dry run by default.** The first call reports the plan and writes nothing:

```
memory_import                                   → plan only
memory_import {dryRun: false}                   → snapshots only, no model calls
memory_import {dryRun: false, summarize: true}  → snapshots + summaries
```

Do the snapshot-only pass first: the raw text lands immediately, and a later
`summarize: true` pass upgrades the summaries **without duplicating anything** —
the watermark is per session, so a re-run finds every range already covered.

Scope it with `since` / `until` (`yyyy-mm-dd`) and `limit`. Large histories are
better done in slices, since each summarized session costs model calls.

### What it keeps, and what it drops

Measured on one real 36 MB session log (83.5 MB decompressed, 120,621 events):

| | share | kept |
|---|---|---|
| `user/message`, `assistant/message`, `tool/call`, `tool/result` | ~14% | **yes** |
| `reasoning-chunks`, `assistant/chunk`, `tool-call-chunks`, `text-chunks` | ~86% | no |

The fragments are the message being typed out piece by piece; the finished
`assistant/message` already carries the result. Keeping them would multiply the
tree by roughly six for no content.

### Two traps in the log format

* **A log is not one zstd frame.** DSH appends one frame per line — 82,309 of
  them in that 36 MB file. `zstdDecompressSync(wholeFile)` stops at the first
  and returns only the session header: a 178-byte "success" that is
  indistinguishable from an empty log. The reader walks frame boundaries.
* **Each session has several generations** (`session.jsonl`, `.v3`, `.v4`) — the
  same conversation at different schema versions. Reading two would record every
  turn twice, so only the newest is read.

### Where the boundary is

`START_DATE` (default `2000-01-01`) is a **sanity floor, not a statement about
when the tree began**: it exists so a nonsense timestamp cannot conjure a 1970
directory that then lives in the tree forever. The tree's real earliest day is
whatever its earliest recorded or imported session produced. It used to be a
hard-coded recent date, which silently made importing anything older impossible.

## Why the hooks cannot break the agent loop

* `agent/pre-step` is a **waterfall**: the listener must return the decision
  `next()` produces. This plugin observes first, then returns the upstream
  decision — by reference and unchanged, unless a cross-session reminder is due.
  Everything it schedules is detached, so the request is never delayed.
* `agent/turn-stopping` is **serial and awaited**, so it does one small
  append and never calls a model.
* Profile-root listeners are *untagged*, and `dsh-scope`'s `scopeTarget`
  admits untagged listeners to scope-filtered dispatch globally. That is what
  lets one profile-level row observe every agent. A listener tagged *below* the
  dispatch key would never see these events.
* Every failure is caught, logged through `ctx.logger.warn`, and recorded in
  `memory_status.lastError`. No hook throws into the loop.

## What may live at the tree root

The root holds the date hierarchy (`<yyyy>/<mm>/<dd>/`) plus `index.md` and
`longterm.md`. **Any other directory is ignored by design**: `#subdirs` filters
`/^\d{2,4}$/`, `treeOverview` whitelists `YEAR_RE`/`MONTH_RE`/`DAY_RE`, and
`#treeFiles` *builds* its file list by concatenation instead of `readdir`.

That contract is what makes `<MEMORY_ROOT>\_bootstrap\` — the disaster-recovery
bundle holding real copies of the plugins, persona, rules and install state —
safe to keep beside the tree: it is never scanned, never searched, and never
rolled up. It is also why a day's `media/` directory can sit inside the date
hierarchy without disturbing anything: `media` is not a numeric directory name,
so the same two enumerations skip it. Three tests pin the contract
(`tree.mjs` for `treeOverview`, `service.mjs` for `search()`), because a
regression would silently pull recovery documentation or image listings into
every search result.

## Making changes

`lib/` is plain ESM with **no runtime dependencies** (a linked package must
resolve without its own install) — which is why the reminder message is built by
hand to mirror `createUserMessage` instead of importing it.

**Any change needs a DSH restart, config included.** `patchReload: live` in the
profile does *not* mean config hot-reload: changing this plugin's own
`cordis.patch.yml`, and overriding the row in the profile's patch layer, both
left the running process on the old value (measured twice on 2026-09-13).


## Recall (P0) and the automatic-summary switch (P1) — 2026-09-30

**Recall** answers "does this message relate to past memories?" with the local embedding model
(`text-embedding-bge-small-zh-v1.5`, 512-dim, ~25 MB, served by Bionic/LM Studio on `127.0.0.1:1234`).
Measured: **~5 ms per turn** (encode ~3 ms + one pass over 1005 corpus vectors ~2 ms); the model stays
resident for tens of MB, and `routerWarmup` + `routerKeepAliveMs` keep it that way from plugin load.
Recall never spawns a process (a `node` spawn costs 50–100 ms, ten times the work) and **never throws into
the turn**: every failure is swallowed and reported as `router.lastError` in `memory_status`.

Flow: the human's message is scored against the offline corpus (`routerIndex` + `routerCorpus`), ranked by
`cosine * exp(-routerLambda * daysAgo)`, and kept when `cosine >= routerMinCos` **and** `daysAgo <= routerMaxDays`.
When it clears, **one note is appended to the step** — the same door the cross-session reminder uses — naming the
candidate days and telling the model to check them with `memory_read level=day date=<date>` and judge for itself.
The agent's judgement can be recorded with `memory_route_feedback` (`<MEMORY_ROOT>\router\agent_judged.jsonl`,
scrubbed before it lands). That is **training data, not ground truth** — only the human's own rating is; keeping the
two apart is what prevents a feedback loop.

| Tool | What it does |
|---|---|
| `memory_route` | Route one message by hand; returns candidate days + cosines, or `none`. |
| `memory_route_feedback` | Record the agent's own verdict (`relevant` / `partly` / `not_relevant`) as training data. |
| `memory_auto` | Turn **automatic summarisation** on/off at runtime. |

`memory_auto off` stops the pressure / compaction / turn-count snapshots — i.e. no automatic model calls — while the
mechanical turn log keeps recording (one line per turn, zero model calls) and `memory_snapshot` still works by hand.
It is **runtime only**: a restart returns to the configured default.

| Config key | Default | Meaning |
|---|---|---|
| `autoSummary` | `true` | Master switch for automatic snapshots (the `memory_auto` tool flips it). |
| `router` | `true` | Enable the recall layer at all. |
| `routerBaseUrl` | `http://127.0.0.1:1234` | The local embeddings server. |
| `routerModel` | `text-embedding-bge-small-zh-v1.5` | Which embedding model to call. |
| `routerIndex` | `<INDEX_DIR>/memory_router/index/embed_index_bge_small_zh` | Float32 index (`.bin` + `_meta.json`), built offline. |
| `routerCorpus` | `<INDEX_DIR>/memory_router/consolidated_corpus.jsonl` | The snippets behind those vectors (for the note's text). |
| `routerDataDir` | `<MEMORY_ROOT>/router` | Where feedback JSONL lands. A non-numeric directory, so the tree skips it. |
| `routerTopK` / `routerMinCos` / `routerMaxDays` / `routerLambda` | `5` / `0.6` / `7` / `0.1` | Ranking and threshold. Tuned from measurement: bge top-1 cosine min 0.597, median 0.752. |
| `routerInject` | `true` | Append the note automatically. `false` keeps the tools but stops the injection. |
| `routerMinGapTurns` | `2` | Stay quiet this many turns when the same candidate set repeats. |
| `routerWarmup` / `routerKeepAliveMs` | `true` / `300000` | Warm the model at load, then ping every 5 minutes so it stays resident. |

**Known limits.** The corpus is a frozen extract (2026-09-13 … 2026-09-30): a brand-new message is fine (the query is
new text), but memories recorded *after* the extract cannot be recalled until the index is rebuilt. Long messages are
truncated to `routerMaxChars`. And recall quality is currently measured only as **agreement** with the rule-based
baseline (74.3 % top-5 with the same vectors), not accuracy — there is no ground truth for "which other days were
relevant" yet.
