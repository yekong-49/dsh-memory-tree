/**
 * Tree operations: lazy creation, node reads, and roll-up recomputation.
 *
 * The tree is its own source of truth. Every table inside a MACHINE ROLLUP
 * region is derived here from the filesystem plus each node's `summary:`
 * front-matter field, so:
 *
 *   * roll-ups are **idempotent** — recomputing produces byte-identical text,
 *   * they are **self-healing** — a row lost to a crash returns on the next
 *     snapshot, because it is never carried forward, always re-derived,
 *   * and the model only ever supplies `summary:` values, never table rows.
 *
 * Creation is lazy and bottom-up, exactly as `index.md` requires: long-term
 * header → directory chain → day → month → year. Nothing is pre-created and
 * nothing is ever deleted.
 */

import { join } from 'node:path';
import { atomicWrite, listDir, readIfExists, createExclusive } from './atomic.js';
import { frontMatterValue, setFrontMatter } from './frontmatter.js';
import { hasRegion, regionText, replaceRegion } from './sentinel.js';
import {
	appendDayEntries,
	DAY_SUMMARY_REGION,
	dayTemplate,
	longtermTemplate,
	monthTemplate,
	parseDaySummary,
	PLACEHOLDER,
	PLACEHOLDER_ROW,
	MEDIA_REGION,
	renderDaySummary,
	renderLongterm,
	renderMedia,
	renderMonth,
	renderSnapshotIndex,
	renderYear,
	ROLLUP_REGION,
	table,
	TURNLOG_REGION,
	yearTemplate
} from './templates.js';
import { nodePaths, TRIGGERS } from './paths.js';
import { highestCoveredSeq, parseStamp } from './events.js';

/**
 * Matches a snapshot file name and captures its fields.
 *
 * The trigger alternation is BUILT from `TRIGGERS`, not retyped. It used to be
 * a literal list, which meant adding a trigger required editing three places —
 * and missing this one failed SILENTLY in the worst possible way: the snapshot
 * file was written correctly, but `listSnapshots` did not recognise it, so the
 * day's snapshot index stayed empty, the watermark saw nothing covered, and
 * every later run re-imported the same range as if it had never happened.
 */
export const SNAPSHOT_RE = new RegExp(
	`^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2})(\\d{2})(\\d{2})-(${TRIGGERS.join('|')})-([a-z0-9_-]+)\\.md$`
);

/** Matches a four-digit year directory. */
const YEAR_RE = /^\d{4}$/;

/** Matches a two-digit month directory. */
const MONTH_RE = /^\d{2}$/;

/** Matches a two-digit day directory. */
const DAY_RE = /^\d{2}$/;

/**
 * Read one node's own one-line summary from its front matter.
 * @param {string} file - the node file.
 * @returns {Promise<string>} the summary, or the placeholder when absent.
 */
export async function readNodeSummary(file) {
	const text = await readIfExists(file);
	if (text === undefined) return PLACEHOLDER;
	const value = frontMatterValue(text, 'summary');
	if (value === undefined || value.trim().length === 0 || value === PLACEHOLDER) return PLACEHOLDER;
	return value.trim();
}

/**
 * Write a node's own one-line summary, leaving hand-written text untouched.
 * @param {string} file - the node file.
 * @param {string} summary - the new summary text.
 * @param {string} stamp - the update stamp.
 * @returns {Promise<boolean>} whether the file changed.
 */
export async function writeNodeSummary(file, summary, stamp) {
	const current = await readIfExists(file);
	if (current === undefined) return false;
	const next = setFrontMatter(current, { summary: summary.trim(), updated: stamp });
	if (next === current) return false;
	await atomicWrite(file, next);
	return true;
}

/**
 * Ensure a day file carries every region this plugin writes.
 *
 * Older day files predate some regions; adding them here means the tree
 * upgrades itself in place instead of needing a manual migration. Idempotent:
 * an existing region is left exactly as it is.
 * @param {string} dayFile - the day file.
 * @returns {Promise<string[]>} the names of the regions that were added.
 */
