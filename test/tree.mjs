/**
 * Tree integration tests: lazy creation, idempotency, sentinel safety,
 * roll-up derivation, concurrency, and the snapshot coverage window.
 *
 * Everything runs against a temporary root, so the real tree at
 * `<MEMORY_ROOT>` is never touched by a test run.
 */

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { eq, excludes, includes, ok, report, test } from './harness.mjs';
import { PathMutex, atomicWrite, createExclusive, readIfExists } from '../lib/atomic.js';
import { writeBackup } from '../lib/backup.js';
import { frontMatterMap, frontMatterValue } from '../lib/frontmatter.js';
import { regionText, replaceRegion } from '../lib/sentinel.js';
import { nodePaths } from '../lib/paths.js';
import { DAY_SUMMARY_REGION, LEGACY_MARK, PLACEHOLDER, renderDaySummary, ROLLUP_REGION, TURNLOG_REGION } from '../lib/templates.js';
import {
	appendDaySummary,
	collectLongtermRows,
	collectMonthRows,
	collectYearRows,
	countTurnLogLines,
	ensureNode,
	findSessionWatermark,
	listSnapshots,
	readNodeSummary,
	recomputeRollups,
	SNAPSHOT_RE,
	treeOverview,
	writeNodeSummary
} from '../lib/tree.js';
import { writeSnapshot, stampSnapshotSummary } from '../lib/snapshot.js';
import { appendTurnRow, turnMarker, turnRow } from '../lib/turnlog.js';
import { turnSlice } from '../lib/events.js';

console.log('# tree operations');

const STAMP = '2026-09-13 05:00:00 +08:00';
const mutex = new PathMutex();

/**
 * Create an isolated tree root.
 * @param {string} label - suffix for the temp directory name.
 * @returns {Promise<string>} the root path.
 */
async function makeRoot(label) {
	return mkdtemp(join(tmpdir(), `memtree-${label}-`));
}

/**
 * Build a fake session whose events mimic the durable log shapes.
 * @param {{id?: string, turns?: number, seqStart?: number, provider?: string}} [options] - session options.
 * @returns {any} a session-shaped object.
 */
function fakeSession(options = {}) {
	const id = options.id ?? 'session-deadbeef-0000-4000-8000-000000000000';
	const turns = options.turns ?? 1;
	const events = [];
	let seq = options.seqStart ?? 0;
	for (let turn = 1; turn <= turns; turn += 1) {
		events.push({ type: 'turn/start', seq: seq++, time: 1_789_230_000_000, data: { turn } });
		events.push({ type: 'user/message', seq: seq++, time: 1_789_230_000_001, data: { role: 'user', content: `用户第 ${turn} 轮提问`, source: { kind: 'user' } } });
		events.push({ type: 'tool/call', seq: seq++, time: 1_789_230_000_002, data: { turn, step: 1, callId: `c${turn}`, name: 'write', arguments: JSON.stringify({ file_path: `C:\\plugin\\lib\\file${turn}.js` }) } });
		events.push({ type: 'tool/result', seq: seq++, time: 1_789_230_000_003, data: { turn, step: 1, message: { content: [{ type: 'text', text: `写入成功 ${turn}` }] } } });
		events.push({ type: 'assistant/message', seq: seq++, time: 1_789_230_000_004, data: { turn, step: 1, message: { content: [{ type: 'text', text: `第 ${turn} 轮结论` }] }, usage: { inputTokens: 1000, outputTokens: 200 } } });
		events.push({ type: 'turn/end', seq: seq++, time: 1_789_230_000_005, data: { turn, reason: { kind: 'completed' } } });
	}
	return {
		id,
		seq: events.length,
		header: { id, cwd: 'C:\\plugin', delegationDepth: 0 },
		snapshotEvents: () => events,
		eventAt: (index) => events[index],
		requestHeader: () => ({ config: { provider: options.provider ?? 'deepseek', model: 'deepseek-v4-flash' } }),
		events
	};
}

/**
 * Write a snapshot for a date with sensible defaults.
 * @param {string} root - tree root.
 * @param {any} session - the session.
 * @param {object} [overrides] - request overrides.
 * @returns {Promise<any>} the write result.
 */
async function snapshot(root, session, overrides = {}) {
	const [hour, minute, second] = overrides.clock ?? [5, 0, 0];
	return writeSnapshot({
		root,
		dateText: overrides.dateText ?? '2026-09-13',
		time: { hour, minute, second },
		stamp: overrides.stamp ?? STAMP,
		trigger: overrides.trigger ?? 'manual',
		session: { id: session.id, seq: session.seq },
		cwd: session.header.cwd,
		route: { provider: 'deepseek', model: 'deepseek-v4-flash' },
		events: session.snapshotEvents(),
		contextTokens: overrides.contextTokens ?? 512_345,
		maxBytes: overrides.maxBytes ?? 512 * 1024,
		mutex
	});
}

// ── lazy creation ───────────────────────────────────────────────────────────

