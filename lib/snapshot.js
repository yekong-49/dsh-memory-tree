/**
 * Snapshot writing: the authoritative layer.
 *
 * A snapshot is a verbatim slice of the session's durable event log plus a
 * YAML header recording which event range it covers. Because the header
 * records `fromSeq`/`toSeq`, snapshotting is **idempotent by construction**:
 * the next snapshot starts where the previous one ended, so re-running after
 * a crash neither loses events nor accounts for the same ones twice.
 *
 * "The previous one" means the previous snapshot of THIS SESSION, wherever in
 * the tree it is — see the note below `COLLISION_SUFFIXES`.
 *
 * Order of operations mirrors the tree spec — the durable record is written
 * BEFORE any model call. A failed summarization therefore costs prose, never
 * the original text.
 */

import { existsSync } from 'node:fs';
import { atomicWrite, createExclusive, readIfExists } from './atomic.js';
import { setFrontMatter } from './frontmatter.js';
import { highestCoveredSeq, parseStamp, firstSeqAfter, verbatimSlice } from './events.js';
import { joinPath, nodePaths, snapshotName } from './paths.js';
import { findSessionWatermarkDetail } from './tree.js';
import { turnDaySegments } from './events.js';
import { snapshotDocument, snapshotHeader } from './templates.js';

/** Suffixes tried when two snapshots collide inside the same second. */
const COLLISION_SUFFIXES = ['', '-b', '-c', '-d', '-e', '-f', '-g', '-h', '-i'];

/*
 * WHERE A SESSION'S RECORD RESUMES is answered by `findSessionWatermark` in
 * `tree.js`, and deliberately nowhere else.
 *
 * There used to be a `nextUncoveredSeq(snapshots, sessionId)` here that took a
 * list of snapshots and returned the first uncovered seq. It was correct as a
 * function and wrong as an interface: it let the caller decide WHICH snapshots
 * to look at, and the caller passed the current day's. Every midnight the session
 * therefore looked as though it had never snapped, and the first snapshot of the
 * new day re-sliced the whole session from seq 0 — on 2026-09-14 that burned the
 * entire 4 MB budget on events thirteen snapshots already held, and left the
 * genuinely new range in no snapshot at all.
 *
 * The function survived that fix with no production caller, kept alive only by a
 * test that asserted its semantics — including `nextUncoveredSeq([], 's1') === 0`,
 * which is precisely the answer that hurt. A helper whose only remaining purpose
 * is to be tested is a way for the next reader to re-wire the bug, so it is gone.
 */

/**
 * Write the snapshots for one uncovered range — one per day the range touches.
 *
 * The range is split by TURN, at the day the human's message that began the turn
 * was sent (see `turnDaySegments`). A message sent at 23:50 and answered at 00:10
 * is the previous day's memory, and the range that contains it must not be filed
 * wholesale under either side: filing it under the earlier day buries the new
 * day's work, and filing it under the later day buries the evening's.
 *
 * `segments` carries every file written; the top-level fields mirror the LAST
 * one, which is the newest content and therefore what the day summary and the
 * snapshot index want to talk about.
 * @param {{root: string, dateText: string, time: {hour: number, minute: number, second: number}, stamp: string, trigger: string, session: {id?: string, seq?: number}, cwd: string, route: {provider: string, model: string}, events: Iterable<unknown>, contextTokens: number, maxBytes: number, timezone?: string, dayOf?: (epochMs: number) => string, mutex: {run: (key: string, action: () => Promise<any>) => Promise<any>}}} input - snapshot request.
 * @returns {Promise<{status: 'written'|'empty', segments?: any[], file?: string, path?: string, bytes?: number, truncated?: boolean, slice?: string, fromSeq?: number, toSeq?: number, covered?: number}>} the outcome.
 */
export async function writeSnapshot(input) {
	const layout = nodePaths(input.root, input.dateText);
	return input.mutex.run(layout.dayDir, async () => {
		// The watermark comes from the whole tree, not from today's directory:
		// a session's record spans days, and asking only about today makes every
		// day boundary look like the start of the session.
		const watermark = await findSessionWatermarkDetail({
			root: input.root,
			dateText: input.dateText,
			sessionId: input.session?.id,
			currentSeq: typeof input.session?.seq === 'number' ? input.session.seq : undefined
		});
		// Materialised once, on purpose: both walks below need the same events, and a
		// generator handed in by a caller would be consumed by the first one — the
		// second would then see nothing, which is indistinguishable from "no events".
		const events = Array.isArray(input.events) ? input.events : [...input.events];
		let fromSeq = watermark.covered + 1;
		const toSeq = typeof input.session?.seq === 'number' ? input.session.seq - 1 : -1;
		if (watermark.rebased) {
			// Every snapshot in the tree sits at or beyond the end of the current log,
			// so none of them belongs to this seq space: DSH 2.0.10 keeps the live log
			// in `session.v3.jsonl.zstd`, whose `seq` restarts near 0, while the tree's
			// snapshots are numbered in the previous space (millions). Comparing them
			// made `toSeq < fromSeq` true for good, so every snapshot answered `empty`
			// and the tree stopped summarising in silence — turn-log rows kept being
			// written, which is exactly what made it look healthy from outside.
			// Time is the one axis that survives a renumbering: cover the first event
			// after the newest snapshot's own stamp. After this single rebase the new
			// snapshot fits inside the current log, so the next call takes the normal
			// path and nothing is re-recorded twice.
			const rebased = firstSeqAfter(events, parseStamp(watermark.time));
			if (rebased === undefined || toSeq < rebased) return { status: 'empty' };
			fromSeq = rebased;
		} else if (toSeq < fromSeq) {
			// The ordinary "nothing new has happened" case.
			return { status: 'empty' };
		}
		const dayOf = input.dayOf ?? (() => input.dateText);
		const segments = turnDaySegments(events, fromSeq, toSeq, dayOf);
		if (segments.length === 0) return { status: 'empty' };

		const written = [];
		for (const segment of segments) {
			// Each segment is rendered and budgeted on its own: they are separate
			// records in separate day directories, so one day running long must not
			// eat the other day's room.
			const slice = verbatimSlice(events, segment.fromSeq, segment.toSeq, input.maxBytes);
			if (slice.records === 0) continue;
			const segmentLayout = nodePaths(input.root, segment.dateText);
			written.push(await writeWithUniqueName(segmentLayout.dayDir, input, {
				fromSeq: segment.fromSeq,
				toSeq: segment.toSeq,
				slice,
				dateText: segment.dateText,
				endTime: segment.endTime,
				// The clock in the file name is the segment's last event, so the name
				// sorts inside its own day instead of claiming a time on a day it does
				// not belong to. A cross-midnight segment for the 13th written at 10:20
				// on the 14th is `2026-09-13T2359xx-…`, not `2026-09-13T1020xx-…`.
				time: timeOf(segment.endTime, input.time)
			}));
		}
		if (written.length === 0) return { status: 'empty' };
		const last = written[written.length - 1];
		return written.length === 1 ? last : { ...last, segments: written };
	});
}