export async function ensureRegions(dayFile) {
	const current = await readIfExists(dayFile);
	if (current === undefined) return [];
	const added = [];
	let text = current;
	if (!hasRegion(text, DAY_SUMMARY_REGION)) {
		text = replaceRegion(text, DAY_SUMMARY_REGION, renderDaySummary([]));
		added.push(DAY_SUMMARY_REGION);
	}
	if (!hasRegion(text, TURNLOG_REGION)) {
		const body = [
			'### 机械流水（每轮一行，只追加）',
			'',
			table(['时间', '轮次', 'Δtoken', '改动的文件', '一句话'], [])
		].join('\n');
		text = replaceRegion(text, TURNLOG_REGION, body);
		added.push(TURNLOG_REGION);
	}
	if (!hasRegion(text, MEDIA_REGION)) {
		text = replaceRegion(text, MEDIA_REGION, renderMedia([]));
		added.push(MEDIA_REGION);
	}
	if (text !== current) await atomicWrite(dayFile, text);
	return added;
}

/**
 * Append the model's new event entries to the day's region.
 *
 * The one write path into `DAY SUMMARY`, and it can only add. A region written
 * before the log existed (one prose blob, no entry lines) is migrated on this
 * first call: its text moves below `LEGACY_MARK` verbatim rather than being
 * replaced, so upgrading the format cannot cost the history it exists to keep.
 * @param {{dayFile: string, entries: Array<string|{clock?: string, text: string}>, clock: string, stamp: string, maxChars?: number}} input - append request.
 *   Entries carrying their own `clock` (imported from another instance's tree) keep it; plain
 *   strings are stamped with `clock`.
 * @returns {Promise<{changed: boolean, added: Array<{clock: string, text: string}>, total: number, migrated: boolean}>} what changed.
 */
export async function appendDaySummary({ dayFile, entries, clock, stamp, maxChars }) {
	const current = await readIfExists(dayFile);
	if (current === undefined) return { changed: false, added: [], total: 0, migrated: false };
	const appended = appendDayEntries(regionText(current, DAY_SUMMARY_REGION), entries, { clock, stamp, maxChars });
	let next = replaceRegion(current, DAY_SUMMARY_REGION, appended.body);
	next = setFrontMatter(next, { updated: stamp });
	if (next === current) return { changed: false, added: [], total: appended.entries.length, migrated: false };
	await atomicWrite(dayFile, next);
	return { changed: true, added: appended.added, total: appended.entries.length, migrated: appended.migrated };
}

/**
 * Create the node chain for one date, lazily and idempotently.
 *
 * Order follows the spec: long-term header → directory chain → day → month →
 * year. Each file is created with an exclusive open, so a concurrent session
 * racing into the same day sees `EEXIST` and leaves the winner's template
 * alone instead of both writing a header.
 * @param {{root: string, dateText: string, stamp: string, mutex: {run: (key: string, action: () => Promise<any>) => Promise<any>}}} input - creation request.
 * @returns {Promise<{created: string[], layout: ReturnType<typeof nodePaths>}>} what was created.
 */
export async function ensureNode({ root, dateText, stamp, mutex }) {
	const layout = nodePaths(root, dateText);
	const created = [];
	return mutex.run(`${root}::ensure`, async () => {
		// 0. Long-term header (highest level, created first per spec).
		if ((await readIfExists(layout.longterm)) === undefined) {
			const result = await createExclusive(layout.longterm, longtermTemplate(stamp));
			if (result === 'created') created.push('longterm.md');
		}
		// 1. Directory chain (mkdir -p semantics; created implicitly below).
		// 2. Day node.
		if ((await readIfExists(layout.dayFile)) === undefined) {
			const result = await createExclusive(layout.dayFile, dayTemplate({
				dateText,
				stamp,
				monthEntry: `../${layout.date.year}-${layout.date.month}.md`
			}));
			if (result === 'created') created.push('day');
		}
		// 3. Month node.
		if ((await readIfExists(layout.monthFile)) === undefined) {
			const result = await createExclusive(layout.monthFile, monthTemplate({
				year: layout.date.year,
				month: layout.date.month,
				dateText,
				stamp
			}));
			if (result === 'created') created.push('month');
		}
		// 4. Year node.
		if ((await readIfExists(layout.yearFile)) === undefined) {
			const result = await createExclusive(layout.yearFile, yearTemplate({
				year: layout.date.year,
				dateText,
				stamp,
				previousYear: await previousYearOf(layout.root, layout.date.year)
			}));
			if (result === 'created') created.push('year');
		}
		await ensureRegions(layout.dayFile);
		return { created, layout };
	});
}