await test('ensureNode creates the whole chain and nothing else', async () => {
	const root = await makeRoot('create');
	try {
		const { created, layout } = await ensureNode({ root, dateText: '2026-09-13', stamp: STAMP, mutex });
		eq(created.sort().join(','), 'day,longterm.md,month,year');
		ok(existsSync(layout.longterm), 'longterm exists');
		ok(existsSync(layout.dayFile), 'day file exists');
		ok(existsSync(layout.monthFile), 'month file exists');
		ok(existsSync(layout.yearFile), 'year file exists');
		// The root's own index.md is human/agent maintained: the plugin must
		// never create or write it.
		eq(existsSync(layout.index), false, 'index.md is NOT created by the plugin');
		// No empty directories and no gap-filling.
		eq((await readdir(root)).sort().join(','), '2026,longterm.md');
		eq((await readdir(join(root, '2026'))).sort().join(','), '09,2026.md');
		eq((await readdir(join(root, '2026', '09'))).sort().join(','), '13,2026-09.md');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

await test('ensureNode is idempotent and never rewrites existing files', async () => {
	const root = await makeRoot('idem');
	try {
		await ensureNode({ root, dateText: '2026-09-13', stamp: STAMP, mutex });
		const layout = nodePaths(root, '2026-09-13');
		// Hand-edit a file the way a human would, then re-ensure the node.
		const amended = `${await readFile(layout.dayFile, 'utf8')}\n手工补记的一行\n`;
		await writeFile(layout.dayFile, amended, 'utf8');
		const second = await ensureNode({ root, dateText: '2026-09-13', stamp: STAMP, mutex });
		eq(second.created.length, 0, 'nothing is created the second time');
		eq(await readFile(layout.dayFile, 'utf8'), amended, 'the hand-edited file is untouched');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

await test('a later day reuses its month and year and does not create the gap day', async () => {
	const root = await makeRoot('later');
	try {
		await ensureNode({ root, dateText: '2026-09-13', stamp: STAMP, mutex });
		const { created } = await ensureNode({ root, dateText: '2026-09-15', stamp: STAMP, mutex });
		eq(created.join(','), 'day', 'only the new day file is created');
		const days = (await readdir(join(root, '2026', '09'))).sort();
		eq(days.join(','), '13,15,2026-09.md', '14 is NOT created — no gap filling');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

await test('a new year gets its own node and long-term row', async () => {
	const root = await makeRoot('year');
	try {
		await ensureNode({ root, dateText: '2026-09-13', stamp: STAMP, mutex });
		const { created } = await ensureNode({ root, dateText: '2027-01-05', stamp: STAMP, mutex });
		eq(created.sort().join(','), 'day,month,year');
		ok(existsSync(join(root, '2027', '2027.md')), 'the 2027 year file exists');
		await recomputeRollups({ root, dateText: '2027-01-05', stamp: STAMP, mutex });
		const longterm = await readFile(join(root, 'longterm.md'), 'utf8');
		includes(longterm, '| 2026 |', 'the prior year keeps its row');
		includes(longterm, '| 2027 |', 'the new year is added');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

// ── hand-written text safety ────────────────────────────────────────────────

await test('hand-written text outside the regions survives every recompute', async () => {
	const root = await makeRoot('hand');
	try {
		await ensureNode({ root, dateText: '2026-09-13', stamp: STAMP, mutex });
		const layout = nodePaths(root, '2026-09-13');
		for (const [file, marker] of [
			[layout.longterm, '长期手写：跨年主题'],
			[layout.yearFile, '年度手写：这一年'],
			[layout.monthFile, '月度手写：本月重点'],
			[layout.dayFile, '当日手写：备注']
		]) {
			const text = await readFile(file, 'utf8');
			await writeFile(file, `${text}\n${marker}\n`, 'utf8');
		}
		await recomputeRollups({ root, dateText: '2026-09-13', stamp: STAMP, mutex });
		await recomputeRollups({ root, dateText: '2026-09-13', stamp: STAMP, mutex });
		includes(await readFile(layout.longterm, 'utf8'), '长期手写：跨年主题');
		includes(await readFile(layout.yearFile, 'utf8'), '年度手写：这一年');
		includes(await readFile(layout.monthFile, 'utf8'), '月度手写：本月重点');
		includes(await readFile(layout.dayFile, 'utf8'), '当日手写：备注');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

await test('recomputeRollups is byte-stable (idempotent)', async () => {
	const root = await makeRoot('stable');
	try {
		const session = fakeSession({ turns: 2 });
		await ensureNode({ root, dateText: '2026-09-13', stamp: STAMP, mutex });
		await snapshot(root, session);
		await recomputeRollups({ root, dateText: '2026-09-13', stamp: STAMP, mutex });
		const layout = nodePaths(root, '2026-09-13');
		const before = await Promise.all([layout.dayFile, layout.monthFile, layout.yearFile, layout.longterm].map((file) => readFile(file, 'utf8')));
		const second = await recomputeRollups({ root, dateText: '2026-09-13', stamp: STAMP, mutex });
		const after = await Promise.all([layout.dayFile, layout.monthFile, layout.yearFile, layout.longterm].map((file) => readFile(file, 'utf8')));
		eq(after.join('\u0000'), before.join('\u0000'), 'a second recompute changes nothing');
		eq(second.updated.length, 0, 'and reports no updates');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

await test('a lost roll-up block is restored from tree truth', async () => {
	const root = await makeRoot('heal');
	try {
		const session = fakeSession({ turns: 1 });
		await ensureNode({ root, dateText: '2026-09-13', stamp: STAMP, mutex });
		await snapshot(root, session);
		const layout = nodePaths(root, '2026-09-13');
		const month = await readFile(layout.monthFile, 'utf8');
		// Simulate a crash that dropped the whole day block.
		await writeFile(layout.monthFile, month.replace(/### 13 日[\s\S]*?(?=<!-- END MACHINE ROLLUP -->)/, ''), 'utf8');
		eq((await readFile(layout.monthFile, 'utf8')).includes('### 13 日'), false, 'the block really is gone');
		await recomputeRollups({ root, dateText: '2026-09-13', stamp: STAMP, mutex });
		const healed = await readFile(layout.monthFile, 'utf8');
		includes(healed, '### 13 日', 'the block comes back because it is re-derived, not carried forward');
		includes(healed, '1 份快照', 'with its derived counts intact');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

// ── snapshot coverage ───────────────────────────────────────────────────────

await test('a snapshot records its header, coverage range, and verbatim text', async () => {
	const root = await makeRoot('snap');
	try {
		const session = fakeSession({ turns: 2 });
		await ensureNode({ root, dateText: '2026-09-13', stamp: STAMP, mutex });
		const written = await snapshot(root, session, { trigger: 'pressure', contextTokens: 501_000 });
		eq(written.status, 'written');
		eq(written.fromSeq, 0, 'the first snapshot starts at seq 0');
		eq(written.toSeq, session.seq - 1);
		const text = await readFile(written.path, 'utf8');
		eq(frontMatterValue(text, 'kind'), 'memory-snapshot');
		eq(frontMatterValue(text, 'trigger'), 'pressure');
		eq(frontMatterValue(text, 'fromSeq'), '0');
		eq(frontMatterValue(text, 'toSeq'), String(session.seq - 1));
		eq(frontMatterValue(text, 'contextTokens'), '501000');
		eq(frontMatterValue(text, 'date'), '2026-09-13');
		includes(frontMatterValue(text, 'route'), 'deepseek/deepseek-v4-flash');
		includes(text, '用户第 1 轮提问', 'verbatim user text is preserved');
		includes(text, '第 2 轮结论', 'verbatim assistant text is preserved');
		includes(text, 'file1.js', 'tool call arguments are preserved');
		ok(SNAPSHOT_RE.test(written.file), 'the file name matches the documented pattern');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

await test('a second snapshot covers only the new events', async () => {
	const root = await makeRoot('cover');
	try {
		const session = fakeSession({ turns: 1 });
		await ensureNode({ root, dateText: '2026-09-13', stamp: STAMP, mutex });
		const first = await snapshot(root, session, { clock: [5, 0, 0] });
		eq(first.toSeq, session.seq - 1);
		// More events arrive in the same session.
		const grown = fakeSession({ turns: 3 });
		const second = await snapshot(root, grown, { clock: [5, 10, 0] });
		eq(second.fromSeq, first.toSeq + 1, 'coverage starts where the last snapshot ended');
		const text = await readFile(second.path, 'utf8');
		excludes(text, '用户第 1 轮提问', 'already-covered events are not duplicated');
		includes(text, '用户第 3 轮提问', 'new events are included');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

await test('a snapshot on a NEW DAY continues the session record instead of re-slicing from zero', async () => {
	// The defect this pins down: the watermark was looked up in the CURRENT DAY's
	// directory, so every midnight the session looked as though it had never
	// snapped and the first snapshot of the new day re-sliced the whole session.
	// On 2026-09-14 that spent the full 4 MB slice budget re-recording what
	// thirteen snapshots already held, and — because a slice kept its head — left
	// the genuinely new range in no snapshot at all.
	const root = await makeRoot('dayboundary');
	try {
		await ensureNode({ root, dateText: '2026-09-13', stamp: STAMP, mutex });
		const session = fakeSession({ turns: 1 });
		const first = await snapshot(root, session, { dateText: '2026-09-13', clock: [22, 40, 0] });
		eq(first.status, 'written');
		eq(first.fromSeq, 0, 'the first snapshot of a session starts at zero');

		// Midnight passes; the same session keeps working.
		await ensureNode({ root, dateText: '2026-09-14', stamp: STAMP, mutex });
		const grown = fakeSession({ turns: 3 });
		const second = await snapshot(root, grown, { dateText: '2026-09-14', clock: [9, 40, 0] });

		eq(second.status, 'written');
		eq(second.fromSeq, first.toSeq + 1, 'the new day resumes exactly where the session record ended');
		const text = await readFile(second.path, 'utf8');
		excludes(text, '用户第 1 轮提问', 'yesterday is NOT re-recorded into today');
		includes(text, '用户第 3 轮提问', 'only the uncovered events are sliced');
		eq(frontMatterValue(text, 'date'), '2026-09-14');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

await test('the watermark search stops at the newest day that has this session', async () => {
	const root = await makeRoot('watermark');
	try {
		// Two sessions, three days. Each session's watermark must come from ITS OWN
		// snapshots, and a day belonging to another session must not be mistaken for
		// "this session has never snapped".
		await ensureNode({ root, dateText: '2026-09-13', stamp: STAMP, mutex });
		await ensureNode({ root, dateText: '2026-09-14', stamp: STAMP, mutex });
		await ensureNode({ root, dateText: '2026-09-15', stamp: STAMP, mutex });
		const mine = fakeSession({ turns: 1 });
		const other = fakeSession({ id: 'session-bbbb', turns: 1 });
		const day13 = await snapshot(root, mine, { dateText: '2026-09-13', clock: [5, 0, 0] });
		await snapshot(root, other, { dateText: '2026-09-15', clock: [5, 0, 0] });

		eq(await findSessionWatermark({ root, dateText: '2026-09-14', sessionId: mine.id }), day13.toSeq, 'found across a day with no snapshots');
		eq(await findSessionWatermark({ root, dateText: '2026-09-14', sessionId: other.id }), -1, 'the other session has nothing on or before the 14th');
		// The other session DID snap on the 15th. Asking about the 15th for `mine`
		// must still return its own watermark, not the other session's — this is the
		// "per session" half of the rule, and it is why the lookup cannot simply
		// take the newest snapshot in the tree.
		eq(await findSessionWatermark({ root, dateText: '2026-09-15', sessionId: mine.id }), day13.toSeq, "another session's snapshot never advances mine");
		ok((await findSessionWatermark({ root, dateText: '2026-09-15', sessionId: other.id })) >= 0, 'and the other session finds its own');
		eq(await findSessionWatermark({ root, dateText: '2026-09-13', sessionId: 'session-never' }), -1);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

await test('snapshotting with nothing new is a no-op', async () => {
	const root = await makeRoot('empty');
	try {
		const session = fakeSession({ turns: 1 });
		await ensureNode({ root, dateText: '2026-09-13', stamp: STAMP, mutex });
		await snapshot(root, session);
		const again = await snapshot(root, session, { clock: [5, 5, 0] });
		eq(again.status, 'empty', 'the second snapshot has nothing to record');
		eq((await listSnapshots(nodePaths(root, '2026-09-13').dayDir)).length, 1, 'no second file appears');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

await test('two snapshots in the same second get distinct names', async () => {
	const root = await makeRoot('collide');
	try {
		const session = fakeSession({ turns: 1 });
		await ensureNode({ root, dateText: '2026-09-13', stamp: STAMP, mutex });
		const first = await snapshot(root, session, { clock: [5, 0, 0] });
		// Force a distinct file by faking a different session but the same clock.
		const other = fakeSession({ id: 'session-aaaaaaaa-1111-2222-3333-444444444444', turns: 1 });
		const second = await snapshot(root, other, { clock: [5, 0, 0] });
		ok(first.file !== second.file, 'different sessions never collide on the same second');
		eq((await listSnapshots(nodePaths(root, '2026-09-13').dayDir)).length, 2);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

// `nextUncoveredSeq` used to be tested here. It was removed with the function:
// it took a snapshot LIST from the caller, and the caller passed the current
// day's, so the test that asserted "no snapshots → seq 0" was locking in the
// exact answer that made every day boundary re-slice the session. The behaviour
// it was protecting is now covered by `findSessionWatermark`, above, which
// cannot be called with the wrong snapshot set because it finds them itself.

await test('stampSnapshotSummary rewrites only the header summary', async () => {
	const root = await makeRoot('stamp');
	try {
		const session = fakeSession({ turns: 1 });
		await ensureNode({ root, dateText: '2026-09-13', stamp: STAMP, mutex });
		const written = await snapshot(root, session);
		await stampSnapshotSummary(written.path, '一句话结论');
		const text = await readFile(written.path, 'utf8');
		eq(frontMatterValue(text, 'summary'), '一句话结论');
		includes(text, '用户第 1 轮提问', 'the verbatim body is untouched');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

// ── roll-ups ────────────────────────────────────────────────────────────────

await test('roll-ups flow upward: day index → month → year → long-term', async () => {
	const root = await makeRoot('rollup');
	try {
		const session = fakeSession({ turns: 1 });
		await ensureNode({ root, dateText: '2026-09-13', stamp: STAMP, mutex });
		const written = await snapshot(root, session);
		await stampSnapshotSummary(written.path, '修好了定位 bug');
		await writeNodeSummary(nodePaths(root, '2026-09-13').dayFile, '第一天：骨架完成', STAMP);
		await appendDaySummary({
			dayFile: nodePaths(root, '2026-09-13').dayFile,
			entries: ['骨架搭好，第一份快照落盘'],
			clock: '05:00',
			stamp: STAMP
		});
		await recomputeRollups({ root, dateText: '2026-09-13', stamp: STAMP, mutex });

		const layout = nodePaths(root, '2026-09-13');
		const day = await readFile(layout.dayFile, 'utf8');
		includes(day, written.file, 'the day index links the snapshot');
		includes(day, '修好了定位 bug', 'the index shows the snapshot gist');
		includes(day, '#0–#', 'the index shows the coverage range');
		includes(day, '| manual |', 'the trigger column carries the trigger');

		const month = await readFile(layout.monthFile, 'utf8');
		includes(month, '### 13 日 · 2026-09-13', 'the month has a block per day');
		includes(month, '- **05:00** 骨架搭好，第一份快照落盘', "the block carries the day's own events");
		includes(month, '1 份快照', 'and the day snapshot count');
		includes(month, '[日文件](13/2026-09-13.md)', 'and links the day file');

		const year = await readFile(layout.yearFile, 'utf8');
		includes(year, '09/2026-09.md', 'the year row links the month file');

		const longterm = await readFile(layout.longterm, 'utf8');
		includes(longterm, '| 2026 |', 'the long-term table lists the year');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

await test('collectors derive counts from the filesystem', async () => {
	const root = await makeRoot('counts');
	try {
		await ensureNode({ root, dateText: '2026-09-13', stamp: STAMP, mutex });
		await ensureNode({ root, dateText: '2026-09-20', stamp: STAMP, mutex });
		await ensureNode({ root, dateText: '2026-10-02', stamp: STAMP, mutex });
		const session = fakeSession({ turns: 1 });
		await snapshot(root, session, { dateText: '2026-09-13' });
		const second = fakeSession({ id: 'session-bbbb', turns: 1, seqStart: 100 });
		await writeSnapshot({
			root,
			dateText: '2026-09-20',
			time: { hour: 6, minute: 0, second: 0 },
			stamp: STAMP,
			trigger: 'manual',
			session: { id: second.id, seq: second.seq },
			cwd: 'C:\\x',
			route: { provider: 'p', model: 'm' },
			events: second.snapshotEvents().map((event, index) => ({ ...event, seq: index })),
			contextTokens: 1,
			maxBytes: 1024,
			mutex
		});
		const monthRows = await collectMonthRows(root, '2026', '09');
		eq(monthRows.map((row) => row.day).join(','), '13,20');
		eq(monthRows[0].snapshots, 1);
		eq(monthRows[1].snapshots, 1);
		const yearRows = await collectYearRows(root, '2026');
		eq(yearRows.map((row) => row.month).join(','), '09,10');
		eq(yearRows[0].days, 2, 'two days in September');
		eq(yearRows[0].snapshots, 2, 'snapshot count rolls up through the month');
		eq(yearRows[1].days, 1);
		const longtermRows = await collectLongtermRows(root);
		eq(longtermRows.length, 1);
		eq(longtermRows[0].months, 2, 'two months in 2026');
		eq(longtermRows[0].snapshots, 2);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

await test('placeholders are reported until a real gist exists', async () => {
	const root = await makeRoot('placeholder');
	try {
		await ensureNode({ root, dateText: '2026-09-13', stamp: STAMP, mutex });
		const layout = nodePaths(root, '2026-09-13');
		eq(await readNodeSummary(layout.dayFile), PLACEHOLDER);
		await writeNodeSummary(layout.dayFile, '真摘要', STAMP);
		eq(await readNodeSummary(layout.dayFile), '真摘要');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

// ── day summary region ──────────────────────────────────────────────────────

await test('the day entry log survives an append, a snapshot, and a roll-up recompute', async () => {
	const root = await makeRoot('prose');
	try {
		const session = fakeSession({ turns: 1 });
		await ensureNode({ root, dateText: '2026-09-13', stamp: STAMP, mutex });
		const layout = nodePaths(root, '2026-09-13');
		const first = await appendDaySummary({
			dayFile: layout.dayFile,
			entries: ['IDictionary 读不到键，已修'],
			clock: '05:00',
			stamp: STAMP
		});
		eq(first.added.length, 1);
		eq(first.total, 1);
		const second = await appendDaySummary({
			dayFile: layout.dayFile,
			entries: ['接着补了回归测试'],
			clock: '05:30',
			stamp: STAMP
		});
		eq(second.total, 2, 'the second append adds to the first rather than replacing it');
		const body = () => readFile(layout.dayFile, 'utf8').then((text) => regionText(text, DAY_SUMMARY_REGION));
		includes(await body(), 'IDictionary', 'the first entry is still there after the second append');
		await snapshot(root, session);
		await recomputeRollups({ root, dateText: '2026-09-13', stamp: STAMP, mutex });
		const after = await body();
		includes(after, 'IDictionary', 'a roll-up recompute must not erase model output');
		includes(after, '回归测试');
		eq(after.split('\n').filter((line) => line.startsWith('- **')).length, 2, 'exactly the two entries');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

await test('a pre-log day summary is migrated verbatim under the legacy marker', async () => {
	const root = await makeRoot('legacy');
	try {
		await ensureNode({ root, dateText: '2026-09-13', stamp: STAMP, mutex });
		const layout = nodePaths(root, '2026-09-13');
		// Write the region the way the previous implementation did, then append.
		const before = await readFile(layout.dayFile, 'utf8');
		await writeFile(layout.dayFile, replaceRegion(before, DAY_SUMMARY_REGION, renderDaySummary([]).replace('（待首次快照后填写）', '- 用户要求做电脑控制插件')), 'utf8');
		const result = await appendDaySummary({
			dayFile: layout.dayFile,
			entries: ['重启后实测通过'],
			clock: '22:40',
			stamp: STAMP
		});
		eq(result.migrated, true);
		const text = await readFile(layout.dayFile, 'utf8');
		includes(text, '用户要求做电脑控制插件', 'the old prose is preserved');
		includes(text, '重启后实测通过', 'the new entry is recorded');
		includes(regionText(text, DAY_SUMMARY_REGION), LEGACY_MARK);
		eq(await readNodeSummary(layout.dayFile), PLACEHOLDER, 'a migration does not invent a one-line summary either');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

// ── turn log ────────────────────────────────────────────────────────────────

await test('the turn log appends one row per turn and dedupes replays', async () => {
	const root = await makeRoot('turnlog');
	try {
		const session = fakeSession({ turns: 2 });
		const { layout } = await ensureNode({ root, dateText: '2026-09-13', stamp: STAMP, mutex });
		for (const turn of [1, 2]) {
			const slice = turnSlice(session.events, turn);
			const row = turnRow({ clock: `05:0${turn}:00`, turn, sessionToken: 'deadbeef', delta: 1200 * turn, files: slice.files, headline: slice.headline });
			eq(await appendTurnRow({ dayFile: layout.dayFile, row, marker: turnMarker(turn, 'deadbeef'), mutex }), 'appended');
		}
		// A replayed hook for turn 2 must not duplicate the line.
		const replay = turnRow({ clock: '05:02:30', turn: 2, sessionToken: 'deadbeef', delta: 0, files: [], headline: '重放' });
		eq(await appendTurnRow({ dayFile: layout.dayFile, row: replay, marker: turnMarker(2, 'deadbeef'), mutex }), 'duplicate');
		const text = await readFile(layout.dayFile, 'utf8');
		eq(countTurnLogLines(text), 2, 'exactly two rows');
		includes(text, '第 1 轮结论', 'the headline is the turn conclusion');
		includes(text, 'file1.js', 'the changed-file column is filled');
		eq(text.split(turnMarker(2, 'deadbeef')).length - 1, 1, 'turn 2 appears exactly once');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

await test("appending a turn row also advances the day file's updated stamp", async () => {
	const root = await makeRoot('updated');
	try {
		const { layout } = await ensureNode({ root, dateText: '2026-09-13', stamp: STAMP, mutex });
		eq(frontMatterValue(await readFile(layout.dayFile, 'utf8'), 'updated'), STAMP, 'the create stamp is written');
		// Regression: the stamp used to move only on a snapshot, so a day whose
		// only activity was turns claimed it had not been touched since the last
		// snapshot — observed in the live tree, where the log reached 05:00 while
		// `updated` still said 04:47.
		const later = '2026-09-13 05:30:00 +08:00';
		const row = turnRow({ clock: '05:30:00', turn: 9, sessionToken: 'abc', delta: 1, files: [], headline: 'h' });
		await appendTurnRow({ dayFile: layout.dayFile, row, marker: turnMarker(9, 'abc'), mutex, stamp: later });
		eq(frontMatterValue(await readFile(layout.dayFile, 'utf8'), 'updated'), later, 'the stamp names the last write of any kind');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

await test('concurrent turn rows from two sessions both survive', async () => {
	const root = await makeRoot('concurrent');
	try {
		const { layout } = await ensureNode({ root, dateText: '2026-09-13', stamp: STAMP, mutex });
		const jobs = [];
		for (let index = 0; index < 12; index += 1) {
			const token = index % 2 === 0 ? 'aaaa1111' : 'bbbb2222';
			const turn = Math.floor(index / 2) + 1;
			const row = turnRow({ clock: `06:00:${String(index).padStart(2, '0')}`, turn, sessionToken: token, delta: index, files: [], headline: `轮 ${index}` });
			jobs.push(appendTurnRow({ dayFile: layout.dayFile, row, marker: turnMarker(turn, token), mutex }));
		}
		const results = await Promise.all(jobs);
		eq(results.filter((result) => result === 'appended').length, 12, 'every write landed');
		eq(countTurnLogLines(await readFile(layout.dayFile, 'utf8')), 12, 'no row was lost to a race');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

await test('the turn log region is added to an older day file that lacks it', async () => {
	const root = await makeRoot('migrate');
	try {
		await ensureNode({ root, dateText: '2026-09-13', stamp: STAMP, mutex });
		const layout = nodePaths(root, '2026-09-13');
		// Strip the TURN LOG and DAY SUMMARY regions to imitate an older file.
		const text = await readFile(layout.dayFile, 'utf8');
		const withoutTurnLog = text.replace(/<!-- BEGIN TURN LOG -->[\s\S]*<!-- END TURN LOG -->\n?/, '');
		const older = withoutTurnLog.replace(/<!-- BEGIN DAY SUMMARY -->[\s\S]*<!-- END DAY SUMMARY -->\n?/, '');
		await writeFile(layout.dayFile, older, 'utf8');
		excludes(older, 'BEGIN TURN LOG');
		const added = await ensureNode({ root, dateText: '2026-09-13', stamp: STAMP, mutex });
		eq(added.created.length, 0, 'the file itself is not recreated');
		const migrated = await readFile(layout.dayFile, 'utf8');
		includes(migrated, '<!-- BEGIN TURN LOG -->', 'the region is added in place');
		includes(migrated, '<!-- BEGIN DAY SUMMARY -->', 'the summary region is added in place');
		includes(migrated, '<!-- BEGIN MACHINE ROLLUP -->', 'the existing roll-up region is preserved');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

// ── housekeeping ────────────────────────────────────────────────────────────

await test('a non-numeric directory at the tree root is invisible to the tree', async () => {
	const root = await makeRoot('invisible');
	try {
		const session = fakeSession({ turns: 1 });
		await ensureNode({ root, dateText: '2026-09-13', stamp: STAMP, mutex });
		await snapshot(root, session);
		// The `_bootstrap` recovery bundle lives at the tree root on purpose (it
		// is the one place that survives a workspace or ~/.dsh wipe). It must stay
		// invisible: `treeOverview` whitelists YEAR_RE/MONTH_RE/DAY_RE, and the
		// search path builds its file list by concatenation instead of readdir. A
		// regression here would silently pull recovery documentation into every
		// search result and every roll-up.
		await mkdir(join(root, '_bootstrap'), { recursive: true });
		await writeFile(join(root, '_bootstrap', 'README.md'), '# bootstrap marker\n', 'utf8');
		const overview = await treeOverview(root);
		eq(overview.years.length, 1, 'a non-numeric directory is not a year');
		eq(overview.years[0].year, '2026');
		eq(overview.years[0].days, 1);
		eq(overview.totalSnapshots, 1, 'and it contributes no snapshots');
		eq(overview.turnLogLines, 0, 'nor turn rows');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

await test('treeOverview reports the shape without reading snapshots', async () => {
	const root = await makeRoot('overview');
	try {
		const session = fakeSession({ turns: 1 });
		const { layout } = await ensureNode({ root, dateText: '2026-09-13', stamp: STAMP, mutex });
		await snapshot(root, session);
		await appendTurnRow({ dayFile: layout.dayFile, row: '| 05:00:00 | T1·x | +1 | — | h |', marker: '| T1·x |', mutex });
		const overview = await treeOverview(root);
		eq(overview.years.length, 1);
		eq(overview.years[0].year, '2026');
		eq(overview.years[0].days, 1);
		eq(overview.years[0].snapshots, 1);
		eq(overview.totalSnapshots, 1);
		eq(overview.turnLogLines, 1);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

await test('atomic writes leave no temp files behind', async () => {
	const root = await makeRoot('tmp');
	try {
		const session = fakeSession({ turns: 1 });
		const { layout } = await ensureNode({ root, dateText: '2026-09-13', stamp: STAMP, mutex });
		await snapshot(root, session);
		await recomputeRollups({ root, dateText: '2026-09-13', stamp: STAMP, mutex });
		const names = await readdir(layout.dayDir);
		eq(names.filter((entry) => entry.endsWith('.tmp')).length, 0, 'no .tmp litter in the day directory');
		eq(names.filter((entry) => entry.startsWith('.')).length, 0, 'no hidden temp files either');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

await test('a fresh root is created lazily, without pre-making directories', async () => {
	const root = await makeRoot('lazy');
	try {
		// A brand-new root has nothing in it: no year, no month, no longterm.
		eq((await readdir(root)).length, 0);
		await ensureNode({ root, dateText: '2026-09-13', stamp: STAMP, mutex });
		const entries = await readdir(root);
		eq(entries.includes('2026'), true);
		eq(entries.includes('longterm.md'), true);
		const only = await stat(join(root, '2026'));
		ok(only.isDirectory());
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

await test('readIfExists tolerates absence', async () => {
	eq(await readIfExists(join(tmpdir(), '__memtree-never-exists__.md')), undefined);
});

// ── the write boundary scrubs ───────────────────────────────────────────────
// The human's rule is 「敏感值在写入那一刻就屏蔽」. The tree is append-only, so the
// only place "never in the tree" can still be true is *before* the first write —
// these two tests pin that the choke point in `atomic.js` really does it, for
// both writers, rather than trusting the comment that says so.

/**
 * A routable-looking address, assembled at runtime.
 *
 * Deliberately NOT a literal: this file is copied into the recovery bundle that
 * lives inside the tree, and writing a public address there is exactly what the
 * scrubber under test exists to prevent — a literal fixture would be masked in
 * the bundled copy and the copy would then assert the wrong thing.
 * @param {number} a - first octet.
 * @param {number} b - second octet.
 * @param {number} c - third octet.
 * @param {number} d - fourth octet.
 * @returns {string} the dotted form.
 */
const publicIp = (a, b, c, d) => [a, b, c, d].join('.');

await test('atomicWrite masks a sensitive literal before it reaches the disk', async () => {
	const root = await makeRoot('redact-atomic');
	try {
		const target = join(root, '2026', '09', '2026-09-15.md');
		const id = 'D'.repeat(32);
		const host = publicIp(203, 0, 113, 9);
		const outcome = await atomicWrite(target, `# 日志\n云端主机 ${host} · peerId=${id}\n`);
		eq(outcome.redacted, 2, 'both literals were replaced on the way in');
		const onDisk = await readFile(target, 'utf8');
		excludes(onDisk, id, 'the id is not in the file');
		excludes(onDisk, host, 'the address is not in the file');
		includes(onDisk, '[REDACTED-IP]');
		// The archive must still be readable prose: only the literal is gone.
		includes(onDisk, '云端主机');
		includes(onDisk, 'peerId=');
		eq(onDisk.split('\n').length, 3, 'line structure is untouched');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

await test('createExclusive masks too, so a template is not a way in', async () => {
	const root = await makeRoot('redact-exclusive');
	try {
		const target = join(root, 'longterm.md');
		const relay = publicIp(198, 51, 100, 7);
		eq(await createExclusive(target, `初值 ${relay}\n`), 'created');
		excludes(await readFile(target, 'utf8'), relay);
		eq(await createExclusive(target, 'x'), 'existed', 'the race rule is unchanged');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

await test('writeBackup masks the recovery bundle and leaves the workspace copy alone', async () => {
	const root = await makeRoot('redact-bundle');
	const source = await makeRoot('redact-source');
	try {
		// A miniature workspace: one directory asset with a text file carrying both
		// classes, one binary-ish asset that must stay byte-for-byte, and one plain
		// file asset.
		const pluginDir = join(source, 'plugins', 'demo-plugin');
		await mkdir(join(pluginDir, 'lib'), { recursive: true });
		const id = 'E'.repeat(32);
		const host = publicIp(203, 0, 113, 9);
		const relay = publicIp(192, 0, 2, 44);
		await writeFile(join(pluginDir, 'lib', 'index.js'), `export const HOST = '${host}';\nexport const ID = '${id}';\n`, 'utf8');
		await writeFile(join(pluginDir, 'lib', 'icon.png'), `not-really-a-png ${host}`, 'utf8');
		const single = join(source, 'AGENTS.md');
		await writeFile(single, `see ${relay} for the relay\n`, 'utf8');

		const assets = [
			{ to: 'plugins/demo-plugin', from: pluginDir, kind: 'dir', note: '演示插件' },
			{ to: 'rules/AGENTS.md', from: single, kind: 'file', note: '规则' }
		];
		const outcome = writeBackup({ root, assets, stamp: '2026-09-15 16:00:00' });

		// The bundle is clean...
		const bundled = await readFile(join(root, '_bootstrap', 'plugins', 'demo-plugin', 'lib', 'index.js'), 'utf8');
		excludes(bundled, id, 'the id never reaches the tree');
		excludes(bundled, host, 'nor does the address');
		includes(bundled, '[REDACTED]');
		includes(bundled, '[REDACTED-IP]');
		includes(await readFile(join(root, '_bootstrap', 'rules', 'AGENTS.md'), 'utf8'), '[REDACTED-IP]');

		// ...while the source keeps its real values, because scripts there need them.
		includes(await readFile(join(pluginDir, 'lib', 'index.js'), 'utf8'), id, 'the workspace copy is untouched');
		includes(await readFile(single, 'utf8'), relay);

		// A non-text asset is copied verbatim and is not treated as text.
		eq(await readFile(join(root, '_bootstrap', 'plugins', 'demo-plugin', 'lib', 'icon.png'), 'utf8'), `not-really-a-png ${host}`, 'a .png is not treated as text');

		// The accounting is visible where an operator will look for it.
		eq(outcome.scrubbed, 3, 'two in the plugin source plus one in the rule file');
		const manifest = await readFile(join(root, '_bootstrap', 'MANIFEST.md'), 'utf8');
		includes(manifest, '已脱敏 3 处');
		includes(manifest, '已脱敏 2 处', 'the per-entry marker names the asset');
		const readme = await readFile(join(root, '_bootstrap', 'README.md'), 'utf8');
		includes(readme, '被遮蔽的值');
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(source, { recursive: true, force: true });
	}
});

// ── a session whose log changed seq space (DSH 2.0.10) ──────────────────────
// The live log became `session.v3.jsonl.zstd`, whose seq restarts near 0, while the
// tree still holds snapshots numbered in the old space (millions). Comparing the two
// made `toSeq < fromSeq` true for good, so EVERY snapshot answered `empty` — the tree
// stopped summarising while still writing turn-log rows, i.e. it looked healthy.
// These tests pin the rebase, and pin that it happens exactly once.

await test('a renumbered log rebases onto time, and only once', async () => {
	const root = await makeRoot('rebase');
	try {
		// 1) A snapshot from the OLD seq space: the watermark the update made unreachable.
		const old = fakeSession({ turns: 1, seqStart: 2_790_000 });
		old.seq = 2_790_000 + old.events.length;
		const first = await snapshot(root, old, { stamp: '2026-09-13 05:00:00 +08:00' });
		eq(first.status, 'written', 'the old-space snapshot is written');
		ok(first.toSeq >= 2_790_000, 'and it carries the high watermark');

		// 2) Same conversation after the update: seq near 0, events NEWER than that snapshot.
		const fresh = fakeSession({ turns: 1, seqStart: 0 });
		const after = Date.parse('2026-09-14T11:00:00+08:00');
		for (const event of fresh.events) event.time = after;
		fresh.seq = fresh.events.length;
		const second = await snapshot(root, fresh, { stamp: '2026-09-14 10:00:00 +08:00' });
		eq(second.status, 'written', 'the rebased snapshot is WRITTEN, not "empty"');
		eq(second.fromSeq, 0, 'coverage restarts at the new log\'s first seq');
		ok(second.toSeq < 100, 'and ends inside the new space');

		// 3) One rebase is enough. If the watermark were still "highest toSeq overall",
		//    the next call would rebase again and re-record everything.
		const next = fakeSession({ turns: 1, seqStart: fresh.seq });
		for (const event of next.events) event.time = after + 60_000;
		next.seq = fresh.seq + next.events.length;
		const third = await snapshot(root, next, { stamp: '2026-09-14 12:00:00 +08:00' });
		eq(third.status, 'written', 'the following snapshot is written too');
		eq(third.fromSeq, fresh.seq, 'and starts exactly where the rebased one ended — nothing is re-recorded');

		// 4) The rebase must not invent content: a log with nothing newer than the newest
		//    snapshot still answers empty.
		const stale = fakeSession({ turns: 1, seqStart: 0 });
		for (const event of stale.events) event.time = Date.parse('2026-09-13T01:00:00+08:00');
		stale.seq = stale.events.length;
		eq((await snapshot(root, stale, { stamp: '2026-09-14 13:00:00 +08:00' })).status, 'empty', 'nothing newer ⇒ still empty');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

report();
