/**
 * Service integration tests: the real production path, with the harness
 * faked out.
 *
 * The tree tests exercise the pieces; these exercise `MemoryService` itself —
 * trigger detection, the snapshot pipeline (snapshot → call 1 → call 2 →
 * roll-ups), the per-turn hook, the drill-down reads, search, and the probe.
 * A fake `ctx` supplies `llm`, `tokenMeter`, and `logger`, so the whole thing
 * runs in milliseconds without a DSH host — which is exactly why it can catch
 * argument-name and wiring mistakes that unit tests cannot.
 */

import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { eq, excludes, includes, ok, report, test } from './harness.mjs';
import { MemoryService, resolveConfig, thresholdFor } from '../lib/service.js';
import { planAssets, writeBackup } from '../lib/backup.js';
import { frontMatterValue } from '../lib/frontmatter.js';
import { regionText } from '../lib/sentinel.js';
import { DEFAULT_ROOT, nodePaths } from '../lib/paths.js';
import { listSnapshots } from '../lib/tree.js';
import { zstdCompressSync } from 'node:zlib';
import { DAY_SUMMARY_REGION, MEDIA_REGION, PLACEHOLDER, TURNLOG_REGION } from '../lib/templates.js';

console.log('# service pipeline');

const STAMP_TIME = new Date('2026-09-12T21:00:00Z'); // 2026-09-13 05:00 +08:00

/**
 * Script a chunk stream producing `body`.
 * @param {string} body - the answer text.
 * @returns {any[]} the chunks.
 */
function textStream(body) {
	return [
		{ type: 'block-start', index: 0, blockType: 'text' },
		{ type: 'text-delta', index: 0, text: body },
		{ type: 'block-end', index: 0, block: { text: body } },
		{ type: 'finish', reason: { kind: 'stop' } }
	];
}

/**
 * Call 1 answers in two sections: the SLICE's own one-liner — which becomes that
 * snapshot's row in the day's index — and the day's new entries. Keeping them
 * separate is the point; `summarizeDay` explains why.
 */
const DAY_ANSWERS = [
	'## 一句话\n快照与 roll-up 打通，两处语法错误被预检抓到\n\n## 事件\n- 快照与 roll-up 打通\n- 两处 readonly 语法错误被预检抓到\n',
	'## 一句话\n修好了压力触发重复，并合并了设备控制授权卡\n\n## 事件\n- 修好了压力触发重复\n- 合并了设备控制授权卡\n',
	'## 一句话\n又一轮的改动\n\n## 事件\n- 又一轮的条目\n'
];
const UPPER_ANSWER = '## 当日\n记忆树插件骨架建好：快照与 roll-up 打通，两处语法错误被预检抓到\n\n## 月\n九月：记忆树从规则到实现\n\n## 年\n2026：把 DSH 变成有长期记忆的工作台\n\n## 长期\n持续给 agent 加上可靠的持久记忆与控制能力\n';

/**
 * Build a fake llm whose answer depends on the system prompt it receives.
 *
 * The day answers VARY per call on purpose. A fake that repeats one answer
 * would make every second snapshot's entries duplicates of the first — which
 * the append path suppresses, so the test would be measuring the dedup guard
 * while believing it was measuring the append.
 * @param {{calls: any[], fail?: boolean, dayAnswer?: string}} record - capture sink.
 * @returns {any} the fake service.
 */
function fakeLlm(record) {
	let dayCall = 0;
	return {
		stream(options) {
			record.calls.push(options);
			if (record.fail === true) throw new Error('llm unavailable');
			// Keyed on a heading only the roll-up prompt carries, so a rewording of
			// either system prompt cannot silently swap the two answers.
			const isUpper = typeof options.system === 'string' && options.system.includes('## 长期');
			// `record.dayAnswer` lets one test script a specific answer (the cap test
			// needs ten entries); otherwise the answers rotate. The counter advances
			// ONLY for day calls — incrementing it on the roll-up call too made the
			// third snapshot pick the third answer instead of the second, and the
			// test failed looking like an append bug rather than a fake-llm bug.
			let body = UPPER_ANSWER;
			if (!isUpper) {
				body = record.dayAnswer ?? DAY_ANSWERS[dayCall] ?? DAY_ANSWERS[DAY_ANSWERS.length - 1];
				dayCall += 1;
			}
			return (async function* generate() {
				for (const chunk of textStream(body)) yield chunk;
			})();
		}
	};
}

/**
 * Build a fake plugin context.
 *
 * The token meter returns the REAL `measure()` shape, verified against
 * `dsh-token-meter`: `{logRevision, baseline, surfaceDeltaTokens, totalTokens,
 * surfaceTokens, nodes}`. An earlier version of this fake returned
 * `{projectedTokens, contextWindow}`, which are NOT fields the real service
 * has — so the fake silently validated a wrapper that never worked, and the
 * entire pressure trigger was dead while every test passed. A fake must mirror
 * the real contract, never the assumption about it.
 * @param {{llm: any, projectedTokens: number}} input - services to expose.
 * @returns {any} a context-shaped object.
 */
function fakeCtx({ llm, projectedTokens, attachments }) {
	const warnings = [];
	return {
		warnings,
		get(name) {
			if (name === 'llm') return llm;
			if (name === 'tokenMeter') return { measure: () => realMeasurement(projectedTokens) };
			if (name === 'attachments') return attachments;
			return undefined;
		},
		logger: { warn: (message) => warnings.push(String(message)), info: () => {} }
	};
}

/**
 * The exact object shape `tokenMeter.measure(session)` returns.
 * @param {number} totalTokens - the occupancy to report.
 * @returns {any} the measurement.
 */
function realMeasurement(totalTokens) {
	return {
		logRevision: 42,
		baseline: { kind: 'usage', tokens: totalTokens },
		surfaceDeltaTokens: 0,
		totalTokens,
		surfaceTokens: 0,
		nodes: []
	};
}

/**
 * Build a session whose event log has `turns` completed turns.
 * @param {{id?: string, turns?: number, provider?: string, model?: string}} [options] - session options.
 * @returns {any} the session.
 */
function fakeSession(options = {}) {
	const id = options.id ?? 'session-deadbeef-0000-4000-8000-000000000000';
	const turns = options.turns ?? 2;
	const events = [];
	let seq = 0;
	for (let turn = 1; turn <= turns; turn += 1) {
		events.push({ type: 'turn/start', seq: seq++, time: STAMP_TIME.getTime(), data: { turn } });
		events.push({ type: 'user/message', seq: seq++, time: STAMP_TIME.getTime(), data: { role: 'user', content: `第 ${turn} 轮的需求`, source: { kind: 'user' } } });
		events.push({ type: 'tool/call', seq: seq++, time: STAMP_TIME.getTime(), data: { turn, step: 1, callId: `c${turn}`, name: 'write', arguments: JSON.stringify({ file_path: `C:\\plugin\\dsh-memory-tree\\lib\\mod${turn}.js` }) } });
		events.push({ type: 'tool/result', seq: seq++, time: STAMP_TIME.getTime(), data: { turn, step: 1, message: { content: [{ type: 'text', text: `写入 ${turn} 完成` }] } } });
		events.push({ type: 'assistant/message', seq: seq++, time: STAMP_TIME.getTime(), data: { turn, step: 1, message: { content: [{ type: 'text', text: `第 ${turn} 轮的结论：接好了` }] }, usage: { inputTokens: 12_000, outputTokens: 400 } } });
		events.push({ type: 'turn/end', seq: seq++, time: STAMP_TIME.getTime(), data: { turn, reason: { kind: 'completed' } } });
	}
	const session = {
		id,
		seq: events.length,
		header: { id, cwd: 'C:\\plugin', delegationDepth: 0 },
		surface: { replaceGeneration: 0 },
		events,
		snapshotEvents: () => events,
		eventAt: (index) => events[index],
		requestHeader: () => ({ config: { provider: options.provider ?? 'deepseek', model: options.model ?? 'deepseek-v4-flash' } })
	};
	// The host's event accessor is version-dependent, so a fixture must be able to
	// stand in for EITHER shape. `dsh-session@0.1.2-rc.1` has `snapshotEvents()`;
	// `0.1.0-rc.7` has no such method and exposes the `events` getter instead
	// (`get events() { return Object.freeze([...this.log]) }`, with `seq` defined as
	// `log.length`). Every fixture here used to define `snapshotEvents` itself, so
	// the double invented the very API it was standing in for and could not falsify
	// anything about it.
	if (options.noSnapshotEvents === true) delete session.snapshotEvents;
	return session;
}