/**
 * Find the year preceding `year` that already has a directory.
 * @param {string} root - tree root.
 * @param {string} year - `yyyy`.
 * @returns {Promise<string|undefined>} the previous year, when one exists.
 */
async function previousYearOf(root, year) {
	const target = Number(year);
	const entries = await listDir(root);
	const years = entries
		.filter((entry) => entry.isDirectory && YEAR_RE.test(entry.name))
		.map((entry) => Number(entry.name))
		.filter((value) => value < target)
		.sort((a, b) => b - a);
	return years.length === 0 ? undefined : String(years[0]);
}

/**
 * Find the highest seq ONE SESSION has already covered, anywhere in the tree.
 *
 * Why this cannot look only at the current day. A snapshot records `fromSeq`/
 * `toSeq` as offsets into its own session's event log, so the coverage window is
 * per session and the question "where does this session's record resume?" has an
 * answer that OUTLIVES a calendar day. Reading only the current day's directory
 * answers it with "nothing has been covered" every midnight, and the first
 * snapshot of the new day then re-slices the session from seq 0.
 *
 * That is not hypothetical: on 2026-09-14 the first snapshot recorded
 * `fromSeq: 0, toSeq: 1528600` against a session whose previous snapshot had
 * ended at 1459965. It spent its entire 4 MB budget re-recording content that
 * thirteen snapshots already held, and — because a slice keeps its head when it
 * runs out of room — it was clipped at seq 1393010, leaving 1459966–1528600 in
 * no snapshot at all. The duplicate cost disk; the hole cost history.
 *
 * Coverage is monotonic in time, so the NEWEST day holding any of this session's
 * snapshots also holds its highest watermark, and the walk can stop there. Days
 * are therefore inspected newest-first: normally one directory, two across a day
 * boundary.
 * @param {{root: string, dateText: string, sessionId?: string}} input - the tree root, today, and the session.
 * @returns {Promise<number>} the highest covered seq, or -1 when the session has never snapped.
 */
export async function findSessionWatermark({ root, dateText, sessionId }) {
	return (await findSessionWatermarkDetail({ root, dateText, sessionId })).covered;
}

/**
 * The same walk as {@link findSessionWatermark}, but it also reports **when** the
 * newest snapshot was taken.
 *
 * Why the time is needed: a watermark is only comparable to a seq from the same
 * log. After DSH 2.0.10 the live log is `session.v3.jsonl.zstd`, whose `seq`
 * restarts near 0, while the tree still holds snapshots numbered in the previous
 * space (millions). Comparing the two makes `toSeq < fromSeq` true forever, so
 * every snapshot answered `empty` and the tree silently stopped summarising —
 * only the mechanical turn log kept going. The snapshot's own `time` is the one
 * quantity that survives a renumbering, so `snapshot.js` rebases on it.
 * @param {{root: string, dateText: string, sessionId?: string, currentSeq?: number}} input - the tree root, today, the session, and the log's current seq.
 * @returns {Promise<{covered: number, time: string|undefined, rebased: boolean}>} the highest seq **that fits inside the current log** (-1 when none does), the newest stamp, and whether the caller must rebase on time.
 */