/**
 * Local clock fields for a timestamp, falling back to the caller's clock.
 * @param {number} epochMs - the event time.
 * @param {{hour: number, minute: number, second: number}} fallback - used when the time is unusable.
 * @returns {{hour: number, minute: number, second: number}} clock fields.
 */
function timeOf(epochMs, fallback) {
	if (!Number.isFinite(epochMs) || epochMs <= 0) return fallback;
	const when = new Date(epochMs);
	return { hour: when.getHours(), minute: when.getMinutes(), second: when.getSeconds() };
}

/**
 * Create the snapshot file, retrying with a suffix on a same-second collision.
 * @param {string} dayDir - the day directory.
 * @param {any} input - the snapshot request.
 * @param {{fromSeq: number, toSeq: number, slice: {text: string, truncated: boolean, records: number}, dateText: string, time: {hour: number, minute: number, second: number}}} parts - computed parts, including the day this segment belongs to.
 * @returns {Promise<{status: 'written'|'empty', file: string, path: string, bytes: number, truncated: boolean, slice: string, fromSeq: number, toSeq: number, covered: number, dateText: string}>} the outcome.
 */
async function writeWithUniqueName(dayDir, input, parts) {
	const baseName = snapshotName(parts.dateText, parts.time, input.trigger, input.session?.id);
	for (const suffix of COLLISION_SUFFIXES) {
		const file = suffix.length === 0 ? baseName : baseName.replace(/\.md$/, `${suffix}.md`);
		// `joinPath`, never `${dayDir}\\${file}`. The literal backslash was the
		// second half of the separator defect: on POSIX the snapshot landed in the
		// MONTH directory as a flat file named `13\2026-09-13T….md`, so the day
		// directory contained no snapshot, `listSnapshots` returned zero, and
		// `findSessionWatermark` returned -1 — which made every later snapshot
		// re-slice from seq 0. The file itself read back fine by its returned
		// path, which is why a test that read it directly still passed while
		// every test that LISTED snapshots failed.
		const path = joinPath(dayDir, file);
		const header = snapshotHeader({
			dateText: parts.dateText,
			stamp: input.stamp,
			trigger: input.trigger,
			sessionId: input.session?.id ?? 'unknown',
			cwd: input.cwd,
			provider: input.route?.provider ?? 'unknown',
			model: input.route?.model ?? 'unknown',
			fromSeq: parts.fromSeq,
			toSeq: parts.toSeq,
			contextTokens: Math.round(input.contextTokens ?? 0),
			summary: '（摘要生成中）',
			truncated: parts.slice.truncated,
			bytes: Buffer.byteLength(parts.slice.text, 'utf8')
		});
		const document = snapshotDocument({ header, body: parts.slice.text });
		const result = await createExclusive(path, document);
		if (result === 'existed') {
			// The same second, the same session: retry under a suffixed name so a
			// second distinct snapshot is not silently dropped.
			if (existsSync(path)) continue;
		}
		return {
			status: 'written',
			file,
			path,
			dateText: parts.dateText,
			endTime: parts.endTime,
			bytes: Buffer.byteLength(document, 'utf8'),
			truncated: parts.slice.truncated,
			slice: parts.slice.text,
			fromSeq: parts.fromSeq,
			toSeq: parts.toSeq,
			covered: parts.slice.records
		};
	}
	throw new Error(`memory-tree: could not allocate a snapshot name in ${dayDir}`);
}

/**
 * Replace a snapshot's placeholder summary with the model-written gist.
 *
 * The snapshot's body is verbatim and never rewritten; only this one derived
 * header field is enriched after the summary call. A failure here is
 * cosmetic — the index then shows the placeholder.
 * @param {string} path - the snapshot file.
 * @param {string} gist - the one-line gist.
 * @returns {Promise<boolean>} whether the file changed.
 */
export async function stampSnapshotSummary(path, gist) {
	const current = await readIfExists(path);
	if (current === undefined) return false;
	const next = setFrontMatter(current, { summary: gist });
	if (next === current) return false;
	await atomicWrite(path, next);
	return true;
}