/**
 * Append one event to a fake session, keeping `seq` and `events.length` in step.
 *
 * Hand-computing `seq` in a test is a trap: `events.length` is already the next
 * index, so `seq: events.length + 1` declares a position one past the array and
 * the event then falls outside any range computed from `session.seq` — which
 * looks exactly like a library bug and is not one.
 * @param {any} session - the fake session.
 * @param {string} type - event type.
 * @param {any} data - event data.
 * @returns {number} the appended index.
 */
function appendEvent(session, type, data) {
	const seq = session.events.length;
	session.events.push({ type, seq, time: STAMP_TIME.getTime(), data });
	session.seq = session.events.length;
	return seq;
}

/**
 * Create a service bound to a temp root.
 * @param {{projectedTokens?: number, fail?: boolean, overrides?: object}} [options] - setup options.
 * @returns {Promise<{root: string, service: any, session: any, record: any, ctx: any}>} the fixture.
 */
async function fixture(options = {}) {
	const root = await mkdtemp(join(tmpdir(), 'memtree-service-'));
	const record = { calls: [] };
	if (options.fail === true) record.fail = true;
	const ctx = fakeCtx({ llm: fakeLlm(record), projectedTokens: options.projectedTokens ?? 100_000 });
	// `router: false` on purpose: this suite must be hermetic. With the recall
	// router on, any pre-step carrying a human message would make a real HTTP
	// call to the local embeddings server — slow, environmental, and not this
	// suite's subject. The router has its own offline suite (router.mjs).
	const config = resolveConfig({ root, router: false, ...(options.overrides ?? {}) });
	const service = new MemoryService(ctx, config);
	const session = fakeSession({ noSnapshotEvents: options.noSnapshotEvents === true });
	return { root, service, session, record, ctx };
}

/** Freeze "now" so the pipeline lands on the date the tests expect. */
const realDateNow = Date.now;
Date.now = () => STAMP_TIME.getTime();

// ── the snapshot pipeline ───────────────────────────────────────────────────