export async function findSessionWatermarkDetail({ root, dateText, sessionId, currentSeq }) {
	const [year, month, day] = String(dateText).split('-');
	for (const yearName of await descending(root, YEAR_RE)) {
		if (yearName > year) continue;
		for (const monthName of await descending(join(root, yearName), MONTH_RE)) {
			if (yearName === year && monthName > month) continue;
			for (const dayName of await descending(join(root, yearName, monthName), DAY_RE)) {
				if (yearName === year && monthName === month && dayName > day) continue;
				const snapshots = await listSnapshots(join(root, yearName, monthName, dayName));
				const mine = snapshots.filter((snapshot) => sessionId === undefined || snapshot.header?.session === sessionId);
				if (mine.length === 0) continue;
				// Only snapshots that fit INSIDE the current log can act as a watermark:
				// a `toSeq` at or beyond the end of the current log belongs to a different
				// seq space (or is simply impossible), and using it would freeze coverage
				// forever. `currentSeq === undefined` keeps the historical behaviour.
				const usable = currentSeq === undefined
					? mine
					: mine.filter((snapshot) => {
						const value = Number(snapshot.header?.toSeq);
						return Number.isFinite(value) && value < currentSeq;
					});
				if (usable.length > 0) {
					return { covered: highestCoveredSeq(usable.map((snapshot) => snapshot.header)), time: undefined, rebased: false };
				}
				// Nothing in this tree belongs to the current seq space ⇒ the log was
				// renumbered underneath us. Hand back the newest stamp so the caller can
				// rebase on time; `covered: -1` says "no usable coverage at all".
				let newest;
				let newestAt = -Infinity;
				for (const snapshot of mine) {
					const at = parseStamp(snapshot.header?.time);
					if (at !== undefined && at > newestAt) { newestAt = at; newest = snapshot; }
				}
				return { covered: -1, time: newest?.header?.time, rebased: true };
			}
		}
	}
	return { covered: -1, time: undefined, rebased: false };
}

/**
 * List a directory's entry names matching a pattern, newest first.
 * @param {string} dir - the directory.
 * @param {RegExp} pattern - the name pattern.
 * @returns {Promise<string[]>} matching names in descending order.
 */
async function descending(dir, pattern) {
	const names = (await listDir(dir))
		.filter((entry) => entry.isDirectory && pattern.test(entry.name))
		.map((entry) => entry.name);
	return names.sort().reverse();
}

/**
 * List a day directory's snapshot files with their parsed headers.
 * @param {string} dayDir - the day directory.
 * @returns {Promise<Array<{file: string, header: Record<string, string>, text: string}>>} snapshots in name (time) order.
 */
export async function listSnapshots(dayDir) {
	const entries = await listDir(dayDir);
	const output = [];
	for (const entry of entries) {
		if (!entry.isFile || !SNAPSHOT_RE.test(entry.name)) continue;
		const text = await readIfExists(join(dayDir, entry.name));
		if (text === undefined) continue;
		const header = {};
		for (const line of text.split('\n')) {
			if (line.trim() === '---' && Object.keys(header).length > 0) break;
			const match = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
			if (match !== null) header[match[1]] = match[2].trim().replace(/^"|"$/g, '');
		}
		output.push({ file: entry.name, header, text });
	}
	return output;
}

/**
 * Turn snapshot records into day-index rows.
 * @param {Array<{file: string, header: Record<string, string>}>} snapshots - snapshots in time order.
 * @returns {Array<{time: string, trigger: string, session: string, range: string, summary: string, file: string}>} index rows.
 */
export function snapshotIndexRows(snapshots) {
	return snapshots.map((snapshot) => {
		const match = SNAPSHOT_RE.exec(snapshot.file);
		const clock = match === null ? '—' : `${match[4]}:${match[5]}:${match[6]}`;
		const fromSeq = snapshot.header.fromSeq ?? '?';
		const toSeq = snapshot.header.toSeq ?? '?';
		return {
			time: clock,
			trigger: snapshot.header.trigger ?? match?.[7] ?? '—',
			session: snapshot.header.session ?? match?.[8] ?? '—',
			range: `#${fromSeq}–#${toSeq}`,
			summary: snapshot.header.summary ?? '',
			file: snapshot.file
		};
	});
}

/**
 * Count snapshot files anywhere below a directory.
 * @param {string} dir - directory to scan recursively.
 * @returns {Promise<number>} the snapshot count.
 */
export async function countSnapshots(dir) {
	let total = 0;
	for (const entry of await listDir(dir)) {
		if (entry.isDirectory) total += await countSnapshots(join(dir, entry.name));
		else if (entry.isFile && SNAPSHOT_RE.test(entry.name)) total += 1;
	}
	return total;
}

/**
 * Build the long-term roll-up rows (one per year).
 * @param {string} root - tree root.
 * @returns {Promise<Array<{year: string, summary: string, months: number, snapshots: number}>>} rows in year order.
 */
export async function collectLongtermRows(root) {
	const rows = [];
	for (const entry of await listDir(root)) {
		if (!entry.isDirectory || !YEAR_RE.test(entry.name)) continue;
		const yearDir = join(root, entry.name);
		const months = (await listDir(yearDir)).filter((child) => child.isDirectory && MONTH_RE.test(child.name)).length;
		rows.push({
			year: entry.name,
			summary: await readNodeSummary(join(yearDir, `${entry.name}.md`)),
			months,
			snapshots: await countSnapshots(yearDir)
		});
	}
	return rows;
}

/**
 * Build a year file's roll-up rows (one per month).
 * @param {string} root - tree root.
 * @param {string} year - `yyyy`.
 * @returns {Promise<Array<{month: string, summary: string, days: number, snapshots: number, entry: string}>>} rows in month order.
 */
export async function collectYearRows(root, year) {
	const yearDir = join(root, year);
	const rows = [];
	for (const entry of await listDir(yearDir)) {
		if (!entry.isDirectory || !MONTH_RE.test(entry.name)) continue;
		const monthDir = join(yearDir, entry.name);
		const days = (await listDir(monthDir)).filter((child) => child.isDirectory && DAY_RE.test(child.name)).length;
		rows.push({
			month: entry.name,
			summary: await readNodeSummary(join(monthDir, `${year}-${entry.name}.md`)),
			days,
			snapshots: await countSnapshots(monthDir),
			entry: `${entry.name}/${year}-${entry.name}.md`
		});
	}
	return rows;
}

/**
 * Build a month file's roll-up rows (one per day).
 * @param {string} root - tree root.
 * @param {string} year - `yyyy`.
 * @param {string} month - `mm`.
 * @returns {Promise<Array<{day: string, date: string, summary: string, snapshots: number, entry: string, entries: Array<{clock: string, text: string, line: string}>}>>} rows in day order.
 */
export async function collectMonthRows(root, year, month) {
	const monthDir = join(root, year, month);
	const rows = [];
	for (const entry of await listDir(monthDir)) {
		if (!entry.isDirectory || !DAY_RE.test(entry.name)) continue;
		const dayFile = join(monthDir, entry.name, `${year}-${month}-${entry.name}.md`);
		rows.push({
			day: entry.name,
			date: `${year}-${month}-${entry.name}`,
			summary: await readNodeSummary(dayFile),
			snapshots: await countSnapshots(join(monthDir, entry.name)),
			entry: `${entry.name}/${year}-${month}-${entry.name}.md`,
			// The day's events, so the month can list what a day CONTAINED instead of
			// only naming it. Read from the child and never carried forward, so the
			// month's block stays a pure function of the day file and a lost month
			// file heals on the next snapshot.
			entries: await readDayEntries(dayFile)
		});
	}
	return rows;
}

/**
 * Read one day's key-event entries out of its `DAY SUMMARY` region.
 *
 * The legacy block, if present, is deliberately excluded: it is pre-log prose
 * kept for the record, not a list of that day's events, and rendering it as
 * bullets would invent structure it does not have.
 * @param {string} dayFile - the day file.
 * @returns {Promise<Array<{clock: string, text: string, line: string}>>} the entries, in order.
 */
export async function readDayEntries(dayFile) {
	const text = await readIfExists(dayFile);
	if (text === undefined) return [];
	return parseDaySummary(regionText(text, DAY_SUMMARY_REGION)).entries;
}

/**
 * Recompute and write every MACHINE ROLLUP region that this date touches.
 *
 * Bottom-up: day → month → year → long-term, so a crash midway still leaves
 * every level self-consistent (each level's table only needs its children,
 * which were written before it).
 * @param {{root: string, dateText: string, stamp: string, mutex: {run: (key: string, action: () => Promise<any>) => Promise<any>}}} input - recompute request.
 * @returns {Promise<{updated: string[]}>} the files that changed.
 */