await test('snapshot() writes the snapshot, refreshes all four levels, and reports', async () => {
	const { root, service, session, record } = await fixture();
	try {
		const report = await service.snapshot({ session, trigger: 'manual' });
		eq(report.status, 'written');
		eq(report.trigger, 'manual');
		eq(report.covered > 0, true, 'events were covered');
		eq(report.summary.ok, true);
		eq(report.summary.added, 2, 'call 1 contributes two NEW entries');
		eq(report.summary.total, 2, 'and the day log holds exactly those');
		eq(report.upper.ok, true);
		eq(report.rollups.sort().join(','), 'day,longterm,month,year');
		eq(report.upper.day, '记忆树插件骨架建好：快照与 roll-up 打通，两处语法错误被预检抓到', 'call 2 answers for the day as well');

		const layout = nodePaths(root, '2026-09-13');
		// 1. the snapshot is on disk with ITS OWN one-liner in its header, not the
		//    day's — the day index is navigated by these rows, so a row that said
		//    the whole day over and over stopped being an index.
		const snapshot = await readFile(report.path, 'utf8');
		eq(frontMatterValue(snapshot, 'summary'), '快照与 roll-up 打通，两处语法错误被预检抓到');
		excludes(frontMatterValue(snapshot, 'summary'), report.upper.day, "and it is NOT the day's line");
		includes(snapshot, '第 1 轮的需求', 'verbatim text');
		// 2. the day region holds the entries, each with the clock of its snapshot
		const day = await readFile(layout.dayFile, 'utf8');
		const entries = regionText(day, DAY_SUMMARY_REGION);
		// The clock is the snapshot's own wall time, not a frozen fixture value:
		// the pipeline builds it from `new Date()`, which `Date.now` patching above
		// does not touch. Assert the SHAPE, so the test cannot drift with the clock.
		ok(/^- \*\*\d{2}:\d{2}\*\* 快照与 roll-up 打通$/m.test(entries), 'the entry carries the clock of its snapshot');
		includes(entries, 'readonly 语法错误被预检抓到', 'and the second entry is there too');
		// 3. the day's one-line summary covers the whole day, and comes from call 2
		eq(frontMatterValue(day, 'summary'), report.upper.day);
		// 4. each upper level carries its own gist from call 2
		eq(frontMatterValue(await readFile(layout.monthFile, 'utf8'), 'summary'), '九月：记忆树从规则到实现');
		eq(frontMatterValue(await readFile(layout.yearFile, 'utf8'), 'summary'), '2026：把 DSH 变成有长期记忆的工作台');
		includes(frontMatterValue(await readFile(layout.longterm, 'utf8'), 'summary'), '可靠的持久记忆');
		// 5. two model calls, and only two
		eq(record.calls.length, 2, 'exactly the two documented calls');
		eq(record.calls[0].provider, 'deepseek');
		eq(record.calls[1].model, 'deepseek-v4-flash');
		// 6. the roll-up tables show the derived rows
		const monthFile = await readFile(layout.monthFile, 'utf8');
		includes(monthFile, '### 13 日 · 2026-09-13', 'the month lists the day');
		// The clock is `new Date()`'s wall time, which patching `Date.now` above does
		// NOT freeze — assert the shape, so this cannot drift with the clock.
		ok(/^- \*\*\d{2}:\d{2}\*\* 快照与 roll-up 打通$/m.test(monthFile), "the month carries that day's own entries");
		includes(await readFile(layout.longterm, 'utf8'), '| 2026 |');
		eq(service.stats.snapshots, 1);
		eq(service.stats.dayCalls, 1);
		eq(service.stats.upperCalls, 1);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

await test('a session that crosses midnight is filed under BOTH days, and the earlier one says it is unfinished', async () => {
	// The owner's rule: a turn belongs to the day the human SENT its message, so a
	// range spanning midnight is two records — filing it under either side alone
	// buries the other day's work.
	const { root, service, record } = await fixture();
	try {
		const session = fakeSession({ turns: 3 });
		// The fixture writes six events per turn; move the last turn past midnight
		// local time (2026-09-14 01:05 +08:00).
		const afterMidnight = new Date('2026-09-13T17:05:00Z').getTime();
		for (let index = 12; index < session.events.length; index += 1) session.events[index].time = afterMidnight;

		const report = await service.snapshot({ session, trigger: 'manual' });
		eq(report.status, 'written');
		ok(Array.isArray(report.segments), 'the report names every file the range produced');
		eq(report.segments.length, 2, 'one file per day');
		eq(report.segments[0].date, '2026-09-13');
		eq(report.segments[1].date, '2026-09-14');
		// The two ranges must TILE the window: a gap loses events forever.
		const endOfFirst = Number(report.segments[0].range.split('–')[1].slice(1));
		const startOfSecond = Number(report.segments[1].range.split('–')[0].slice(1));
		eq(startOfSecond, endOfFirst + 1, 'the second day starts exactly where the first stopped');

		const day13 = await readFile(nodePaths(root, '2026-09-13').dayFile, 'utf8');
		const day14 = await readFile(nodePaths(root, '2026-09-14').dayFile, 'utf8');
		includes(day13, '任务未完成', 'the interrupted day says so');
		includes(day13, '2026-09-14', 'and names the day the work continues in');
		includes(day13, report.segments[0].file, 'the 13th indexes its own file');
		includes(day14, report.segments[1].file, 'and the 14th indexes its own');
		excludes(day13, report.segments[1].file, "neither day's index lists the other day's file");
		excludes(day14, '任务未完成', 'the day it continues into is not itself marked unfinished');

		// The summary belongs to the NEWEST content, which here is the 14th — not to
		// "today", which this snapshot would otherwise have assumed.
		eq(frontMatterValue(day14, 'summary'), '记忆树插件骨架建好：快照与 roll-up 打通，两处语法错误被预检抓到');
		includes(regionText(day14, DAY_SUMMARY_REGION), '快照与 roll-up 打通');
		eq(record.calls.length, 2, 'still exactly two model calls, however many files the range produced');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

await test('a second snapshot with no new events is empty and calls no model', async () => {
	const { root, service, session, record } = await fixture();
	try {
		await service.snapshot({ session, trigger: 'manual' });
		const callsAfterFirst = record.calls.length;
		const second = await service.snapshot({ session, trigger: 'pressure' });
		eq(second.status, 'empty');
		eq(record.calls.length, callsAfterFirst, 'no further model calls');
		eq(service.stats.emptySnapshots, 1);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

await test('a failing model call keeps the verbatim snapshot and reports the failure', async () => {
	const { root, service, session, ctx } = await fixture({ fail: true });
	try {
		const report = await service.snapshot({ session, trigger: 'manual' });
		eq(report.status, 'written', 'the durable record still lands');
		eq(report.summary.ok, false);
		ok(report.summary.error !== undefined);
		// The snapshot exists with a placeholder summary; nothing is lost.
		const text = await readFile(report.path, 'utf8');
		eq(frontMatterValue(text, 'summary'), '（摘要生成中）');
		includes(text, '第 1 轮的需求');
		// The day file keeps its placeholder rather than a fabricated summary.
		const layout = nodePaths(root, '2026-09-13');
		eq(frontMatterValue(await readFile(layout.dayFile, 'utf8'), 'summary'), PLACEHOLDER);
		// Call 2 is deliberately NOT skipped when call 1 fails: its input is tiny,
		// so it can still succeed (and refresh the upper levels) in the realistic
		// partial-failure case where the day slice alone was too large. Here the
		// provider is entirely down, so both failures are real and both count.
		eq(report.upper.ok, false);
		eq(service.stats.callFailures, 2, 'both calls failed and both are counted');
		ok(ctx.warnings.some((line) => line.includes('day entry call')), 'the day failure is logged');
		ok(ctx.warnings.some((line) => line.includes('roll-up call')), 'the roll-up failure is logged');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

await test('a session with no known route skips the model but still snapshots', async () => {
	const { root, service, session } = await fixture();
	try {
		session.requestHeader = () => undefined;
		const report = await service.snapshot({ session, trigger: 'manual' });
		eq(report.status, 'written');
		eq(report.summary.ok, false);
		includes(report.summary.error, 'no provider/model route');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

await test('rollup=false skips call 2 but still writes the snapshot', async () => {
	const { root, service, session, record } = await fixture({ overrides: { rollup: false } });
	try {
		const report = await service.snapshot({ session, trigger: 'manual' });
		eq(report.status, 'written');
		eq(report.upper, undefined, 'no roll-up report');
		eq(record.calls.length, 1, 'only the day call ran');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

await test('the running stage is visible while a snapshot is in flight, and cleared when it settles', async () => {
	const root = await mkdtemp(join(tmpdir(), 'memtree-phase-'));
	try {
		const session = fakeSession();
		const holder = {};
		const seen = [];
		const base = fakeLlm({ calls: [] });
		const ctx = fakeCtx({
			// Sample the stage at the exact moment each model call starts.
			llm: { stream: (options) => { seen.push(holder.service.stateFor(session.id).phase); return base.stream(options); } },
			projectedTokens: 100_000
		});
		const service = new MemoryService(ctx, resolveConfig({ root }));
		holder.service = service;

		const state = service.stateFor(session.id);
		eq(state.phase, undefined, 'no stage is reported before a run starts');

		eq(service.schedule(session, 'manual').started, true);
		eq(state.inFlight, true, 'the run is marked in flight');
		// This is exactly why the status report cannot trust the counters alone:
		// the run is already in flight while every counter still reads zero.
		eq(service.stats.snapshots, 0, 'the counters have not moved yet while the run is in flight');
		await service.drain();
		eq(state.inFlight, false, 'the run settled');

		// The counters only move when a stage finishes, so a run read mid-flight
		// shows zeros that look exactly like a dead feature. Naming the stage is
		// what makes a mid-flight reading self-explanatory.
		eq(seen.join(','), 'day,upper', 'each model call is attributed to its own stage');
		eq(state.phase, undefined, 'a settled run leaves no stage marker behind');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

await test('a cross-session reminder fires once, then stays quiet for the gap', async () => {
	const { root, service, session } = await fixture();
	try {
		const human = (text) => ({ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } });
		const ask = (turn, text) => service.reminderFor({ agent: { session }, messages: [human(text)], turn });

		eq(ask(5, '上次那个 bug 怎么修的')?.signal, '上次', 'the phrase that fired is reported back');
		eq(ask(5, '上次那个'), undefined, 'a second step in the same turn stays quiet');
		eq(ask(6, '上次那个'), undefined, 'the immediate follow-up turn stays quiet');
		eq(ask(8, '上次那个')?.signal, '上次', 'after the gap it speaks again');
		eq(ask(20, '把这条命令跑一下'), undefined, 'an unrelated turn never fires');

		// Injected context is not the human speaking, even when it quotes a signal.
		const injected = { role: 'user', content: [{ type: 'text', text: '上次' }], source: { kind: 'plugin', plugin: 'some-other-plugin' } };
		eq(service.reminderFor({ agent: { session }, messages: [injected], turn: 30 }), undefined, 'injected context is not a request');

		// Only the human's OWN most recent message counts, not older turns' text.
		eq(
			service.reminderFor({ agent: { session }, messages: [human('上次那个'), human('谢谢')], turn: 40 }),
			undefined,
			'an earlier message in the batch does not fire it'
		);
		eq(service.stats.reminders, 2, 'only the two real reminders were counted');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

// ── media archive ───────────────────────────────────────────────────────────

/** A real 1x1 PNG, so the archive copies bytes rather than a placeholder. */
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

await test('a turn that produced an image archives it beside the day and indexes it', async () => {
	const root = await mkdtemp(join(tmpdir(), 'memtree-media-'));
	const sourceDir = await mkdtemp(join(tmpdir(), 'memtree-source-'));
	try {
		const sourcePath = join(sourceDir, 'shot.png');
		await writeFile(sourcePath, PNG_1X1);
		const digest = 'ab'.repeat(32);
		const session = fakeSession();
		// The screenshot rides a tool/result, one nesting level below the message
		// content — the same place `dsh-tool-fs` puts a read image.
		appendEvent(session, 'tool/result', {
			turn: 1,
			step: 1,
			message: {
				role: 'user',
				content: [{
					type: 'tool-result',
					toolCallId: 'c1',
					content: [{ type: 'image', attachment: { attachmentId: `sha256:${digest}`, mediaType: 'image/png', bytes: PNG_1X1.length, width: 1, height: 1 } }],
					isError: false
				}]
			}
		});
		const ctx = fakeCtx({ llm: fakeLlm({ calls: [] }), projectedTokens: 1_000, attachments: { imageHostPath: () => sourcePath } });
		const service = new MemoryService(ctx, resolveConfig({ root }));
		await service.onTurnStopping({ agent: { session }, turn: 1 });

		const mediaDirectory = join(root, '2026', '09', '13', 'media');
		const files = (await readdir(mediaDirectory)).sort();
		eq(files.length, 1, 'exactly one image was archived');
		includes(files[0], 'T1', 'the name records the turn it came from');
		includes(files[0], 'abababab', 'and the image digest, so it can be found again');
		eq(files[0].endsWith('.png'), true, 'and the extension follows the media type');
		// The bytes really moved: same size as the source.
		eq((await stat(join(mediaDirectory, files[0]))).size, PNG_1X1.length);

		const day = await readFile(join(root, '2026', '09', '13', '2026-09-13.md'), 'utf8');
		const index = regionText(day, MEDIA_REGION);
		includes(index, files[0], 'the day file links the archived image');
		includes(index, 'T1', 'and names the turn in its own column');
		eq(service.stats.mediaArchived, 1, 'the counter moved');

		// The same image in a later turn is deduplicated: one file, and the index
		// does not grow a second row for the same bytes.
		await service.onTurnStopping({ agent: { session }, turn: 1 });
		eq((await readdir(mediaDirectory)).length, 1, 'a repeated image is not stored twice');
		eq(service.stats.mediaArchived, 1, 'and is not counted twice');
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(sourceDir, { recursive: true, force: true });
	}
});

await test('a turn with no images leaves the archive untouched', async () => {
	const root = await mkdtemp(join(tmpdir(), 'memtree-nomedia-'));
	try {
		const ctx = fakeCtx({ llm: fakeLlm({ calls: [] }), projectedTokens: 1_000, attachments: { imageHostPath: () => undefined } });
		const service = new MemoryService(ctx, resolveConfig({ root }));
		await service.onTurnStopping({ agent: { session: fakeSession() }, turn: 1 });
		eq(existsSync(join(root, '2026', '09', '13', 'media')), false, 'no media directory is created for a text-only turn');
		eq(service.stats.mediaArchived, 0);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

await test('a broken attachment store never costs the turn its log line', async () => {
	const root = await mkdtemp(join(tmpdir(), 'memtree-badmedia-'));
	try {
		const session = fakeSession();
		appendEvent(session, 'tool/result', {
			turn: 1,
			step: 1,
			message: { role: 'user', content: [{ type: 'tool-result', content: [{ type: 'image', attachment: { attachmentId: 'sha256:cd', mediaType: 'image/png' } }] }] }
		});
		// `imageHostPath` throws, as a store with an invalid reference would.
		const ctx = fakeCtx({
			llm: fakeLlm({ calls: [] }),
			projectedTokens: 1_000,
			attachments: { imageHostPath: () => { throw new Error('attachment-local: invalid reference') } }
		});
		const service = new MemoryService(ctx, resolveConfig({ root }));
		const outcome = await service.onTurnStopping({ agent: { session }, turn: 1 });
		eq(outcome.logged, true, 'the mechanical row still landed');
		const day = await readFile(join(root, '2026', '09', '13', '2026-09-13.md'), 'utf8');
		includes(regionText(day, TURNLOG_REGION), '| T1·', 'and it is on disk');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

// ── asset backup ────────────────────────────────────────────────────────────

await test('writeBackup copies real bytes, excludes junk, and survives missing sources', async () => {
	const root = await mkdtemp(join(tmpdir(), 'memtree-backup-'));
	const home = await mkdtemp(join(tmpdir(), 'memtree-home-'));
	const workspace = await mkdtemp(join(tmpdir(), 'memtree-ws-'));
	try {
		// A skill, a global rule, and one plugin — plus node_modules, which must
		// NOT be copied, and a `_backup-*` file, which must not either.
		await mkdir(join(home, 'skills', 'demo'), { recursive: true });
		await writeFile(join(home, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\n---\nbody\n', 'utf8');
		await writeFile(join(home, 'AGENTS.md'), '# global rules\n', 'utf8');
		await mkdir(join(workspace, 'dsh-memory-tree', 'node_modules', 'junk'), { recursive: true });
		await writeFile(join(workspace, 'dsh-memory-tree', 'package.json'), '{ "name": "x" }\n', 'utf8');
		await writeFile(join(workspace, 'dsh-memory-tree', 'node_modules', 'junk', 'a.js'), 'junk\n', 'utf8');
		await writeFile(join(workspace, 'dsh-memory-tree', '_backup-old.md'), 'old\n', 'utf8');

		const report = writeBackup({
			root,
			assets: planAssets({ dshHome: home, workspace }),
			stamp: '2026-09-13 07:00:00',
		});
		const bundle = join(root, '_bootstrap');

		// 1. The bytes are really there, not just counted.
		eq(await readFile(join(bundle, 'skills', 'demo', 'SKILL.md'), 'utf8'), '---\nname: demo\n---\nbody\n');
		eq(await readFile(join(bundle, 'rules', 'AGENTS.global.md'), 'utf8'), '# global rules\n');
		eq(await readFile(join(bundle, 'plugins', 'dsh-memory-tree', 'package.json'), 'utf8'), '{ "name": "x" }\n');
		// 2. Junk stays out.
		eq(existsSync(join(bundle, 'plugins', 'dsh-memory-tree', 'node_modules')), false, 'node_modules is excluded');
		eq(existsSync(join(bundle, 'plugins', 'dsh-memory-tree', '_backup-old.md')), false, '`_backup-*` is excluded');
		// 3. A source that is not there is reported, not fatal — a fresh machine
		//    legitimately lacks some of these.
		const skipped = report.entries.filter((entry) => entry.status === 'skipped');
		eq(skipped.length > 0, true, 'absent sources are skipped');
		eq(report.entries.length, skipped.length + report.entries.filter((entry) => entry.status === 'copied').length, 'every entry has a status');
		// 4. The two documents a restorer reads are regenerated, and name the run.
		const manifest = await readFile(join(bundle, 'MANIFEST.md'), 'utf8');
		includes(manifest, '2026-09-13 07:00:00');
		includes(manifest, 'skills');
		includes(manifest, '排除');
		const readme = await readFile(join(bundle, 'README.md'), 'utf8');
		// The two things that make a bundle worth having, asserted by MEANING rather
		// than by this deployment's script names: it must say where it came from,
		// and it must say that nothing will run it for you.
		includes(readme, '# 恢复说明');
		includes(readme, '它不会自己跑');
		includes(readme, '2026-09-13 07:00:00');
		// Recovery must be documented as something the operator runs, and the
		// plugin-registration step must survive (a restore that only copies files
		// leaves a plugin that is installed but never loaded).
		includes(readme, 'memory_backup');
		includes(readme, '恢复');
		// 5. The bundle directory name is never numeric, so the tree ignores it.
		eq(/^\d+$/.test('_bootstrap'), false);
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(home, { recursive: true, force: true });
		await rm(workspace, { recursive: true, force: true });
	}
});

// ── a failed summary must be visible in the file, not only in a log ─────────

await test('a failed day call appends a visible gap and destroys nothing', async () => {
	const { root, service, session, record } = await fixture();
	try {
		const dayFile = nodePaths(root, '2026-09-13').dayFile;
		// 1. A good snapshot first, so there is real history to protect.
		await service.snapshot({ session, trigger: 'manual' });
		const good = regionText(await readFile(dayFile, 'utf8'), DAY_SUMMARY_REGION);
		includes(good, '快照与 roll-up 打通', 'the first entries landed');
		const dayLine = frontMatterValue(await readFile(dayFile, 'utf8'), 'summary');

		// 2. New material, then a failing model call.
		appendEvent(session, 'assistant/message', {
			turn: 2,
			step: 1,
			message: { content: [{ type: 'text', text: '第二轮工作的结论' }] },
			usage: { inputTokens: 10, outputTokens: 5 },
		});
		record.fail = true;
		const second = await service.snapshot({ session, trigger: 'manual' });
		eq(second.summary.ok, false, 'the snapshot reports the failure');
		// TWO, not one: the day entries and the roll-up summary are separate calls,
		// and a dead route fails both. Counting only the first would hide half the
		// damage.
		eq(service.stats.callFailures, 2, 'both summary calls are counted as failed');

		// 3. The point of this test: it is IN THE FILE the human reads. With an
		//    append-only log there is nothing to protect, so the honest record is a
		//    gap at the point in time where the gap happened — and everything
		//    recorded before it is still there, byte for byte.
		const after = regionText(await readFile(dayFile, 'utf8'), DAY_SUMMARY_REGION);
		includes(after, '事件条目生成失败', 'the gap is in the day file');
		includes(after, 'llm unavailable', 'it names the reason the call gave');
		includes(after, '快照与 roll-up 打通', 'and the earlier entries are untouched');
		includes(after, 'readonly 语法错误被预检抓到');
		eq(after.split('事件条目生成失败').length - 1, 1, 'exactly one gap is recorded');
		// A failed call must not overwrite the day's line with a partial one: the
		// stale whole-day line beats a fresh tail-only one.
		eq(frontMatterValue(await readFile(dayFile, 'utf8'), 'summary'), dayLine, 'the day line is untouched by the failure');

		// 4. The snapshot itself is still complete — the failure must not have cost
		//    anything durable.
		eq(existsSync(second.path), true, 'the verbatim snapshot is on disk');
		// The turn log is written by turn-stopping, NOT by snapshot, so it is
		// exercised through its own entry point here.
		await service.onTurnStopping({ agent: { session }, turn: 2 });
		const day = await readFile(dayFile, 'utf8');
		includes(regionText(day, TURNLOG_REGION), '| T2·', 'the turn log kept going despite the summary failure');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

await test('a model that over-produces is capped AND says so, rather than flooding the day', async () => {
	// The cap was 4 until the first live run after the rewrite: a 389-event slice
	// produced six legitimate entries and two were dropped. Dropping real events
	// is the failure this design exists to prevent, so the default is now a
	// runaway guard (8) — and whatever it DOES drop must be reported, because a
	// silent cap is indistinguishable from a model that had less to say.
	const { root, service, session, record } = await fixture({ overrides: { dayEntryMax: 3 } });
	try {
		const layout = nodePaths(root, '2026-09-13');
		record.dayAnswer = ['## 一句话\n一次产出很多条目的切片', '## 事件', ...Array.from({ length: 10 }, (_, index) => `- 第 ${index + 1} 件事`)].join('\n');
		const report = await service.snapshot({ session, trigger: 'manual' });
		eq(report.summary.ok, true);
		eq(report.summary.added, 3, 'exactly the cap is appended');
		eq(report.summary.dropped, 7, 'and the rest are counted, not silently lost');
		eq(report.summary.entries.length, 3, 'the report echoes what was recorded');
		const body = regionText(await readFile(layout.dayFile, 'utf8'), DAY_SUMMARY_REGION);
		eq(body.split('\n').filter((line) => line.startsWith('- **')).length, 3);
		includes(body, '第 1 件事');
		excludes(body, '第 4 件事', 'over-cap entries really are not written');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

await test('a later successful snapshot adds to the log without losing the gap or the history', async () => {
	const { root, service, session, record } = await fixture();
	try {
		const dayFile = nodePaths(root, '2026-09-13').dayFile;
		await service.snapshot({ session, trigger: 'manual' });
		appendEvent(session, 'assistant/message', {
			turn: 2,
			step: 1,
			message: { content: [{ type: 'text', text: '第二轮' }] },
			usage: { inputTokens: 10, outputTokens: 5 }
		});
		record.fail = true;
		await service.snapshot({ session, trigger: 'manual' });
		appendEvent(session, 'assistant/message', {
			turn: 3,
			step: 1,
			message: { content: [{ type: 'text', text: '第三轮' }] },
			usage: { inputTokens: 10, outputTokens: 5 }
		});
		record.fail = false;
		const third = await service.snapshot({ session, trigger: 'manual' });
		eq(third.summary.ok, true);
		eq(third.summary.added, 2, 'the recovered call contributes its entries');
		const body = regionText(await readFile(dayFile, 'utf8'), DAY_SUMMARY_REGION);
		eq(body.split('\n').filter((line) => line.startsWith('- **')).length, 5, 'two entries, the gap, then two more — nothing is ever replaced');
		includes(body, '快照与 roll-up 打通', 'the very first entry is still there after two more snapshots');
		includes(body, '事件条目生成失败', 'and so is the record of the failure');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

// ── pressure is an event, not a state ───────────────────────────────────────

await test('pressure fires once, then waits for real growth instead of re-firing', async () => {
	// `minSnapshotIntervalMs: 0` on purpose: the cooldown would MASK this bug by
	// slowing it to one snapshot per interval, and the interval is not what the
	// fix is about. Measured live before the guard existed: 22 snapshots in 25
	// minutes, each costing two model calls.
	const { root, service, session } = await fixture({ projectedTokens: 620_000, overrides: { minSnapshotIntervalMs: 0 } });
	try {
		const state = service.stateFor(session.id);
		service.onPreStep({ agent: { session } });
		await service.drain();
		eq(service.stats.snapshots, 1, 'the first crossing snapshots');
		eq(state.pressureAnchorTokens, 620_000, 'and records the occupancy it saw');

		// Occupancy unchanged. A snapshot cannot lower the context, so "above the
		// line" stays true — which is exactly why it must not be the trigger.
		for (let step = 0; step < 3; step += 1) {
			service.onPreStep({ agent: { session } });
			await service.drain();
		}
		eq(service.stats.snapshots, 1, 'staying above the line is not growth');
		eq(state.pressureSkipped, 3, 'and every suppression is visible in the counter');

		// Real growth past the anchor fires again. A new event is added first,
		// because a snapshot with nothing new in it is legitimately `empty` and
		// would not move the counter — that would make this test pass or fail for
		// the wrong reason.
		appendEvent(session, 'assistant/message', {
			turn: 99,
			step: 1,
			message: { content: [{ type: 'text', text: '增长之后的一轮' }] },
			usage: { inputTokens: 10, outputTokens: 5 },
		});
		state.pressureAnchorTokens = 500_000;
		service.onPreStep({ agent: { session } });
		await service.drain();
		eq(service.stats.snapshots, 2, 'growth past the anchor fires again');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

await test('the growth guard never blocks a manual snapshot', async () => {
	// The guard is about the PRESSURE trigger only. A manual call is the human
	// asking; it may not be suppressed by a rule that exists to stop one
	// automatic trigger from repeating.
	const { root, service, session } = await fixture({ projectedTokens: 620_000, overrides: { minSnapshotIntervalMs: 0 } });
	try {
		service.onPreStep({ agent: { session } });
		await service.drain();
		eq(service.stats.snapshots, 1);
		service.onPreStep({ agent: { session } });
		await service.drain();
		eq(service.stats.snapshots, 1, 'pressure is suppressed');
		appendEvent(session, 'assistant/message', {
			turn: 98,
			step: 1,
			message: { content: [{ type: 'text', text: '手动快照前的一轮' }] },
			usage: { inputTokens: 10, outputTokens: 5 },
		});
		await service.snapshot({ session, trigger: 'manual' });
		eq(service.stats.snapshots, 2, 'a manual snapshot is never suppressed');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

// ── triggers ────────────────────────────────────────────────────────────────

await test('onPreStep schedules nothing below the threshold, and a snapshot above it', async () => {
	const low = await fixture({ projectedTokens: 100_000 });
	try {
		low.service.onPreStep({ agent: { session: low.session } });
		await low.service.drain();
		eq(low.record.calls.length, 0, 'nothing below the threshold');
		eq(existsSync(nodePaths(low.root, '2026-09-13').dayFile), false, 'and no directory is created');
	} finally {
		await rm(low.root, { recursive: true, force: true });
	}
	const high = await fixture({ projectedTokens: 620_000 });
	try {
		high.service.onPreStep({ agent: { session: high.session } });
		await high.service.drain();
		eq(high.record.calls.length, 2, 'a snapshot ran once above the threshold');
		eq(high.service.stats.snapshots, 1);
	} finally {
		await rm(high.root, { recursive: true, force: true });
	}
});

await test('the cooldown stops a session above the threshold from snapshotting every step', async () => {
	const { root, service, session, record } = await fixture({ projectedTokens: 620_000 });
	try {
		service.onPreStep({ agent: { session } });
		await service.drain();
		eq(service.stats.snapshots, 1);
		// Further steps immediately after are suppressed by the cooldown.
		service.onPreStep({ agent: { session } });
		service.onPreStep({ agent: { session } });
		await service.drain();
		eq(service.stats.snapshots, 1, 'still just the one snapshot');
		eq(record.calls.length, 2);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

await test('a compaction boundary triggers a snapshot', async () => {
	const { root, service, session } = await fixture({ projectedTokens: 100_000, overrides: { snapshotTriggerTokens: 10_000_000 } });
	try {
		service.onPreStep({ agent: { session } });
		await service.drain();
		eq(service.stats.snapshots, 0, 'the first observation only records the generation');
		session.surface.replaceGeneration = 1;
		service.onPreStep({ agent: { session } });
		await service.drain();
		eq(service.stats.snapshots, 1, 'the changed generation is treated as a compaction');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

await test('the durable compaction/start event triggers a snapshot, before the surface changes', async () => {
	const { root, service, session, record } = await fixture({ projectedTokens: 100_000, overrides: { snapshotTriggerTokens: 10_000_000 } });
	try {
		// Prime the scan so the boundary is a genuinely NEW event.
		service.onPreStep({ agent: { session } });
		await service.drain();
		eq(service.stats.snapshots, 0);
		// The harness appends this BEFORE it summarizes and replaces the surface.
		appendEvent(session, 'compaction/start', { trigger: 'threshold', turn: 2 });
		service.onPreStep({ agent: { session } });
		await service.drain();
		eq(service.stats.compactionsSeen, 1, 'the durable event was seen');
		eq(service.stats.snapshots, 1, 'and it triggered a snapshot');
		eq(record.calls.length, 2, 'the snapshot ran both summary calls');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

await test('compaction detection is incremental and does not re-fire on the same event', async () => {
	const { root, service, session } = await fixture({ projectedTokens: 100_000, overrides: { snapshotTriggerTokens: 10_000_000 } });
	try {
		service.onPreStep({ agent: { session } });
		await service.drain();
		appendEvent(session, 'compaction/start', {});
		service.onPreStep({ agent: { session } });
		await service.drain();
		eq(service.stats.compactionsSeen, 1);
		// Observing the same (unchanged) log again must not look like a new one.
		for (let step = 0; step < 3; step += 1) {
			service.onPreStep({ agent: { session } });
			await service.drain();
		}
		eq(service.stats.compactionsSeen, 1, 'the same event is not counted again');
		eq(service.stats.snapshots, 1, 'and no extra snapshot is taken');
		// A second, later compaction is a new boundary.
		appendEvent(session, 'compaction/end', {});
		appendEvent(session, 'compaction/start', {});
		service.onPreStep({ agent: { session } });
		await service.drain();
		eq(service.stats.compactionsSeen, 2, 'a later compaction is a new boundary');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

await test('the compaction trigger bypasses the automatic cooldown', async () => {
	const { root, service, session } = await fixture({ projectedTokens: 620_000 });
	try {
		// A pressure snapshot starts the cooldown, then a compaction arrives
		// immediately: the cooldown must NOT swallow the hard boundary.
		service.onPreStep({ agent: { session } });
		await service.drain();
		eq(service.stats.snapshots, 1, 'the pressure snapshot landed');
		appendEvent(session, 'compaction/start', {});
		appendEvent(session, 'assistant/message', { turn: 3, step: 1, message: { content: [{ type: 'text', text: '压缩之后的新内容' }] }, usage: { inputTokens: 5, outputTokens: 1 } });
		service.onPreStep({ agent: { session } });
		await service.drain();
		eq(service.stats.snapshots, 2, 'the compaction snapshot was not suppressed');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

await test('a snapshot taken after a compaction still contains the pre-compaction events', async () => {
	const { root, service, session } = await fixture();
	try {
		// The log is append-only; compaction only rewrites the derived surface.
		// This is why a "late" detection loses nothing.
		appendEvent(session, 'compaction/start', {});
		appendEvent(session, 'user/message', { role: 'user', content: '压缩摘要占位', source: { kind: 'compaction' } });
		session.surface.replaceGeneration = 1; // the surface was rewritten
		const report = await service.snapshot({ session, trigger: 'compaction' });
		eq(report.status, 'written');
		const text = await readFile(report.path, 'utf8');
		includes(text, '第 1 轮的需求', 'events the surface no longer shows are still saved');
		includes(text, '第 2 轮的结论');
		includes(text, '压缩摘要占位', 'and the harness compaction checkpoint is kept too');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

await test('subagent sessions are recorded too (2026-09-30: delegated work was being dropped)', async () => {
	const { root, service, session, record } = await fixture({ projectedTokens: 620_000 });
	try {
		session.header.delegationDepth = 1;
		service.onPreStep({ agent: { session } });
		await service.drain();
		eq(service.includeSession(session), true, 'a subagent session is included by default now');
		ok(record.calls.length > 0, 'and it does reach the snapshot pipeline');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

await test('includeSubagents:false still excludes subagents (the option is honoured)', async () => {
	eq(resolveConfig({}).includeSubagents, true, 'the default is true now');
	eq(resolveConfig({ includeSubagents: false }).includeSubagents, false, 'and the key can turn it back off');
	const { root, service, session, record } = await fixture({ projectedTokens: 620_000, overrides: { includeSubagents: false } });
	try {
		session.header.delegationDepth = 1;
		service.onPreStep({ agent: { session } });
		await service.drain();
		eq(service.includeSession(session), false);
		eq(record.calls.length, 0, 'a subagent does not write to the tree when the option is off');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

await test('automatic summarisation is PER SESSION, and the config value stays the default', async () => {
	// The switch lives in the UI (2026-09-30) and is per session: whether automatic
	// summarisation is wanted is a property of the work, not of the machine. This
	// pins the resolution order (session override -> configured default), that an
	// override does not leak into another session, and that it survives a restart.
	const dataDir = await mkdtemp(join(tmpdir(), 'memtree-auto-'));
	const { root, service, session } = await fixture({ overrides: { routerDataDir: dataDir } });
	try {
		eq(service.autoFor(session), true, 'no override yet: the configured default (true) applies');
		const first = service.setAutoSummary(false, session.id);
		eq(first.scope, 'session', 'the switch reports session scope');
		eq(service.autoFor(session), false, 'the session override wins over the default');
		eq(service.autoFor('another-session-id'), true, 'and it does not leak into other sessions');
		eq(existsSync(join(dataDir, 'session-auto.json')), true, 'the override is persisted');

		// A restart means a fresh service: point it at the same data dir and the
		// resumed session must get its own setting back.
		const revived = await fixture({ overrides: { routerDataDir: dataDir } });
		try {
			eq(revived.service.autoFor(session.id), false, 'the override survives a restart');
			eq(revived.service.autoFor('another-session-id'), true, 'and still does not leak');
		} finally { await rm(revived.root, { recursive: true, force: true }); }

		// With no session known the switch falls back to the global config value.
		eq(service.setAutoSummary(false, undefined).scope, 'global', 'no session means global scope');
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(dataDir, { recursive: true, force: true });
	}
});

// ── turn log ────────────────────────────────────────────────────────────────

await test('onTurnStopping writes one mechanical row with the token delta', async () => {
	const { root, service, session } = await fixture({ projectedTokens: 50_000 });
	try {
		// First turn establishes the baseline: no delta is known yet.
		await service.onTurnStopping({ agent: { session }, turn: 1 });
		// Second turn has a measurable delta.
		const ctx = service.ctx;
		ctx.get = (name) => (name === 'tokenMeter' ? { measure: () => realMeasurement(62_300) } : undefined);
		await service.onTurnStopping({ agent: { session }, turn: 2 });
		const layout = nodePaths(root, '2026-09-13');
		const day = await readFile(layout.dayFile, 'utf8');
		const body = regionText(day, TURNLOG_REGION);
		includes(body, '| T1·deadbeef |', 'turn 1 row present');
		includes(body, '| T2·deadbeef |', 'turn 2 row present');
		includes(body, '+12.3k', 'the delta between the two measurements');
		includes(body, 'mod2.js', 'the changed file from that turn');
		includes(body, '第 2 轮的结论', 'the turn headline');
		eq(service.stats.turnsLogged, 2);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

await test('a replayed turn-stopping hook does not duplicate a row', async () => {
	const { root, service, session } = await fixture();
	try {
		await service.onTurnStopping({ agent: { session }, turn: 2 });
		const replay = await service.onTurnStopping({ agent: { session }, turn: 2 });
		eq(replay.logged, false, 'the second call reports no write');
		const day = await readFile(nodePaths(root, '2026-09-13').dayFile, 'utf8');
		eq(day.split('| T2·deadbeef |').length - 1, 1, 'the row appears once');
		eq(service.stats.turnsLogged, 1);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

await test('turn logging can be switched off', async () => {
	const { root, service, session } = await fixture({ overrides: { turnLog: false } });
	try {
		const result = await service.onTurnStopping({ agent: { session }, turn: 1 });
		eq(result.logged, false);
		eq(existsSync(nodePaths(root, '2026-09-13').dayFile), false, 'no file is created when logging is off');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

// ── reads ───────────────────────────────────────────────────────────────────

await test('read() walks every level and names the next step', async () => {
	const { root, service, session } = await fixture();
	try {
		await service.snapshot({ session, trigger: 'manual' });
		const day = await service.read({ level: 'day', date: '2026-09-13' });
		eq(day.ok, true);
		includes(day.text, '快照索引');
		includes(day.text, '机械流水', 'the day read includes the turn log region');
		ok(day.next.some((line) => line.includes('level=snapshot')), 'the day level points at snapshots');

		const month = await service.read({ level: 'month', date: '2026-09-13' });
		ok(month.next.some((line) => line.includes('<日>')), 'the month level points at days');
		const year = await service.read({ level: 'year', date: '2026-09-13' });
		ok(year.next.some((line) => line.includes('<月>')), 'the year level points at months');
		const longterm = await service.read({ level: 'longterm' });
		includes(longterm.text, '| 2026 |');

		// The snapshot level reads one file by name.
		const files = await readdir(nodePaths(root, '2026-09-13').dayDir);
		const snapshotName = files.find((name) => name.includes('T') && name.endsWith('.md'));
		const snapshot = await service.read({ level: 'snapshot', date: '2026-09-13', file: snapshotName });
		eq(snapshot.ok, true);
		includes(snapshot.text, '第 1 轮的需求');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

await test('read() refuses a path-traversal snapshot name and missing nodes', async () => {
	const { root, service } = await fixture();
	try {
		const evil = await service.read({ level: 'snapshot', date: '2026-09-13', file: '..\\..\\index.md' });
		eq(evil.ok, false);
		includes(evil.error, 'not a snapshot file name');
		const traversal = await service.read({ level: 'snapshot', date: '2026-09-13', file: '../evil.md' });
		eq(traversal.ok, false);
		// A level that has no content yet is reported, not created.
		const missing = await service.read({ level: 'day', date: '2026-09-13' });
		eq(missing.ok, false);
		includes(missing.error, 'no such node yet');
		eq(existsSync(nodePaths(root, '2026-09-13').dayFile), false, 'reading never creates');
		const beforeStart = await service.read({ level: 'day', date: '1999-12-31' });
		eq(beforeStart.ok, false);
		includes(beforeStart.error, 'before the tree start');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

await test('read() truncates on request', async () => {
	const { root, service, session } = await fixture();
	try {
		await service.snapshot({ session, trigger: 'manual' });
		const clipped = await service.read({ level: 'day', date: '2026-09-13', maxChars: 120 });
		eq(clipped.truncated, true);
		includes(clipped.text, '已截断');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

await test('search() finds index lines without reading snapshots by default', async () => {
	const { root, service, session } = await fixture();
	try {
		await service.snapshot({ session, trigger: 'manual' });
		const found = await service.search({ query: '插件骨架' });
		eq(found.ok, true);
		ok(found.matches.length > 0, 'the day gist is searchable');
		ok(found.matches.some((match) => match.file.includes('2026-09-13.md')), 'the match names the node file');
		// A term that exists only inside the snapshot body is not found by default.
		const verbatimOnly = await service.search({ query: '第 1 轮的需求' });
		eq(verbatimOnly.matches.length, 0, 'snapshot bodies are excluded by default');
		const withSnapshots = await service.search({ query: '第 1 轮的需求', includeSnapshots: true });
		ok(withSnapshots.matches.length > 0, 'and included on request');
		const empty = await service.search({ query: '   ' });
		eq(empty.ok, false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

await test('search() ignores a non-numeric directory at the tree root', async () => {
	const { root, service, session } = await fixture();
	try {
		await service.snapshot({ session, trigger: 'manual' });
		// The `_bootstrap` recovery bundle's Markdown must never be searchable:
		// the search path is BUILT from numeric directory names rather than
		// discovered by readdir, so a non-numeric directory is skipped entirely.
		await mkdir(join(root, '_bootstrap'), { recursive: true });
		await writeFile(join(root, '_bootstrap', 'README.md'), '# bootstrap marker\n', 'utf8');
		const found = await service.search({ query: 'bootstrap marker' });
		eq(found.ok, true);
		eq(found.matches.length, 0, 'nothing from the recovery bundle leaks into search');
		// Without this, a completely broken search would also report zero matches
		// and the assertion above would pass for the wrong reason.
		const real = await service.search({ query: '插件骨架' });
		ok(real.matches.length > 0, 'real date nodes are still searchable');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

// ── probe ───────────────────────────────────────────────────────────────────

await test('probe() reports the route, the text, and the observed chunk types', async () => {
	const { root, service, session } = await fixture();
	try {
		const probe = await service.probe({ session });
		eq(probe.ok, true);
		eq(probe.route.provider, 'deepseek');
		eq(probe.route.model, 'deepseek-v4-flash');
		ok(probe.text.length > 0, 'the probe got text back');
		includes(probe.observedChunkTypes.join(','), 'text-delta');
		eq(service.stats.probes, 1);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

await test('probe() reports a missing route instead of throwing', async () => {
	const { root, service, session } = await fixture();
	try {
		session.requestHeader = () => ({ config: {} });
		const probe = await service.probe({ session });
		eq(probe.ok, false);
		includes(probe.error, 'no provider/model route');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

// ── regressions found by running against the live harness ───────────────────

await test('measure() reads totalTokens, the field the real service actually returns', async () => {
	const { root, service } = await fixture({ projectedTokens: 512_000 });
	try {
		const measurement = service.measure(fakeSession());
		ok(measurement !== undefined, 'a real-shaped measurement is understood');
		eq(measurement.tokens, 512_000, 'totalTokens is the occupancy');
		eq(measurement.baseline, 'usage');
		eq(measurement.surfaceTokens, 0);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

await test('measure() refuses a measurement with no token field, and survives a throwing meter', async () => {
	const { root, service, ctx } = await fixture();
	try {
		// The shape an earlier version assumed. It must NOT be accepted, because
		// silently accepting it is what hid the dead pressure trigger.
		ctx.get = (name) => (name === 'tokenMeter' ? { measure: () => ({ projectedTokens: undefined, contextWindow: 1_000_000 }) } : undefined);
		eq(service.measure(fakeSession()), undefined, 'no comparable number means no measurement');
		ctx.get = (name) => (name === 'tokenMeter' ? { measure: () => ({ contextWindow: 1_000_000 }) } : undefined);
		eq(service.measure(fakeSession()), undefined);
		ctx.get = (name) => (name === 'tokenMeter' ? { measure: () => { throw new Error('meter exploded'); } } : undefined);
		eq(service.measure(fakeSession()), undefined, 'a throwing meter is absorbed');
		ok(service.lastError !== undefined, 'and recorded as the last error');
		ctx.get = () => undefined;
		eq(service.measure(fakeSession()), undefined, 'a missing service is not an error');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

await test('a pressure snapshot fires on the real measurement shape', async () => {
	const { root, service, session, record } = await fixture({ projectedTokens: 620_000 });
	try {
		service.onPreStep({ agent: { session } });
		await service.drain();
		eq(service.stats.snapshots, 1, 'the threshold is compared against totalTokens');
		eq(record.calls.length, 2);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

await test('read() drill-down hints carry the real date, never "undefined"', async () => {
	const { root, service, session } = await fixture();
	try {
		await service.snapshot({ session, trigger: 'manual' });
		// Regression: the levelPath branch yields `dateText` while the snapshot
		// branch yielded `date`, so every hint printed "date=undefined".
		const day = await service.read({ level: 'day', date: '2026-09-13' });
		eq(day.date, '2026-09-13', 'the reported date is the requested one');
		includes(day.next.join('\n'), 'date=2026-09-13');
		excludes(day.next.join('\n'), 'undefined');
		const month = await service.read({ level: 'month', date: '2026-09-13' });
		excludes(month.next.join('\n'), 'undefined');
		// Asserted against the month directory THIS tree actually has, not against
		// a literal `2026\\09`. The literal only held on Windows, so a hint that
		// named a non-existent path passed the test on the one platform where the
		// separator happened to match.
		includes(month.next.join('\n'), nodePaths(root, '2026-09-13').monthDir, 'the hint names the real month path');
		const year = await service.read({ level: 'year', date: '2026-09-13' });
		includes(year.next.join('\n'), '2026-<月>');
		// The snapshot branch must agree with the others.
		const files = await readdir(nodePaths(root, '2026-09-13').dayDir);
		const name = files.find((entry) => entry.includes('T') && entry.endsWith('.md'));
		const snapshot = await service.read({ level: 'snapshot', date: '2026-09-13', file: name });
		eq(snapshot.ok, true);
		eq(snapshot.date, '2026-09-13');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

// ── the host's event accessor is version-dependent ──────────────────────────
//
// `dsh-session@0.1.2-rc.1` exposes `snapshotEvents()`. `0.1.0-rc.7` does NOT — it
// exposes the `events` getter, a frozen copy of the whole log whose `seq` is
// defined as `log.length`. The guard against a missing `snapshotEvents` used to be
// `: []`, so on rc.7 every snapshot covered ZERO events and `memory_snapshot`
// answered `empty` forever, while the tree kept writing files and looked healthy
// from the outside. Measured on the live host: 3 turn rows, every headline the
// placeholder, 0 snapshots, `index.md` never created.
//
// No fixture could catch it, because every fake session in this suite defined
// `snapshotEvents` itself: the double invented the API it was standing in for.
await test('a session exposing only `events` (the 0.1.0-rc.7 shape) is read, not silently emptied', async () => {
	const { root, service, session, record } = await fixture({ noSnapshotEvents: true });
	try {
		eq(typeof session.snapshotEvents, 'undefined', 'the fixture really lacks the method');
		eq(Array.isArray(session.events), true, 'and really carries the getter-shaped log');

		const report = await service.snapshot({ session, trigger: 'manual' });
		eq(report.status, 'written', 'a missing `snapshotEvents` must not read as "no events"');
		eq(report.covered > 0, true, `events were covered (covered=${report.covered})`);
		eq(record.calls.length > 0, true, 'and the summarizer was actually called');

		// The turn log reads the same log through the same accessor.
		const outcome = await service.onTurnStopping({ agent: { session }, turn: 2 });
		eq(outcome.logged, true, `turn log outcome: ${outcome.reason ?? 'ok'}`);
		const day = await readFile(nodePaths(root, '2026-09-13').dayFile, 'utf8');
		includes(day, 'T2·', 'the row landed');
		excludes(day, '（本轮无文本输出）', 'and its headline is real, not the placeholder');
		// Scoped to the row on purpose: `—` is a legitimate cell value elsewhere in
		// the day file (the snapshot index uses it when a day has no snapshots), so a
		// file-wide check for it asserts nothing about this row and fails regardless.
		const row = day.split('\n').find((line) => line.includes('T2·')) ?? '';
		includes(row, 'mod2.js', 'and its changed-files cell names the file that turn wrote');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

// ── config ──────────────────────────────────────────────────────────────────

await test('resolveConfig applies defaults, overrides, and rejects nonsense', async () => {
	// A root has to be shaped for the platform it runs on: `resolveConfig` now
	// rejects a Windows-shaped root on POSIX at load time, because such a root
	// does not fail — it writes the whole tree into flat files whose names
	// contain backslashes while the configured root stays empty.
	const usableRoot = process.platform === 'win32' ? 'X:\\Tree' : '/srv/Tree';
	const config = resolveConfig({ root: usableRoot, snapshotTriggerTokens: 1234, turnLog: false });
	eq(config.root, usableRoot);
	eq(config.snapshotTriggerTokens, 1234);
	eq(config.turnLog, false);
	eq(config.timezone, 'Asia/Shanghai', 'untouched fields keep their default');
	eq(config.readMaxChars, 24_000);
	// An unknown key is ignored rather than crashing the boot. The default root
	// is asserted against the exported constant rather than a literal: the
	// literal used to be the Windows path on EVERY platform, which is how a
	// Linux host ended up writing `<MEMORY_ROOT>\...` as one flat file.
	eq(resolveConfig({ nonsense: 1 }).root, DEFAULT_ROOT);
	// It is not enough for `assertRootForPlatform` to exist — it has to be wired
	// into the one place a root enters. Otherwise a guard that is never called
	// looks exactly like a guard that passes, which is the same class of
	// mistake as an assertion anchored where it cannot fail.
	if (process.platform !== 'win32') {
		let rootThrew = false;
		try {
			resolveConfig({ root: 'C:\\mem' });
		} catch (error) {
			rootThrew = String(error.message).includes('backslash');
		}
		ok(rootThrew, 'resolveConfig rejects a Windows-shaped root on POSIX');
	}
	let threw = false;
	try {
		resolveConfig({ snapshotTriggerTokens: -5 });
	} catch (error) {
		threw = String(error.message).includes('snapshotTriggerTokens');
	}
	eq(threw, true, 'a negative threshold is rejected');
	eq(config.snapshotTriggerRatio, 0.5, 'the window ratio has a default');
	let ratioThrew = false;
	try {
		resolveConfig({ snapshotTriggerRatio: 1 });
	} catch (error) {
		ratioThrew = String(error.message).includes('strictly between 0 and 1');
	}
	eq(ratioThrew, true, 'a ratio of 1 is rejected: it must leave headroom before the ~80% compaction point');
	ratioThrew = false;
	try {
		resolveConfig({ snapshotTriggerRatio: 0 });
	} catch (error) {
		ratioThrew = String(error.message).includes('strictly between 0 and 1');
	}
	eq(ratioThrew, true, 'a zero ratio is rejected too');
});

await test('the pressure trigger scales with the routed window, with an absolute floor', async () => {
	const config = resolveConfig({ snapshotTriggerTokens: 100_000, snapshotTriggerRatio: 0.5 });
	// A 1M window: half of it.
	const big = thresholdFor(config, { tokens: 0, contextWindow: 1_000_000 });
	eq(big.threshold, 500_000);
	eq(big.source, 'ratio');
	// A 200k window must NOT wait for 500k — this is the entire point.
	const small = thresholdFor(config, { tokens: 0, contextWindow: 200_000 });
	eq(small.threshold, 100_000, 'a smaller window triggers proportionally earlier');
	eq(small.source, 'ratio');
	// Unknown window (before the first request/context event): absolute value.
	const unknown = thresholdFor(config, { tokens: 0 });
	eq(unknown.threshold, 100_000);
	eq(unknown.source, 'absolute');
	// The absolute value is a FLOOR, never a ceiling below the ratio.
	const tiny = thresholdFor(config, { tokens: 0, contextWindow: 20_000 });
	eq(tiny.threshold, 100_000, 'the floor stops a tiny window from firing constantly');
	eq(tiny.source, 'absolute');
});

await test('onPreStep compares against the window-relative threshold', async () => {
	const { root, service, session } = await fixture({
		projectedTokens: 420_000,
		overrides: { snapshotTriggerTokens: 100_000, snapshotTriggerRatio: 0.5 }
	});
	try {
		// 420k is below half of a 1M window, so nothing fires yet…
		session.requestContext = () => ({ contextWindow: 1_000_000 });
		service.onPreStep({ agent: { session } });
		await service.drain();
		eq(service.stats.snapshots, 0, 'below 50% of the window');
		// …but it IS above half of an 800k window, which is what a smaller route gives.
		session.requestContext = () => ({ contextWindow: 800_000 });
		service.onPreStep({ agent: { session } });
		await service.drain();
		eq(service.stats.snapshots, 1, 'above 50% of the smaller window');
		eq(service.stateFor(session.id).thresholdSource, 'ratio');
		eq(service.stateFor(session.id).threshold, 400_000);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

// ── replaying historical session logs ───────────────────────────────────────

await test('importHistory replays a session log into the days its turns started in', async () => {
	const sessionsRoot = await mkdtemp(join(tmpdir(), 'memtree-sessions-'));
	const sid = 'session-import-fixture';
	const dir = join(sessionsRoot, 'sessions', '--C-work--', sid);
	await mkdir(dir, { recursive: true });
	// Two days, both BEFORE the old hard-coded tree start of 2026-09-13 — which is
	// the point: importing history older than that constant used to be impossible.
	const dayA = Date.parse('2026-03-01T10:00:00+08:00');
	const dayB = Date.parse('2026-03-02T15:30:00+08:00');
	const lines = [
		JSON.stringify({ type: 'session', version: 0, id: sid, cwd: 'C:\\work', createdAt: dayA }),
		JSON.stringify({ type: 'user/message', seq: 1, time: dayA, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '第一天：决定用方案 A。' }] } }),
		JSON.stringify({ type: 'assistant/message', seq: 2, time: dayA + 5000, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '按方案 A 执行。' }] } } }),
		// A streaming fragment: 85% of a real log by volume, and no content of its
		// own — the finished assistant/message already carries the text.
		JSON.stringify({ type: 'reasoning-chunks', seq: 3, time: dayA + 5200, data: { chunks: ['想…'] } }),
		JSON.stringify({ type: 'user/message', seq: 4, time: dayB, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '第二天：方案 A 有坑，改 B。' }] } }),
	];
	// DSH appends ONE zstd frame per line, so the fixture must be many frames. A
	// single-frame file would satisfy a naive reader and starve the real one.
	await writeFile(join(dir, 'session.v4.jsonl.zstd'), Buffer.concat(lines.map((line) => zstdCompressSync(Buffer.from(line + '\n', 'utf8')))));

	const { root, service } = await fixture({ overrides: { dshHome: sessionsRoot } });
	try {
		// 1. Dry run is the default: it reports the plan and writes nothing.
		const dry = await service.importHistory({});
		eq(dry.dryRun, true);
		eq(dry.discovered, 1);
		eq(dry.sessions[0].dayCount, 2);
		eq(existsSync(nodePaths(root, '2026-03-01').dayFile), false, 'a dry run writes nothing');

		// 2. The real thing, snapshot-only (no model calls).
		const run = await service.importHistory({ dryRun: false, summarize: false });
		eq(run.written, 1);
		eq(run.failed, 0);
		eq(existsSync(nodePaths(root, '2026-03-01').dayFile), true, 'the older day exists');
		eq(existsSync(nodePaths(root, '2026-03-02').dayFile), true);
		eq(existsSync(nodePaths(root, '2026-03-01').monthFile), true, 'the month node exists');
		eq(existsSync(nodePaths(root, '2026-03-01').yearFile), true, 'the year node exists');

		// 3. A written snapshot must be DISCOVERABLE from its own day. Writing the
		//    file without refreshing that index is indistinguishable from not
		//    importing at all, because the index is how a reader finds it.
		const snapsA = await listSnapshots(nodePaths(root, '2026-03-01').dayDir);
		eq(snapsA.length, 1, 'the day index lists the imported snapshot');
		const readBack = await service.read({ level: 'snapshot', date: '2026-03-01', file: snapsA[0].file });
		eq(readBack.ok, true);
		includes(String(readBack.text), '决定用方案 A');
		excludes(String(readBack.text), '想…', 'streaming fragments are not kept');

		// 4. Idempotent: the watermark is per session, so a re-run finds it covered.
		const again = await service.importHistory({ dryRun: false, summarize: false });
		eq(again.written, 0);
		eq((await listSnapshots(nodePaths(root, '2026-03-01').dayDir)).length, 1, 'no duplicate snapshot');
	} finally {
		await rm(sessionsRoot, { recursive: true, force: true });
	}
});

Date.now = realDateNow;

report();