export async function recomputeRollups({ root, dateText, stamp, mutex }) {
	const layout = nodePaths(root, dateText);
	const updated = [];
	// Day: the snapshot index only. DAY SUMMARY holds model prose and is
	// written by the summarizer, never by a roll-up recompute.
	const dayFile = layout.dayFile;
	const dayText = await readIfExists(dayFile);
	if (dayText !== undefined) {
		const snapshots = snapshotIndexRows(await listSnapshots(layout.dayDir));
		let next = replaceRegion(dayText, ROLLUP_REGION, renderSnapshotIndex(snapshots));
		next = setFrontMatter(next, { updated: stamp });
		if (next !== dayText) {
			await atomicWrite(dayFile, next);
			updated.push('day');
		}
	}
	// Month.
	const monthFile = layout.monthFile;
	const monthText = await readIfExists(monthFile);
	if (monthText !== undefined) {
		const inner = renderMonth(await collectMonthRows(root, layout.date.year, layout.date.month));
		let next = replaceRegion(monthText, ROLLUP_REGION, inner);
		next = setFrontMatter(next, { updated: stamp });
		if (next !== monthText) {
			await atomicWrite(monthFile, next);
			updated.push('month');
		}
	}
	// Year.
	const yearFile = layout.yearFile;
	const yearText = await readIfExists(yearFile);
	if (yearText !== undefined) {
		const inner = renderYear(await collectYearRows(root, layout.date.year));
		let next = replaceRegion(yearText, ROLLUP_REGION, inner);
		next = setFrontMatter(next, { updated: stamp });
		if (next !== yearText) {
			await atomicWrite(yearFile, next);
			updated.push('year');
		}
	}
	// Long-term.
	const longtermFile = layout.longterm;
	const longtermText = await readIfExists(longtermFile);
	if (longtermText !== undefined) {
		const inner = renderLongterm(await collectLongtermRows(root));
		let next = replaceRegion(longtermText, ROLLUP_REGION, inner);
		next = setFrontMatter(next, { updated: stamp });
		if (next !== longtermText) {
			await atomicWrite(longtermFile, next);
			updated.push('longterm');
		}
	}
	return { updated };
}

/**
 * Summarize the tree's shape without reading every snapshot.
 * @param {string} root - tree root.
 * @returns {Promise<{years: Array<{year: string, months: string[], days: number, snapshots: number}>, totalSnapshots: number, turnLogLines: number}>} the shape.
 */
export async function treeOverview(root) {
	const years = [];
	let totalSnapshots = 0;
	let turnLogLines = 0;
	for (const entry of await listDir(root)) {
		if (!entry.isDirectory || !YEAR_RE.test(entry.name)) continue;
		const yearDir = join(root, entry.name);
		const months = [];
		let days = 0;
		for (const month of await listDir(yearDir)) {
			if (!month.isDirectory || !MONTH_RE.test(month.name)) continue;
			months.push(month.name);
			for (const day of await listDir(join(yearDir, month.name))) {
				if (!day.isDirectory || !DAY_RE.test(day.name)) continue;
				days += 1;
				const dayFile = join(yearDir, month.name, day.name, `${entry.name}-${month.name}-${day.name}.md`);
				const text = await readIfExists(dayFile);
				if (text !== undefined) turnLogLines += countTurnLogLines(text);
			}
		}
		const snapshots = await countSnapshots(yearDir);
		totalSnapshots += snapshots;
		years.push({ year: entry.name, months, days, snapshots });
	}
	return { years, totalSnapshots, turnLogLines };
}

/**
 * Count data rows in a day file's TURN LOG region.
 * @param {string} text - the day file.
 * @returns {number} the row count.
 */
export function countTurnLogLines(text) {
	const body = regionText(text, TURNLOG_REGION);
	if (body.length === 0) return 0;
	return body
		.split('\n')
		.filter((line) => line.startsWith('|') && !/^\|\s*-{2,}/.test(line))
		.filter((line) => !/\|\s*轮次\s*\|/.test(line))
		.filter((line) => !PLACEHOLDER_ROW.test(line))
		.length;
}
