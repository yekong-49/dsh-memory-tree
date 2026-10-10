/**
 * Pure-module tests: naming, dates, front matter, sentinel regions, event
 * projection, and the two-call summarizer's parsing — all without a running
 * harness and without touching the real tree.
 */

import { eq, excludes, includes, ok, report, test, throws } from './harness.mjs';
import {
	assertDigitComponent,
	assertRootForPlatform,
	DEFAULT_ROOT,
	isInsideRoot,
	isRecordableDate,
	joinPath,
	levelPath,
	localParts,
	nodePaths,
	pad,
	separatorOf,
	sessionToken,
	snapshotName,
	splitDate,
	START_DATE
} from '../lib/paths.js';
import { frontMatterMap, frontMatterValue, parseFrontMatter, setFrontMatter } from '../lib/frontmatter.js';
import { appendRegion, hasRegion, readRegion, regionText, replaceRegion } from '../lib/sentinel.js';
import { appendDayEntries, cell, DAY_SUMMARY_INTRO, dayEntryLine, dayTemplate, entryText, formatBytes, LEGACY_MARK, parseDaySummary, renderDaySummary, renderLongterm, renderMedia, renderMonth, renderSnapshotIndex, renderYear, table, PLACEHOLDER } from '../lib/templates.js';
import { changedFiles, fileLabel, firstSeqAfter, formatDelta, highestCoveredSeq, imageRefText, imagesIn, messageText, parseStamp, projectEvent, turnDaySegments, turnSlice, verbatimSlice } from '../lib/events.js';
import { extensionFor, mediaDir, mediaFileName, parseMediaName, sha256Of } from '../lib/media.js';
import { appendTurnRow, turnMarker, turnRow } from '../lib/turnlog.js';
import { parseEntries, parseSections, runCall, summarizeDay, summarizeUpper, TextAssembler, truncate, windowSlice } from '../lib/summarize.js';
import { detectSignal, isOurReminder, reminderMessage, reminderText } from '../lib/reminder.js';
import { planAssets, stampOf } from '../lib/backup.js';
import { countSensitive, isScrubbablePath, scrubText, scrubVerified } from '../lib/redact.js';

console.log('# pure modules');

// ── paths ───────────────────────────────────────────────────────────────────

await test('localParts projects an instant into the tree timezone', () => {
	// 2026-09-12T20:34:00Z is 2026-09-13 04:34 in +08:00: the local date is
	// what decides the folder, so a UTC-based date would misfile this write.
	const parts = localParts(new Date('2026-09-12T20:34:00Z'), 'Asia/Shanghai');
	eq(parts.dateText, '2026-09-13', 'local date');
	eq(parts.hour, 4, 'local hour');
	eq(parts.minute, 34, 'local minute');
	eq(parts.offsetText, '+08:00', 'offset');
	includes(parts.stamp, '+08:00', 'stamp carries the offset');
});

await test('localParts handles a different zone (UTC)', () => {
	const parts = localParts(new Date('2026-09-12T20:34:00Z'), 'UTC');
	eq(parts.dateText, '2026-09-12');
	eq(parts.hour, 20);
	eq(parts.offsetText, '+00:00');
});

await test('pad and digit components are strict', async () => {
	eq(pad(7), '07');
	eq(pad(123, 4), '0123');
	eq(assertDigitComponent('09', 'month'), '09');
	await throws(() => assertDigitComponent('..', 'month'), /1-4 digits/);
	await throws(() => assertDigitComponent('9/1', 'month'), /1-4 digits/);
});

await test('splitDate rejects impossible and pre-tree dates', async () => {
	eq(splitDate('2026-09-13').day, '13');
	await throws(() => splitDate('2026-02-30'), /not a real calendar date/);
	await throws(() => splitDate('2026-13-01'), /invalid month/);
	// The floor is a sanity bound, not a claim about when the tree began: it has
	// to sit far enough back that legitimate history can be imported (a hard-coded
	// recent date made backfill impossible).
	await throws(() => splitDate('1999-12-31'), /before the tree start/);
	await throws(() => splitDate('26-9-13'), /malformed date/);
	eq(isRecordableDate('2000-01-01'), true);
	eq(isRecordableDate('1999-12-31'), false);
	eq(START_DATE, '2000-01-01');
});

await test('nodePaths builds the documented layout with zero padding', () => {
	const layout = nodePaths('C:\\mem', '2026-09-13');
	eq(layout.longterm, 'C:\\mem\\longterm.md');
	eq(layout.index, 'C:\\mem\\index.md');
	eq(layout.yearFile, 'C:\\mem\\2026\\2026.md');
	eq(layout.monthFile, 'C:\\mem\\2026\\09\\2026-09.md');
	eq(layout.dayFile, 'C:\\mem\\2026\\09\\13\\2026-09-13.md');
	eq(layout.dayDir, 'C:\\mem\\2026\\09\\13');
});

await test('nodePaths tolerates a trailing separator on the root', () => {
	eq(nodePaths('C:\\mem\\', '2026-09-13').dayDir, 'C:\\mem\\2026\\09\\13');
});

await test('levelPath requires a date exactly where the spec does', async () => {
	eq(levelPath('C:\\M', 'index').path, 'C:\\M\\index.md');
	eq(levelPath('C:\\M', 'longterm').path, 'C:\\M\\longterm.md');
	eq(levelPath('C:\\M', 'year', '2026-09-13').path, 'C:\\M\\2026\\2026.md');
	eq(levelPath('C:\\M', 'month', '2026-09-13').path, 'C:\\M\\2026\\09\\2026-09.md');
	eq(levelPath('C:\\M', 'day', '2026-09-13').path, 'C:\\M\\2026\\09\\13\\2026-09-13.md');
	await throws(() => levelPath('C:\\M', 'day'), /requires a date/);
	await throws(() => levelPath('C:\\M', 'week'), /unknown level/);
});

await test('snapshotName is chronological, padded, and validated', async () => {
	const name = snapshotName('2026-09-13', { hour: 4, minute: 30, second: 12 }, 'pressure', 'session-deadbeef-0000-4000-8000-000000000000');
	eq(name, '2026-09-13T043012-pressure-deadbeef.md');
	// Lexicographic order must equal chronological order.
	const later = snapshotName('2026-09-13', { hour: 15, minute: 5, second: 0 }, 'manual', 'abc');
	ok(name < later, 'a 04:30 snapshot sorts before a 15:05 one');
	await throws(() => snapshotName('2026-09-13', { hour: 1, minute: 0, second: 0 }, 'whenever', 'x'), /unknown trigger/);
});

await test('sessionToken normalizes both id shapes and rejects junk', () => {
	eq(sessionToken('session-deadbeef-0000-4000-8000-000000000000'), 'deadbeef');
	eq(sessionToken('DEADBEEF-0000-4000'), 'deadbeef');
	eq(sessionToken(''), 'nosession');
	eq(sessionToken(undefined), 'nosession');
	// Path separators can never survive into a file name.
	excludes(sessionToken('..\\..\\evil'), '\\');
	excludes(sessionToken('a/b'), '/');
});

await test('isInsideRoot fences paths assembled from input', () => {
	ok(isInsideRoot('C:\\mem', 'C:\\mem\\2026\\09\\13\\x.md'), 'inside');
	ok(isInsideRoot('C:\\mem', 'C:\\mem'), 'the root itself');
	ok(!isInsideRoot('C:\\mem', 'C:\\memEvil\\x.md'), 'a prefix-sibling is outside');
	ok(!isInsideRoot('C:\\mem', 'C:\\other\\x.md'), 'another drive is outside');
});

await test('joinPath keeps the Windows shape', () => {
	eq(joinPath('C:\\mem', '2026', '09'), 'C:\\mem\\2026\\09');
	eq(joinPath('C:\\mem\\'), 'C:\\mem');
});

// The separator follows the ROOT, not `process.platform`. That is what lets
// these assertions run on any host — and it is why the tree was broken for
// exactly one deployment without any test noticing: every test ran on Windows,
// so a Windows-shaped result looked correct on every path.

await test('joinPath follows a POSIX root (the bug that emptied the cloud host)', () => {
	eq(joinPath('/srv/DSHMemory', '2026', '09'), '/srv/DSHMemory/2026/09');
	eq(joinPath('/srv/DSHMemory/'), '/srv/DSHMemory');

	const layout = nodePaths('/srv/DSHMemory', '2026-09-14');
	eq(layout.dayFile, '/srv/DSHMemory/2026/09/14/2026-09-14.md');
	eq(layout.dayDir, '/srv/DSHMemory/2026/09/14');
	eq(layout.monthFile, '/srv/DSHMemory/2026/09/2026-09.md');
	eq(levelPath('/srv/DSHMemory', 'longterm').path, '/srv/DSHMemory/longterm.md');
	// What the defect produced instead: ONE flat file in the root's parent,
	// whose name merely contains backslashes:
	//   /srv/DSHMemory\2026\09\14\2026-09-14.md
	// Writes succeeded, content was correct, and the configured root stayed empty.
	excludes(layout.dayFile, '\\', 'no backslash may survive into a POSIX tree path');
});

await test('separatorOf reads the separator from the root, not the platform', () => {
	eq(separatorOf('C:\\mem'), '\\');
	eq(separatorOf('/srv/DSHMemory'), '/');
	eq(separatorOf('\\\\server\\share'), '\\');
	// The FIRST separator decides, so a POSIX root whose own name happens to
	// contain a backslash — exactly what the defect produced — is still POSIX.
	eq(separatorOf('/srv/DSHMemory\\2026'), '/');
});

await test('isInsideRoot keeps POSIX case and backslash semantics', () => {
	ok(isInsideRoot('/srv/DSHMemory', '/srv/DSHMemory/2026/09/14/x.md'), 'inside');
	ok(isInsideRoot('/srv/DSHMemory', '/srv/DSHMemory'), 'the root itself');
	ok(!isInsideRoot('/srv/DSHMemory', '/srv/DSHMemoryEvil/x.md'), 'a prefix-sibling is outside');
	// POSIX is case-SENSITIVE. Folding case here would widen the fence.
	ok(!isInsideRoot('/srv/DSHMemory', '/srv/dshmemory/x.md'), 'a case-different sibling is outside');
	// On POSIX a backslash is an ordinary character, not a boundary.
	ok(!isInsideRoot('/srv/DSHMemory', '/srv/DSHMemory\\evil'), 'a backslash is not a boundary here');
});

await test('assertRootForPlatform rejects a root this platform cannot honour', async () => {
	// A POSIX root is legal everywhere, because Windows accepts both separators.
	eq(assertRootForPlatform('/srv/DSHMemory'), '/srv/DSHMemory');
	if (process.platform === 'win32') {
		eq(assertRootForPlatform('C:\\mem'), 'C:\\mem');
	} else {
		// A throw, not a warning: the failure it prevents is SILENT, and this
		// plugin's diagnostics go to `ctx.logger`, which the `web` profile does
		// not surface at all — a warning nobody can read is not a guard.
		await throws(() => assertRootForPlatform('C:\\mem'), /backslash/);
	}
});

await test('the default root is shaped for this platform', () => {
	if (process.platform === 'win32') {
		// The default must carry no hard-coded drive letter: a literal one was the very
		// trap this module guards against (see the note on DEFAULT_ROOT).
		eq(DEFAULT_ROOT.endsWith('DSHMemory'), true, 'the default must end in DSHMemory');
		eq(DEFAULT_ROOT.includes('\\'), true, 'a Windows default is backslash-shaped');
	} else {
		eq(DEFAULT_ROOT.includes('\\'), false, 'a POSIX default must not contain a backslash');
	}
	// Either way the default has to survive the guard it will meet in resolveConfig.
	eq(assertRootForPlatform(DEFAULT_ROOT), DEFAULT_ROOT);
});

// ── front matter ────────────────────────────────────────────────────────────

await test('front matter parses keys, quotes, and body', () => {
	const text = '---\nkind: memory-day\ndate: 2026-09-13\nsummary: "a: b"\n---\n\n# Title\n\nbody\n';
	const parsed = parseFrontMatter(text);
	eq(parsed.hasFrontMatter, true);
	eq(frontMatterValue(text, 'kind'), 'memory-day');
	eq(frontMatterValue(text, 'summary'), 'a: b', 'quoted value unquoted');
	includes(parsed.body, '# Title');
});

await test('setFrontMatter preserves unknown keys, comments, and hand-written body', () => {
	const text = '---\nkind: memory-day\ncustom: keep me\n# a hand comment\ndate: 2026-09-13\n---\n\nhand-written paragraph\n';
	const next = setFrontMatter(text, { summary: '新摘要', updated: '2026-09-13 05:00:00 +08:00' });
	includes(next, 'custom: keep me', 'unknown key survives');
	includes(next, '# a hand comment', 'hand comment survives');
	includes(next, 'hand-written paragraph', 'body survives');
	includes(next, 'summary: 新摘要');
	includes(next, 'updated: 2026-09-13 05:00:00 +08:00');
	eq(frontMatterValue(next, 'custom'), 'keep me');
});

await test('setFrontMatter replaces in place without reordering', () => {
	const text = '---\nkind: memory-day\ndate: 2026-09-13\n---\nbody\n';
	const next = setFrontMatter(text, { kind: 'memory-day-v2' });
	const keys = next.split('\n').filter((line) => /^[a-z]+:/.test(line)).map((line) => line.split(':')[0]);
	eq(keys.join(','), 'kind,date');
	eq(frontMatterValue(next, 'kind'), 'memory-day-v2');
});

await test('setFrontMatter adds a header to a file that lacks one', () => {
	const next = setFrontMatter('# Just a title\n\ntext\n', { kind: 'memory-day' });
	ok(next.startsWith('---\n'), 'header added at the top');
	includes(next, '# Just a title');
	eq(frontMatterValue(next, 'kind'), 'memory-day');
});

await test('an unterminated header is treated as a body, never rewritten', () => {
	const text = '---\nkind: memory-day\n\nbody without a closing delimiter\n';
	const parsed = parseFrontMatter(text);
	eq(parsed.hasFrontMatter, false);
	eq(frontMatterMap(text).kind, undefined);
});

await test('round-trip of a value containing a colon and Chinese text', () => {
	const text = setFrontMatter('---\nkind: x\n---\nb\n', { summary: '结论：路径要用绝对值' });
	eq(frontMatterValue(text, 'summary'), '结论：路径要用绝对值');
});

// ── sentinel regions ────────────────────────────────────────────────────────

await test('readRegion reports absence instead of guessing', () => {
	eq(readRegion('no regions here', 'MACHINE ROLLUP').found, false);
	eq(regionText('<!-- BEGIN MACHINE ROLLUP -->\nA\n<!-- END MACHINE ROLLUP -->', 'MACHINE ROLLUP'), 'A');
	eq(hasRegion('nothing', 'TURN LOG'), false);
});

await test('replaceRegion never touches text outside the region', () => {
	const text = 'hand above\n\n<!-- BEGIN MACHINE ROLLUP -->\nold\n<!-- END MACHINE ROLLUP -->\n\nhand below\n';
	const next = replaceRegion(text, 'MACHINE ROLLUP', 'new');
	includes(next, 'hand above');
	includes(next, 'hand below');
	includes(next, 'new');
	excludes(next, 'old');
});

await test('replaceRegion creates an absent region after the body', () => {
	const next = replaceRegion('hand written only\n', 'TURN LOG', '| a |\n| --- |');
	includes(next, 'hand written only');
	includes(next, '<!-- BEGIN TURN LOG -->');
	includes(next, '| a |');
});

await test('adjacent regions are independent', () => {
	const text = '<!-- BEGIN MACHINE ROLLUP -->\nR\n<!-- END MACHINE ROLLUP -->\n\n<!-- BEGIN TURN LOG -->\nL\n<!-- END TURN LOG -->\n';
	const next = replaceRegion(text, 'MACHINE ROLLUP', 'R2');
	eq(regionText(next, 'TURN LOG'), 'L', 'the other region is untouched');
	eq(regionText(next, 'MACHINE ROLLUP'), 'R2');
});

await test('appendRegion appends without reordering', () => {
	const text = '<!-- BEGIN TURN LOG -->\n| h |\n| --- |\n| one |\n<!-- END TURN LOG -->\n';
	const first = appendRegion(text, 'TURN LOG', '| two |');
	const second = appendRegion(first.text, 'TURN LOG', '| three |');
	eq(second.appended, 1);
	const body = regionText(second.text, 'TURN LOG');
	ok(body.indexOf('| one |') < body.indexOf('| two |'), 'first row stays above');
	ok(body.indexOf('| two |') < body.indexOf('| three |'), 'append order preserved');
});

await test('appendRegion drops blank lines and supports dropping placeholders', () => {
	const text = '<!-- BEGIN TURN LOG -->\n| （暂无） |\n<!-- END TURN LOG -->\n';
	const result = appendRegion(text, 'TURN LOG', ['', '  ', '| real |'], { dropMatching: /（暂无/ });
	excludes(result.text, '（暂无）');
	includes(result.text, '| real |');
	eq(appendRegion(text, 'TURN LOG', '   ').appended, 0);
});

// ── templates ───────────────────────────────────────────────────────────────

await test('cell escapes pipes and newlines so a table cannot break', () => {
	eq(cell('a|b'), 'a\\|b');
	eq(cell('line1\nline2'), 'line1 line2');
	eq(cell(''), '—');
	eq(cell(undefined), '—');
	eq(cell('abcdef', 4), 'abc…');
});

await test('table renders a header and separator', () => {
	const rendered = table(['a', 'b'], [['1', '2']]);
	eq(rendered, '| a | b |\n|---|---|\n| 1 | 2 |');
});

await test('day template carries all three regions with distinct contracts', () => {
	const text = dayTemplate({ dateText: '2026-09-13', stamp: '2026-09-13 04:00:00 +08:00', monthEntry: '../2026-09.md' });
	for (const region of ['DAY SUMMARY', 'MACHINE ROLLUP', 'TURN LOG']) {
		ok(hasRegion(text, region), `region ${region} present`);
	}
	includes(text, 'summary: （待首次快照后填写）');
	includes(text, '../2026-09.md');
});

await test('snapshot index renders a placeholder when empty and links rows otherwise', () => {
	const empty = renderSnapshotIndex([]);
	includes(empty, '（暂无快照）');
	const filled = renderSnapshotIndex([
		{ time: '04:30:12', trigger: 'pressure', session: 'deadbeef', range: '#0–#41', summary: '做了什么', file: '2026-09-13T043012-pressure-deadbeef.md' }
	]);
	includes(filled, '04:30:12');
	includes(filled, '#0–#41');
	includes(filled, '(2026-09-13T043012-pressure-deadbeef.md)', 'the file name is linked verbatim');
	excludes(filled, '（暂无快照）');
});

await test('day summary region is an append-only log, empty until an entry arrives', () => {
	const empty = renderDaySummary([]);
	includes(empty, PLACEHOLDER);
	includes(empty, DAY_SUMMARY_INTRO, 'the region states its own contract');
	excludes(empty, LEGACY_MARK, 'no legacy block is invented for a fresh day');
	const filled = renderDaySummary([{ clock: '04:47', text: '插件主体完成' }]);
	includes(filled, '- **04:47** 插件主体完成');
	excludes(filled, PLACEHOLDER);
	eq(filled, renderDaySummary(parseDaySummary(filled).entries), 'render/parse round-trips without drift');
});

await test('roll-up renderers emit one row per child', () => {
	const longterm = renderLongterm([{ year: '2026', summary: 'g', months: 1, snapshots: 3 }]);
	includes(longterm, '| 2026 | g | 1 | 3 |');
	const year = renderYear([{ month: '09', summary: 'g', days: 2, snapshots: 5, entry: '09/2026-09.md' }]);
	includes(year, '| 09 | g | 2 | 5 | 09/2026-09.md |');
});

await test("the month lists each day's own events, not one line about the day", () => {
	// The level above must let you READ a day, not just name it. A single index
	// line per day described only the newest thing that had happened, so a day
	// that began by building a plugin looked like a day spent doing whatever came
	// last. The day's own entries are reproduced instead.
	const month = renderMonth([{
		day: '13',
		date: '2026-09-13',
		summary: '一句话（不该出现在这里）',
		snapshots: 2,
		entry: '13/2026-09-13.md',
		entries: [
			{ clock: '04:47', text: '插件主体完成', line: '- **04:47** 插件主体完成' },
			{ clock: '21:49', text: '加了像素探针', line: '- **21:49** 加了像素探针' }
		]
	}]);
	includes(month, '### 13 日 · 2026-09-13');
	includes(month, '- **04:47** 插件主体完成', "the day's FIRST event is here, not only its last");
	includes(month, '- **21:49** 加了像素探针');
	includes(month, '2 份快照');
	includes(month, '[日文件](13/2026-09-13.md)', 'and the full detail is one link away');
	excludes(month, '一句话（不该出现在这里）', "the day's one-liner is not repeated as a teaser");

	includes(renderMonth([]), PLACEHOLDER);
	includes(renderMonth([{ day: '14', date: '2026-09-14', snapshots: 0, entry: 'x', entries: [] }]), '还没有关键事件条目');
});

// ── event projection ────────────────────────────────────────────────────────

/** Build a message-shaped event. */
const message = (content) => ({ content });

await test('messageText reads both string and part content', () => {
	eq(messageText({ content: 'plain' }), 'plain');
	eq(messageText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'a\nb');
	eq(messageText(undefined), '');
});

await test('messageText descends into tool-result content, where tool output actually lives', () => {
	// `createToolResultMessage` builds `{ type: 'tool-result', toolCallId,
	// content, isError }` with NO outer `.text`. Reading only top-level text
	// stored every tool result in the tree as empty — measured on the first two
	// snapshots at 519 of 519 tool results carrying nothing at all.
	eq(
		messageText({ content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'file contents here' }], isError: false }] }),
		'file contents here',
	);
	eq(messageText({ content: [{ type: 'tool-result', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }] }), 'a\nb');
	eq(messageText({ content: [{ type: 'tool-result', content: 'plain string' }] }), 'plain string');
	// An empty result stays empty rather than inventing placeholder text.
	eq(messageText({ content: [{ type: 'tool-result', content: [] }] }), '');
});

await test('an image block is reported as a reference rather than silently dropped', () => {
	const attachment = { attachmentId: 'sha256:1a2b3c4d5e6f7788', mediaType: 'image/png', bytes: 6149278, width: 2560, height: 1440 };
	const text = messageText({ content: [{ type: 'image', attachment }] });
	includes(text, 'sha256:1a2b3c4d', 'the short attachment id is kept, so the image can be found again');
	includes(text, '2560x1440', 'and its size');
	includes(text, 'image/png', 'and its type');
	// A block with no usable reference says so instead of pretending to be text.
	eq(messageText({ content: [{ type: 'image' }] }), '[图片（无引用信息）]');
	eq(imageRefText(null), '[图片（无引用信息）]');
	eq(imageRefText({ attachmentId: 'sha256:abcdef0123456789' }).includes('尺寸未知'), true);
});

await test('projectEvent understands each durable shape', () => {
	const user = projectEvent({ type: 'user/message', seq: 3, time: 1, data: { role: 'user', content: 'hi', source: { kind: 'user' } } });
	eq(user.text, 'hi');
	eq(user.turn, undefined, 'a user message has no turn field of its own');
	const assistant = projectEvent({ type: 'assistant/message', seq: 4, time: 2, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'done' }] }, usage: { inputTokens: 10, outputTokens: 5 } } });
	eq(assistant.text, 'done');
	eq(assistant.turn, 1);
	const call = projectEvent({ type: 'tool/call', seq: 5, time: 3, data: { turn: 1, step: 1, callId: 'c', name: 'write', arguments: '{"file_path":"a.js"}' } });
	eq(call.tool.name, 'write');
	eq(call.tool.args.file_path, 'a.js');
	eq(projectEvent({ type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } }), undefined, 'non-text events project to undefined');
});

await test('a malformed tool-call payload does not throw', () => {
	const call = projectEvent({ type: 'tool/call', seq: 1, time: 0, data: { turn: 1, name: 'write', arguments: '{"file_path": "trunc' } });
	eq(call.tool.args, undefined);
});

await test('changedFiles reads the real argument names and dedupes', () => {
	const records = [
		projectEvent({ type: 'tool/call', seq: 1, time: 0, data: { turn: 1, name: 'write', arguments: '{"file_path":"C:\\\\a\\\\lib\\\\x.js"}' } }),
		projectEvent({ type: 'tool/call', seq: 2, time: 0, data: { turn: 1, name: 'edit', arguments: '{"file_path":"C:\\\\a\\\\lib\\\\x.js"}' } }),
		projectEvent({ type: 'tool/call', seq: 3, time: 0, data: { turn: 1, name: 'read', arguments: '{"file_path":"C:\\\\a\\\\lib\\\\y.js"}' } }),
		projectEvent({ type: 'tool/call', seq: 4, time: 0, data: { turn: 1, name: 'edit', arguments: '{"file_path":"C:\\\\a\\\\lib\\\\z.js"}' } })
	];
	const files = changedFiles(records);
	eq(files.length, 2, 'duplicates collapse, read-only tools are excluded');
	includes(fileLabel(files), 'x.js');
	includes(fileLabel(files), 'z.js');
});

await test('fileLabel disambiguates duplicate basenames and caps the list', () => {
	eq(fileLabel([]), '—');
	eq(fileLabel(['a/deep/lib/x.js', 'b/other/lib/x.js']), 'deep/lib/x.js, other/lib/x.js');
	const many = fileLabel(['a.js', 'b.js', 'c.js', 'd.js', 'e.js'], 3);
	includes(many, 'a.js, b.js, c.js');
	includes(many, '(+2)');
});

await test('turnSlice derives headline, files, usage and range for one turn', () => {
	const events = [
		{ type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
		{ type: 'tool/call', seq: 1, time: 0, data: { turn: 1, step: 1, name: 'write', arguments: '{"file_path":"C:\\\\a\\\\b.js"}' } },
		{ type: 'tool/result', seq: 2, time: 0, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'ok' }] } } },
		{ type: 'assistant/message', seq: 3, time: 0, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '## 结论\n\n已完成修复' }] }, usage: { inputTokens: 100, outputTokens: 20 } } },
		{ type: 'turn/end', seq: 4, time: 0, data: { turn: 1, reason: { kind: 'completed' } } },
		{ type: 'assistant/message', seq: 5, time: 0, data: { turn: 2, step: 1, message: { content: [{ type: 'text', text: '下一轮' }] }, usage: { inputTokens: 999 } } }
	];
	const slice = turnSlice(events, 1);
	eq(slice.headline, '结论', 'markdown markers stripped from the headline');
	eq(slice.usage.total, 120, 'only this turn counts toward usage');
	eq(slice.usage.calls, 1);
	eq(slice.files.length, 1);
	eq(slice.range.fromSeq, 1);
	eq(slice.range.toSeq, 3);
});

await test('turnHeadline falls back when a turn has no text', () => {
	eq(turnSlice([{ type: 'tool/call', seq: 1, time: 0, data: { turn: 1, name: 'read', arguments: '{}' } }], 1).headline, '（本轮无文本输出）');
});

await test('formatDelta renders compact signed deltas', () => {
	eq(formatDelta(12345), '+12.3k');
	eq(formatDelta(-840), '-840');
	eq(formatDelta(0), '±0');
	eq(formatDelta(undefined), '—');
});

await test('verbatimSlice honors the range and the byte budget', () => {
	const events = [
		{ type: 'user/message', seq: 0, time: 0, data: { role: 'user', content: 'zero', source: { kind: 'user' } } },
		{ type: 'user/message', seq: 1, time: 0, data: { role: 'user', content: 'one', source: { kind: 'user' } } },
		{ type: 'assistant/message', seq: 2, time: 0, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'two' }] } } }
	];
	const all = verbatimSlice(events, 0, 2, 100_000);
	eq(all.records, 3);
	includes(all.text, 'zero');
	includes(all.text, 'two');
	eq(all.truncated, false);
	const narrowed = verbatimSlice(events, 1, 2, 100_000);
	excludes(narrowed.text, 'zero');
	includes(narrowed.text, 'one');
	const clipped = verbatimSlice(events, 0, 2, 200);
	eq(clipped.truncated, true);
});

await test('an over-long slice keeps BOTH ends, because the newest record is the one worth keeping', () => {
	// Keeping only the head is backwards for a record. On 2026-09-14 a slice that
	// a day-boundary bug had mis-ranged to span an entire session spent its whole
	// budget re-recording events thirteen earlier snapshots already held, and
	// dropped everything from there to the present — so the newest half-day ended
	// up in no snapshot at all.
	const events = [];
	for (let seq = 0; seq < 400; seq += 1) {
		events.push({
			type: 'user/message',
			seq,
			time: 0,
			data: { role: 'user', content: `记录编号-${seq}-${'x'.repeat(60)}`, source: { kind: 'user' } }
		});
	}
	const slice = verbatimSlice(events, 0, 399, 2_000);
	eq(slice.truncated, true);
	eq(slice.records, 400, 'the range is still reported as covering every record in it');
	includes(slice.text, '记录编号-0-', 'the oldest record is kept');
	includes(slice.text, '记录编号-399-', 'AND the newest one — this is the whole point');
	includes(slice.text, '省略中段', 'and the gap is marked, so a reader knows text is missing');
	excludes(slice.text, '记录编号-200-', 'the middle is what gets dropped');
});

await test('a slice that fits is returned whole, with no marker', () => {
	const events = [
		{ type: 'user/message', seq: 0, time: 0, data: { role: 'user', content: 'short', source: { kind: 'user' } } }
	];
	const slice = verbatimSlice(events, 0, 0, 100_000);
	eq(slice.truncated, false);
	eq(slice.records, 1);
	excludes(slice.text, '省略');
});

await test('highestCoveredSeq finds the highest toSeq', () => {
	eq(highestCoveredSeq([{ toSeq: '10' }, { toSeq: '41' }, { toSeq: '7' }]), 41);
	eq(highestCoveredSeq([{}, { toSeq: 'nonsense' }]), -1);
	eq(highestCoveredSeq([]), -1);
});

await test('a turn belongs to the day its human message was SENT, not to the day it finished', () => {
	// The rule, in one case: a message sent at 23:50 and answered at 00:10 is the
	// previous day's memory. Keying on the reply instead would file the whole
	// exchange under the new day and lose it from the day the human was actually
	// working in.
	const events = [
		{ type: 'user/message', seq: 0, time: 100, data: { role: 'user', content: '深夜问的', source: { kind: 'user' } } },
		{ type: 'assistant/message', seq: 1, time: 190, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '还没答完' }] } } },
		// The reply crosses midnight; the TURN still belongs to the day it was asked.
		{ type: 'assistant/message', seq: 2, time: 230, data: { turn: 1, step: 2, message: { content: [{ type: 'text', text: '答完了' }] } } },
		{ type: 'user/message', seq: 3, time: 260, data: { role: 'user', content: '早上问的', source: { kind: 'user' } } }
	];
	const dayOf = (ms) => (ms < 200 ? '2026-09-13' : '2026-09-14');
	const segments = turnDaySegments(events, 0, 3, dayOf);
	eq(segments.length, 2, 'the range splits into two days');
	eq(segments[0].dateText, '2026-09-13');
	eq(segments[0].toSeq, 2, 'the answer that landed after midnight stays with its question');
	eq(segments[1].dateText, '2026-09-14');
	eq(segments[1].fromSeq, 3);
});

await test('the segments tile the range exactly — no gap, no overlap', () => {
	// Coverage is recorded as fromSeq/toSeq and the next snapshot resumes at the
	// highest toSeq, so a gap loses events forever and an overlap records the same
	// ones twice. Projection drops events with no text, which is why a segment's
	// own first/last record is not a safe boundary.
	const events = [];
	for (let seq = 0; seq < 12; seq += 1) {
		// Every third event carries no text and is dropped by projection.
		if (seq % 3 === 1) events.push({ type: 'turn/start', seq, time: seq * 10, data: { turn: seq } });
		else if (seq % 3 === 2) events.push({ type: 'user/message', seq, time: seq * 10, data: { role: 'user', content: `q${seq}`, source: { kind: 'user' } } });
		else events.push({ type: 'assistant/message', seq, time: seq * 10, data: { turn: seq, step: 1, message: { content: [{ type: 'text', text: `a${seq}` }] } } });
	}
	const segments = turnDaySegments(events, 0, 11, (ms) => (ms < 60 ? 'day-one' : 'day-two'));
	ok(segments.length >= 2, 'the range really did split');
	eq(segments[0].fromSeq, 0, 'the first segment starts where the range starts');
	eq(segments[segments.length - 1].toSeq, 11, 'the last segment ends where the range ends');
	for (let index = 1; index < segments.length; index += 1) {
		eq(segments[index].fromSeq, segments[index - 1].toSeq + 1, `segment ${index} begins immediately after segment ${index - 1}`);
	}
	const covered = segments.reduce((sum, segment) => sum + (segment.toSeq - segment.fromSeq + 1), 0);
	eq(covered, 12, 'every seq in the range belongs to exactly one segment');
});

await test('a range that stays inside one day is a single segment', () => {
	const events = [
		{ type: 'user/message', seq: 0, time: 10, data: { role: 'user', content: 'q', source: { kind: 'user' } } },
		{ type: 'assistant/message', seq: 1, time: 20, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'a' }] } } }
	];
	const segments = turnDaySegments(events, 0, 1, () => '2026-09-13');
	eq(segments.length, 1);
	eq(segments[0].fromSeq, 0);
	eq(segments[0].toSeq, 1);
});

await test('a plugin-injected message does not start a turn', () => {
	// This tree appends its own cross-session reminders as user-role messages. If
	// those counted as turn starts, the day of a record would be decided by when a
	// reminder happened to be appended.
	const events = [
		{ type: 'user/message', seq: 0, time: 10, data: { role: 'user', content: 'human', source: { kind: 'user' } } },
		{ type: 'user/message', seq: 1, time: 900, data: { role: 'user', content: 'plugin reminder', source: { kind: 'plugin', plugin: 'dsh-memory-tree' } } }
	];
	const segments = turnDaySegments(events, 0, 1, (ms) => (ms < 500 ? 'human-day' : 'reminder-day'));
	eq(segments.length, 1, 'the reminder does not move the record to another day');
	eq(segments[0].dateText, 'human-day');
});

// ── turn log row ────────────────────────────────────────────────────────────

/**
 * Split a Markdown row into its cells, treating `\|` as content.
 *
 * A naive `split('|')` would count an escaped pipe as a column boundary, which
 * is exactly the bug that would silently corrupt a table.
 * @param {string} row - the rendered row.
 * @returns {string[]} the cell texts.
 */
function rowCells(row) {
	return row
		.split(/(?<!\\)\|/)
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
}

await test('fileLabel handles a raw Windows path and duplicate basenames', () => {
	eq(fileLabel(['C:\\a\\b\\lib\\x.js']), 'x.js', 'backslash paths are split too');
	eq(fileLabel(['a/lib/x.js', 'b/lib/x.js']), 'a/lib/x.js, b/lib/x.js', 'grows left until the labels are distinct');
	eq(fileLabel(['/root/a/x.js', '/root/b/x.js']), 'a/x.js, b/x.js');
	eq(fileLabel(['C:\\p\\q\\same.js', 'C:\\p\\q\\same.js']), 'same.js, same.js', 'an identical path keeps its basename instead of a full absolute path');
});

await test('turnRow matches the documented five columns and is dedupable', () => {
	const row = turnRow({ clock: '04:35:02', turn: 12, sessionToken: 'deadbeef', delta: 12_300, files: ['C:\\a\\b\\lib\\x.js'], headline: '修好了定位' });
	const cells = rowCells(row);
	eq(cells.length, 5, 'exactly five columns');
	eq(cells[0], '04:35:02');
	eq(cells[1], 'T12·deadbeef');
	eq(cells[2], '+12.3k');
	eq(cells[3], 'x.js');
	eq(cells[4], '修好了定位');
	includes(row, turnMarker(12, 'deadbeef'), 'the marker used for dedupe is present in the row');
});

await test('a pipe in a headline cannot break the row', () => {
	const row = turnRow({ clock: '00:00:00', turn: 1, sessionToken: 'x', delta: undefined, files: [], headline: 'a | b' });
	includes(row, 'a \\| b', 'the pipe is escaped for Markdown');
	eq(rowCells(row).length, 5, 'still five columns');
});

// ── summarizer ──────────────────────────────────────────────────────────────

await test('TextAssembler joins text deltas and records the protocol it saw', () => {
	const assembler = new TextAssembler();
	assembler.push({ type: 'block-start', index: 0, blockType: 'text' });
	assembler.push({ type: 'text-delta', index: 0, text: '你好' });
	assembler.push({ type: 'text-delta', index: 0, text: '世界' });
	assembler.push({ type: 'block-end', index: 0, block: { text: '你好世界' } });
	assembler.push({ type: 'finish', reason: { kind: 'stop' } });
	eq(assembler.text, '你好世界');
	eq(assembler.ok, true);
	eq(assembler.observed.join(','), 'block-start,text-delta,block-end,finish');
});

await test('TextAssembler prefers the authoritative block-end text', () => {
	const assembler = new TextAssembler();
	assembler.push({ type: 'block-start', index: 0, blockType: 'text' });
	assembler.push({ type: 'text-delta', index: 0, text: 'par' });
	assembler.push({ type: 'block-end', index: 0, block: { text: 'partial-complete' } });
	eq(assembler.text, 'partial-complete');
});

await test('TextAssembler treats non-stop finishes and errors as failure', () => {
	const aborted = new TextAssembler();
	aborted.push({ type: 'text-delta', index: 0, text: 'x' });
	aborted.push({ type: 'finish', reason: { kind: 'aborted' } });
	eq(aborted.ok, false);
	const failed = new TextAssembler();
	failed.push({ type: 'error', failure: { message: 'boom' } });
	eq(failed.ok, false);
});

await test('TextAssembler ignores reasoning blocks in the final text', () => {
	const assembler = new TextAssembler();
	assembler.push({ type: 'block-start', index: 0, blockType: 'reasoning' });
	assembler.push({ type: 'reasoning-delta', index: 0, text: 'thinking…' });
	assembler.push({ type: 'block-start', index: 1, blockType: 'text' });
	assembler.push({ type: 'text-delta', index: 1, text: '答案' });
	eq(assembler.text, '答案');
});

await test('parseSections splits named headings', () => {
	const sections = parseSections('## 一句话\n概括\n\n## 摘要\n详细内容\n第二行\n', ['一句话', '摘要']);
	eq(sections['一句话'], '概括');
	eq(sections['摘要'], '详细内容\n第二行');
	eq(parseSections('no headings at all', ['一句话'])['一句话'], undefined);
});

/** A fake llm service that replays a scripted chunk stream. */
function fakeLlm(chunks, capture) {
	return {
		stream(options) {
			if (capture !== undefined) capture.push(options);
			return (async function* generate() {
				for (const chunk of chunks) yield chunk;
			})();
		}
	};
}

/**
 * Script a well-formed text answer.
 * @param {string} body - the answer text.
 * @returns {any[]} the chunk list.
 */
function textStream(body) {
	return [
		{ type: 'block-start', index: 0, blockType: 'text' },
		{ type: 'text-delta', index: 0, text: body },
		{ type: 'block-end', index: 0, block: { text: body } },
		{ type: 'finish', reason: { kind: 'stop' } }
	];
}

await test('runCall passes the exact request shape the harness expects', async () => {
	const captured = [];
	const result = await runCall({
		llm: fakeLlm(textStream('ok'), captured),
		route: { provider: 'deepseek', model: 'deepseek-v4-flash' },
		system: 'sys',
		user: 'usr',
		maxTokens: 123,
		sessionId: 'session-abc',
		plugin: 'test-plugin'
	});
	eq(result.ok, true);
	eq(result.text, 'ok');
	eq(captured.length, 1);
	const options = captured[0];
	eq(options.provider, 'deepseek');
	eq(options.model, 'deepseek-v4-flash');
	eq(options.system, 'sys');
	eq(options.maxTokens, 123);
	eq(options.sessionId, 'session-abc');
	eq(options.purpose, undefined, 'purpose is a closed union; we must not invent a value');
	eq(options.messages.length, 1);
	eq(options.messages[0].role, 'user');
	eq(options.messages[0].content[0].type, 'text');
	eq(options.messages[0].content[0].text, 'usr');
	eq(options.messages[0].source.kind, 'plugin:test-plugin', 'producer-owned source kind (v4 admission rule)');
	ok(options.messages[0].source.kind !== 'plugin', 'never the retired v3 wrapper');
	ok(typeof options.messages[0].id === 'string' && options.messages[0].id.length > 0, 'message carries a stable id');
});

await test('runCall reports missing llm and missing route instead of throwing', async () => {
	const noLlm = await runCall({ llm: undefined, route: { provider: 'p', model: 'm' }, system: 's', user: 'u', maxTokens: 1, plugin: 't' });
	eq(noLlm.ok, false);
	includes(noLlm.error, 'llm service is unavailable');
	const noRoute = await runCall({ llm: fakeLlm([]), route: undefined, system: 's', user: 'u', maxTokens: 1, plugin: 't' });
	eq(noRoute.ok, false);
	includes(noRoute.error, 'no provider/model route');
});

await test('runCall survives a throwing stream', async () => {
	const llm = {
		stream() {
			return (async function* generate() {
				yield { type: 'text-delta', index: 0, text: 'partial' };
				throw new Error('network down');
			})();
		}
	};
	const result = await runCall({ llm, route: { provider: 'p', model: 'm' }, system: 's', user: 'u', maxTokens: 1, plugin: 't' });
	eq(result.ok, false);
	includes(result.error, 'network down');
});

await test("summarizeDay returns the slice's OWN one-liner plus the NEW entries", async () => {
	// Two answers, two readers. The one-liner becomes this snapshot's row in the
	// day index — it must describe THIS slice. The entries go into the day's log.
	// Stamping the day's whole-day line into every snapshot header made the whole
	// index repeat one sentence, which is how this distinction got noticed.
	const body = '## 一句话\n修好了定位 bug，根因是 IDictionary 读不到键\n\n## 事件\n- 修好了定位 bug，根因是 IDictionary 读不到键\n- 补了回归测试\n';
	const result = await summarizeDay({
		llm: fakeLlm(textStream(body)),
		route: { provider: 'p', model: 'm' },
		maxTokens: 100,
		timeoutMs: 1000,
		plugin: 't',
		dateText: '2026-09-13',
		trigger: 'manual',
		slice: 'raw text',
		truncated: false
	});
	eq(result.ok, true);
	eq(result.gist, '修好了定位 bug，根因是 IDictionary 读不到键');
	eq(result.entries.length, 2);
	includes(result.entries[0], 'IDictionary');
	includes(result.entries[1], '回归测试');
	eq(result.nothing, false);
});

await test('a missing 事件 section means "nothing to record", not a failed call', async () => {
	// The one-liner proves the call worked, and the slice still reaches the tree
	// through the snapshot itself and the turn log. Failing here would append a
	// permanent failure entry to the day for a slice that simply had no events.
	const result = await summarizeDay({
		llm: fakeLlm(textStream('## 一句话\n这一轮只是确认现状，没有新产出\n')),
		route: { provider: 'p', model: 'm' },
		maxTokens: 100,
		timeoutMs: 1000,
		plugin: 't',
		dateText: '2026-09-13',
		trigger: 'manual',
		slice: 'raw',
		truncated: false
	});
	eq(result.ok, true);
	eq(result.entries.length, 0);
	eq(result.nothing, true);
	includes(result.gist, '确认现状', 'and the slice still gets its own index line');
});

await test('summarizeDay accepts an explicit 无 and rejects unstructured prose', async () => {
	const quiet = await summarizeDay({
		llm: fakeLlm(textStream('## 一句话\n只是聊天\n\n## 事件\n无')),
		route: { provider: 'p', model: 'm' },
		maxTokens: 100,
		timeoutMs: 1000,
		plugin: 't',
		dateText: '2026-09-13',
		trigger: 'manual',
		slice: 'raw',
		truncated: false
	});
	eq(quiet.ok, true);
	eq(quiet.entries.length, 0);
	eq(quiet.nothing, true, 'a quiet slice is a success with no entries, not a failure');

	// A paragraph with no bullets would otherwise be appended as if it were an
	// event, preamble and all. It must be reported as a failed call instead.
	const prose = await summarizeDay({
		llm: fakeLlm(textStream('## 一句话\n做了些事\n\n## 事件\n好的，下面是本次的总结：\n\n这段切片主要做了三件事，第一件是……\n第二件是……')),
		route: { provider: 'p', model: 'm' },
		maxTokens: 100,
		timeoutMs: 1000,
		plugin: 't',
		dateText: '2026-09-13',
		trigger: 'manual',
		slice: 'raw',
		truncated: false
	});
	eq(prose.ok, false);
	includes(prose.error, 'bullet');
});

await test('parseEntries takes bullets, tolerates a single short line, refuses an essay', () => {
	eq(parseEntries('- a\n- b\n').entries.length, 2);
	eq(parseEntries('1. a\n2. b\n').entries.length, 2, 'numbered lists count');
	eq(parseEntries('  * a  ').entries.length, 1);
	eq(parseEntries('（无）').nothing, true);
	eq(parseEntries('一句话就说完了').entries[0], '一句话就说完了');
	eq(parseEntries('第一段\n\n第二段\n\n第三段').malformed, true);
	eq(parseEntries('').malformed, true);
});

await test('summarizeUpper extracts all four levels from one call', async () => {
	const body = '## 当日\n今天从零建了记忆树的插件骨架，并修好定位 bug\n\n## 月\n九月：插件从零到可用\n\n## 年\n2026：DSH 插件体系打通\n\n## 长期\n持续把 DSH 变成可自控、有记忆的工作台\n';
	const result = await summarizeUpper({
		llm: fakeLlm(textStream(body)),
		route: { provider: 'p', model: 'm' },
		maxTokens: 100,
		timeoutMs: 1000,
		plugin: 't',
		monthLabel: '2026-09',
		yearLabel: '2026',
		daySummary: '- **04:47** 插件骨架完成',
		monthGists: ['12日: 更早的一天'],
		yearGists: ['09月: 九月'],
		allYears: ['2026年: 今年']
	});
	eq(result.ok, true);
	includes(result.day, '记忆树的插件骨架', 'the day level is answered too');
	eq(result.month, '九月：插件从零到可用');
	eq(result.year, '2026：DSH 插件体系打通');
	includes(result.longterm, '可自控');
});

await test('summarizeUpper reports failure when no section is recognizable', async () => {
	const result = await summarizeUpper({
		llm: fakeLlm(textStream('抱歉，我无法完成')),
		route: { provider: 'p', model: 'm' },
		maxTokens: 100,
		timeoutMs: 1000,
		plugin: 't',
		monthLabel: '2026-09',
		yearLabel: '2026',
		monthGists: [],
		yearGists: [],
		allYears: []
	});
	eq(result.ok, false);
	includes(result.error, 'no recognizable sections');
});

await test('truncate shortens without exceeding the limit', () => {
	eq(truncate('abcdef', 3).length, 3);
	eq(truncate('ab', 5), 'ab');
});

await test('windowSlice keeps both ends so a long slice does not summarize only its opening', () => {
	const text = `${'A'.repeat(500)}${'M'.repeat(500)}${'Z'.repeat(500)}`;
	const short = windowSlice(text, 2000);
	eq(short, text, 'text under the limit is returned whole');
	const windowed = windowSlice(text, 300);
	eq(windowed.length <= 300, true, 'the result respects the budget');
	includes(windowed, 'AAAA', 'the head survives');
	includes(windowed, 'ZZZZ', 'the tail survives');
	includes(windowed, '省略中段', 'and the reader is told what was dropped');
	excludes(windowed, 'MMMM', 'the middle is what got dropped');
	// The tail gets the larger share, because current state matters most.
	ok(windowed.lastIndexOf('Z') > windowed.indexOf('A') + 1, 'the tail is present');
	const tailHeavy = windowSlice(text, 300, 0.1);
	ok((tailHeavy.match(/Z/g) ?? []).length > (windowed.match(/Z/g) ?? []).length, 'a lower head ratio keeps more of the end');
	eq(windowSlice('', 10), '');
	eq(windowSlice(text, 0), text, 'a zero budget means no windowing');
});

// ── turnlog fs helper (no harness needed) ───────────────────────────────────

await test('appendTurnRow skips a duplicate marker', async () => {
	const { mkdtemp, rm, mkdir, writeFile, readFile } = await import('node:fs/promises');
	const { tmpdir } = await import('node:os');
	const { join } = await import('node:path');
	const dir = await mkdtemp(join(tmpdir(), 'memtree-pure-'));
	try {
		const file = join(dir, 'day.md');
		await writeFile(file, dayTemplate({ dateText: '2026-09-13', stamp: 's', monthEntry: '../2026-09.md' }), 'utf8');
		const mutex = { run: (_key, action) => action() };
		const row = turnRow({ clock: '01:00:00', turn: 3, sessionToken: 'ab', delta: 5, files: [], headline: 'h' });
		eq(await appendTurnRow({ dayFile: file, row, marker: turnMarker(3, 'ab'), mutex }), 'appended');
		eq(await appendTurnRow({ dayFile: file, row, marker: turnMarker(3, 'ab'), mutex }), 'duplicate');
		const text = await readFile(file, 'utf8');
		eq(text.split('T3·ab').length - 1, 1, 'the row appears exactly once');
		eq(await appendTurnRow({ dayFile: join(dir, 'missing.md'), row, marker: turnMarker(3, 'ab'), mutex }), 'missing');
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// ── reminder ────────────────────────────────────────────────────────────────

await test('a cross-session signal is detected without matching ordinary prose', () => {
	eq(detectSignal('上次那个 bug 怎么修的'), '上次');
	eq(detectSignal('我们之前是怎么处理的？'), '我们之前');
	eq(detectSignal('Last time we hit this'), 'last time');
	eq(detectSignal('把 service.js 的缩进改一下'), undefined, 'an ordinary request fires nothing');
	eq(detectSignal('运行之前的命令'), undefined, '「之前」 alone is far too common to be a signal');
	eq(detectSignal(''), undefined);
	eq(detectSignal(undefined), undefined);
});

await test('the reminder text names the signal, the read path, and the licence to ignore it', () => {
	const text = reminderText('上次', 'C:\\mem\\');
	includes(text, '上次', 'it names the phrase that fired');
	includes(text, 'memory_search', 'it names the cheap read path');
	includes(text, '`C:\\mem`', 'the root is reported trimmed of its trailing separator');
	includes(text, '忽略', 'and states that the model may ignore it');
});

await test('the reminder message mirrors createUserMessage and carries a v4-admissible producer kind', () => {
	const message = reminderMessage('hello');
	eq(message.role, 'user');
	ok(typeof message.id === 'string' && message.id.length > 0, 'it carries a generated id');
	// DSH 0.1.7 format v4 refuses the retired v3 wrapper: a bare `kind: 'plugin'`
	// fails the whole turn with "format v4 message requires a producer-owned
	// source kind" (asserted against the real admission rule below).
	eq(message.source.kind, 'plugin:dsh-memory-tree', 'producer-owned, never mistaken for the human typing');
	ok(message.source.kind !== 'plugin', 'and NOT the retired v3 wrapper the v4 admission rejects');
	ok(/^plugin:.+/.test(message.source.kind), 'shaped exactly like the v3→v4 migration rewrites it');
	eq(message.source.plugin, undefined, 'the legacy `plugin` field is not written back');
	eq(message.content[0].type, 'text');
	ok(Object.isFrozen(message), 'frozen, like the real createUserMessage output');
	ok(isOurReminder(message), 'and recognizable as ours');
	ok(isOurReminder({ source: { kind: 'plugin', plugin: 'dsh-memory-tree' } }), 'legacy log entries stay recognizable');
	ok(!isOurReminder({ source: { kind: 'user' } }), 'a human message is not');
	ok(!isOurReminder({ source: { kind: 'plugin', plugin: 'someone-else' } }), 'nor is another plugin legacy reminder');
	ok(!isOurReminder(undefined), 'and neither is nothing');
	ok(message.id !== reminderMessage('hello').id, 'each reminder gets a fresh identity');
});

// ── media archive ───────────────────────────────────────────────────────────

await test('media names carry the date, turn, session and image digest', () => {
	const attachment = { attachmentId: 'sha256:a1b2c3d4e5f60718', mediaType: 'image/png' };
	const file = mediaFileName({ stamp: '2026-09-13 05:51:05 +08:00', turn: 42, sessionToken: 'deadbeef', attachment });
	eq(file, '2026-09-13T055105-T42-deadbeef-a1b2c3d4.png');
	// The name is self-describing: moved out of its directory it still says when,
	// which conversation, and which turn.
	const parsed = parseMediaName(file);
	eq(parsed.turn, 42, 'the turn is recoverable');
	eq(parsed.sessionToken, 'deadbeef', 'so is the session');
	eq(parsed.digest, 'a1b2c3d4', 'and the image identity');
	eq(extensionFor('image/jpeg'), 'jpg');
	eq(extensionFor('image/webp'), 'webp');
	eq(extensionFor('application/pdf'), 'bin', 'an unexpected type still gets a safe extension');
	eq(sha256Of(attachment), 'a1b2c3d4e5f60718');
	eq(sha256Of({ attachmentId: 'nonsense' }), '', 'an id that is not content-addressed yields no digest');
	eq(sha256Of(undefined), '');
	// Media lives inside the day directory, so drilling to a day finds its images.
	eq(mediaDir('C:\\mem', '2026-09-13').endsWith('2026\\09\\13\\media'), true);
});

await test('the media index links files rather than embedding them', () => {
	includes(renderMedia([]), '还没有归档图片', 'an empty archive says so plainly');
	const rendered = renderMedia([{ file: '2026-09-13T055105-T42-deadbeef-a1b2c3d4.png', bytes: 6149278, turn: 42, sessionToken: 'deadbeef' }]);
	includes(rendered, '05:51:05', 'the clock comes back out of the file name');
	includes(rendered, 'T42');
	includes(rendered, 'deadbeef');
	includes(rendered, '5.9 MB');
	includes(rendered, '(media/2026-09-13T055105-T42-deadbeef-a1b2c3d4.png)', 'the row links the file');
	excludes(rendered, '![', 'a link, not an embed, so the day file stays readable as text');
	eq(formatBytes(512), '512 B');
	eq(formatBytes(2048), '2.0 KB');
	eq(formatBytes(6149278), '5.9 MB');
	eq(formatBytes(undefined), '—');
});

await test('imagesIn finds an image wherever it is nested', () => {
	const attachment = { attachmentId: 'sha256:fff000', mediaType: 'image/png', width: 1, height: 1 };
	// A screenshot arrives HERE, not at the top level: tool output is nested one
	// block deeper, so a shallow scan finds nothing and the archive stays empty.
	const viaTool = { message: { content: [{ type: 'tool-result', content: [{ type: 'text', text: 'x' }, { type: 'image', attachment }] }] } };
	eq(imagesIn(viaTool).length, 1, 'a nested tool-result image is found');
	eq(imagesIn(viaTool)[0].attachmentId, 'sha256:fff000');
	// A human-pasted image rides the message itself.
	eq(imagesIn({ data: { content: [{ type: 'image', attachment }] } }).length, 1, 'a pasted image is found');
	eq(imagesIn({ message: { content: [{ type: 'text', text: 'no images' }] } }).length, 0);
	eq(imagesIn({}).length, 0);
	eq(imagesIn(undefined).length, 0);
});

// ── asset backup ────────────────────────────────────────────────────────────

await test('the backup plan discovers plugins instead of listing them', async () => {
	const { mkdtemp, rm, mkdir, writeFile } = await import('node:fs/promises');
	const { tmpdir } = await import('node:os');
	const workspace = await mkdtemp(joinPath(tmpdir(), 'memtree-plan-'));
	try {
		// A hardcoded plugin list silently stopped covering the workspace the
		// moment a third plugin appeared. Discovery is the fix, so discovery is
		// what gets asserted: every `dsh-*` directory, and nothing else.
		for (const name of ['dsh-memory-tree', 'dsh-alpha', 'dsh-beta']) {
			await mkdir(joinPath(workspace, name), { recursive: true });
		}
		await mkdir(joinPath(workspace, '_scripts'), { recursive: true });
		await mkdir(joinPath(workspace, 'not-a-plugin'), { recursive: true });
		await writeFile(joinPath(workspace, 'dsh-memory-tree', 'package.json'), '{}\n', 'utf8');

		const plan = planAssets({ dshHome: joinPath('C:', 'home', '.dsh'), workspace });
		const plugins = plan.filter((entry) => entry.to.startsWith('plugins/')).map((entry) => entry.to).sort();
		eq(
			plugins.join(','),
			'plugins/dsh-alpha,plugins/dsh-beta,plugins/dsh-memory-tree',
			'every dsh-* directory is planned'
		);
		eq(plugins.includes('plugins/not-a-plugin'), false, 'and nothing else is');
		// Every entry explains itself: the manifest is read by someone deciding
		// whether a restore is complete, and a bare path list cannot answer that.
		eq(plan.every((entry) => typeof entry.note === 'string' && entry.note.length > 0), true, 'every entry carries a note');
		eq(plan.every((entry) => entry.kind === 'dir' || entry.kind === 'file'), true, 'and declares its kind');
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}

	// Without a workspace the workspace-derived entries simply disappear, rather
	// than pointing at paths that do not exist.
	const home = joinPath('C:', 'home', '.dsh');
	const noWorkspace = planAssets({ dshHome: home });
	eq(noWorkspace.some((entry) => entry.to.startsWith('plugins/')), false, 'no workspace means no plugin sources');
	eq(noWorkspace.some((entry) => entry.to === 'skills'), true, 'but the global assets are still covered');
	eq(noWorkspace.some((entry) => entry.to === 'rules/AGENTS.global.md'), true, 'including the global rule file');
	eq(noWorkspace.some((entry) => entry.to.startsWith('install-state/')), true, 'and the install state');
	eq(noWorkspace.some((entry) => entry.to === 'persona'), true, 'and the agent presets');
});

await test('a workspace with no plugins is not an error', async () => {
	const { mkdtemp, rm } = await import('node:fs/promises');
	const { tmpdir } = await import('node:os');
	const workspace = await mkdtemp(joinPath(tmpdir(), 'memtree-empty-'));
	try {
		const plan = planAssets({ dshHome: joinPath('C:', 'home', '.dsh'), workspace });
		eq(plan.some((entry) => entry.to.startsWith('plugins/')), false, 'an empty workspace simply has nothing to find');
		eq(plan.some((entry) => entry.to === 'rules/AGENTS.md'), true, 'its rule file is still planned');
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
});

await test('a document in a real docs/ directory is discovered, not missed', async () => {
	const { mkdtemp, rm, mkdir, writeFile } = await import('node:fs/promises');
	const { tmpdir } = await import('node:os');
	const workspace = await mkdtemp(joinPath(tmpdir(), 'memtree-docs-'));
	try {
		// The cloud→local audit report was written into `docs/` and then never
		// appeared in the bundle, because every document before it had been listed
		// by hand at the workspace root. Discovery is the fix, so discovery is what
		// gets asserted — and the hand-listed design doc must survive alongside it.
		await mkdir(joinPath(workspace, 'docs'), { recursive: true });
		await writeFile(joinPath(workspace, 'docs', '本地风险排查-2026-09-16.md'), '# 报告\n', 'utf8');
		await writeFile(joinPath(workspace, '可行性判定.md'), '# 判定\n', 'utf8');
		const plan = planAssets({ dshHome: joinPath('C:', 'home', '.dsh'), workspace });
		eq(plan.some((entry) => entry.to === 'docs/本地风险排查-2026-09-16.md'), true, 'a file in docs/ is planned');
		eq(plan.some((entry) => entry.to === 'docs/可行性判定.md'), true, 'and the named root document is still planned');
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
});

await test('the backup stamp matches the tree naming style', () => {
	eq(stampOf(new Date(2026, 8, 13, 6, 49, 31)), '2026-09-13 06:49:31');
	eq(stampOf(new Date(2026, 0, 5, 9, 8, 7)), '2026-01-05 09:08:07', 'zero-padded');
});

// ── the day region is a log: it can only be added to ────────────────────────

await test('appending never rewrites what was already recorded', () => {
	let body = renderDaySummary([]);
	body = appendDayEntries(body, ['第一件事：插件立项'], { clock: '04:47' }).body;
	body = appendDayEntries(body, ['第二件事：开始写代码'], { clock: '05:10' }).body;
	body = appendDayEntries(body, ['第三件事：测试全绿'], { clock: '06:30' }).body;
	includes(body, '- **04:47** 第一件事：插件立项');
	includes(body, '- **05:10** 第二件事：开始写代码');
	includes(body, '- **06:30** 第三件事：测试全绿');
	eq(body.split('\n').filter((line) => line.startsWith('- **')).length, 3, 'one line per entry, none duplicated');
});

await test('the clock of an entry is the snapshot that recorded it, not the model', () => {
	const parsed = parseDaySummary(renderDaySummary([{ clock: '21:59', text: 'x' }]));
	eq(parsed.entries[0].clock, '21:59');
	// A model that helpfully prefixes its own clock must not create a second one.
	eq(entryText('- **04:47** 它自己写的时间'), '它自己写的时间');
	eq(entryText('**04:47** 没有前导横线'), '没有前导横线');
	eq(entryText('  多   空格  '), '多 空格');
	eq(entryText('- ' + 'x'.repeat(50), 20).length, 20, 'the cap counts the ellipsis');
});

await test('a duplicate entry is dropped instead of appended again', () => {
	// The one way an append-only log can still rot: a model that echoes the
	// recent entries it was shown. Nothing later could take the copy back out.
	let body = appendDayEntries(renderDaySummary([]), ['修好了定位 bug'], { clock: '04:47' }).body;
	const again = appendDayEntries(body, ['修好了定位 bug'], { clock: '05:10' });
	eq(again.added.length, 0, 'an exact repeat adds nothing');
	eq(again.body, body, 'and leaves the region byte-identical');
	const punctuated = appendDayEntries(body, ['修好了定位 bug。'], { clock: '05:10' });
	eq(punctuated.added.length, 0, 'punctuation alone does not make it a new event');
	const restated = appendDayEntries(body, ['修好了定位 bug，根因是 IDictionary 读不到键'], { clock: '05:10' });
	eq(restated.added.length, 1, 'a restatement that ADDS information is kept: over-dropping is the bug being fixed, not duplication');
	const shorter = appendDayEntries(
		appendDayEntries(renderDaySummary([]), ['修好了定位 bug，根因是 IDictionary 读不到键'], { clock: '04:47' }).body,
		['修好了定位 bug'],
		{ clock: '05:10' }
	);
	eq(shorter.added.length, 0, 'the same event written SHORTER is the model restating what is recorded');
	const genuine = appendDayEntries(body, ['接着补了回归测试'], { clock: '05:10' });
	eq(genuine.added.length, 1, 'a genuinely new event still lands');
});

await test('pre-log prose is migrated into a legacy block, not overwritten', () => {
	// This is exactly the shape the 2026-09-13 day file was in: a single blob
	// with no entry lines. The migration exists to protect that text.
	const old = ['## 当日摘要', '', '- 用户要求做电脑控制插件', '- 插件主体完成'].join('\n');
	const migrated = appendDayEntries(old, ['重启后实测通过'], { clock: '22:40', stamp: '2026-09-13 22:40:00' });
	eq(migrated.migrated, true, 'the migration is reported');
	includes(migrated.body, '- 用户要求做电脑控制插件', 'the old text is still there, verbatim');
	includes(migrated.body, '- 插件主体完成');
	includes(migrated.body, LEGACY_MARK, 'and is now behind the marker');
	includes(migrated.body, '停用', 'labelled as retired');
	includes(migrated.body, '- **22:40** 重启后实测通过', 'the new entry goes above it');
	excludes(migrated.body.split(LEGACY_MARK)[0], '用户要求做电脑控制插件', 'the old prose is not also left in the entry list');

	// A second append must not re-migrate, re-word the note, or touch the block.
	const second = appendDayEntries(migrated.body, ['又一条'], { clock: '23:00', stamp: '2026-09-13 23:00:00' });
	eq(second.migrated, false);
	eq(second.body.split(LEGACY_MARK).length - 1, 1, 'still exactly one legacy block');
	eq(second.body.split(LEGACY_MARK)[1], migrated.body.split(LEGACY_MARK)[1], 'and it is byte-identical');
	includes(second.body, '- **22:40** 重启后实测通过', 'earlier entries survive another append');
});

await test('appending to an already-migrated region keeps the entries above the block', () => {
	const migrated = appendDayEntries(
		['## 当日摘要', '', '旧正文'].join('\n'),
		['一条'],
		{ clock: '01:00', stamp: 's' }
	).body;
	const parsed = parseDaySummary(migrated);
	eq(parsed.entries.length, 1);
	includes(parsed.legacy, '旧正文');
	eq(parseDaySummary(appendDayEntries(migrated, ['二条'], { clock: '02:00' }).body).entries.length, 2);
});

await test('a run of identical failures collapses to one visible gap', () => {
	// A failure notice is just another entry now, so the dedup guard is what
	// keeps a failing model from filling the day with copies of the same line.
	const notice = '⚠️ 本次快照（pressure）的事件条目生成失败：`stream finished with max-tokens`。';
	let body = appendDayEntries(renderDaySummary([]), [notice], { clock: '07:20' }).body;
	body = appendDayEntries(body, [notice], { clock: '07:21' }).body;
	body = appendDayEntries(body, [notice], { clock: '07:22' }).body;
	eq(body.split('生成失败').length - 1, 1, 'one gap is recorded, not three');
});

await test('the cap on entries per snapshot is enforced by the caller, and the log keeps the rest', () => {
	// `appendDayEntries` is deliberately uncapped: the bound belongs to the
	// pipeline so that an over-eager model costs no recorded history.
	const many = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'].map((text) => `条目 ${text}`);
	const body = appendDayEntries(renderDaySummary([]), many.slice(0, 4), { clock: '08:00' }).body;
	eq(parseDaySummary(body).entries.length, 4, 'the pipeline passes at most dayEntryMax');
});

await test('an imported entry keeps its own clock instead of taking the import time', () => {
	// Entries arriving from ANOTHER instance's tree were written there at a known
	// time (the cloud/QQ tree being imported into the canonical local one).
	// Re-stamping them with the importing process's clock would silently move a
	// recorded event to the import time, which is exactly the kind of quiet loss
	// the append-only log exists to prevent.
	const first = appendDayEntries(renderDaySummary([]), [{ clock: '18:14', text: '云端快照跑通' }], { clock: '23:59' });
	eq(first.added.length, 1);
	eq(first.added[0].clock, '18:14', 'the carried clock wins over options.clock');
	includes(first.body, '- **18:14** 云端快照跑通');
	excludes(first.body, '23:59', 'the import time is not stamped onto it');
	let body = first.body;

	// A plain string still takes the snapshot clock: the model path is unchanged.
	const model = appendDayEntries(body, ['本地新事件'], { clock: '23:59' });
	eq(model.added.length, 1);
	eq(model.added[0].clock, '23:59', 'plain text keeps using options.clock');
	includes(model.body, '- **23:59** 本地新事件');
	body = model.body;

	// The dedup guard applies to carried entries too, which is what makes a
	// re-import idempotent rather than doubling the log on every sync.
	const again = appendDayEntries(body, [{ clock: '19:00', text: '云端快照跑通' }], { clock: '09:00' });
	eq(again.added.length, 0, 'a re-import adds nothing');
	eq(again.body, body, 'and leaves the region byte-identical');

	// An object without a usable clock is not a way to lose the clock: it falls back.
	const fallback = appendDayEntries(body, [{ text: '无时刻的导入条目' }], { clock: '10:00' });
	eq(fallback.added.length, 1);
	eq(fallback.added[0].clock, '10:00', 'no carried clock ⇒ the caller clock');
	eq(appendDayEntries(body, [{ clock: '   ', text: '空白时刻' }], { clock: '10:00' }).added[0].clock, '10:00', 'a blank clock is no clock');
});

// ── redaction (the write boundary) ──────────────────────────────────────────

/**
 * A routable-looking address, assembled at runtime.
 *
 * Deliberately NOT a literal: this file is copied into the recovery bundle that
 * lives inside the tree, and the tree's own rule is that a public address must
 * not be in there. A literal fixture would be neutralised by the very scrubber
 * under test, and the bundled copy would then assert the wrong thing.
 * @param {number} a - first octet.
 * @param {number} b - second octet.
 * @param {number} c - third octet.
 * @param {number} d - fourth octet.
 * @returns {string} the dotted form.
 */
const publicIp = (a, b, c, d) => [a, b, c, d].join('.');

await test('redact: a 32-hex openid/peerId is masked, while longer or shorter hex is left alone', () => {
	const id = 'A1'.repeat(16);
	const scrubbed = scrubText(`peerId=${id} 之后`);
	eq(scrubbed.counts.id, 1, 'the 32-hex run is caught');
	includes(scrubbed.text, '[REDACTED]');
	excludes(scrubbed.text, id, 'the literal itself is gone');
	// A sha256 digest is hex too. Only a *boundary-delimited* 32-run counts, so a
	// 64-hex digest and the 8-hex session token in snapshot names both survive —
	// masking those would break the tree's own cross-references.
	eq(countSensitive('f'.repeat(64)).total, 0, 'a 64-hex digest is not a 32-hex id');
	eq(countSensitive('deadbeef').total, 0, 'an 8-hex session token is not an id');
});

await test('redact: routable IPv4 is masked while loopback, wildcard and private ranges survive', () => {
	const text = `public ${publicIp(203, 0, 113, 9)} | loopback 127.0.0.1 | wildcard 0.0.0.0 | lan 192.168.10.20 | nic 10.44.0.7`;
	const scrubbed = scrubText(text);
	eq(scrubbed.counts.ip, 1, 'exactly the routable one');
	includes(scrubbed.text, '[REDACTED-IP]');
	// These four are deliberately kept: loopback and the private ranges carry
	// meaning inside a tree and none of them is reachable from outside.
	for (const kept of ['127.0.0.1', '0.0.0.0', '192.168.10.20', '10.44.0.7']) includes(scrubbed.text, kept, `${kept} must survive`);
});

await test('redact: versions and times are never mistaken for addresses', () => {
	// The one shape that could collide with an IPv4 is four numeric groups. A false
	// positive here silently corrupts a permanent archive, so pin the shapes this
	// tree actually contains.
	for (const text of ['dsh 0.1.5-rc.2', 'pnpm 11.8.0', 'node 24.18.1', 'Desktop 2.0.10', '2026-09-15 15:07:44', 'v1.0.0']) {
		eq(countSensitive(text).total, 0, `${text} must survive untouched`);
	}
});

await test('redact: the sk- key shape is masked, and a short sk- word is not', () => {
	const key = `sk-${'a1B2'.repeat(5)}`;
	const scrubbed = scrubText(`DEEPSEEK_API_KEY=${key}`);
	eq(scrubbed.counts.key, 1, 'the key shape is caught');
	excludes(scrubbed.text, key, 'the key itself is gone');
	includes(scrubbed.text, '[REDACTED-KEY]');
	eq(countSensitive('sk-short').total, 0, 'a 5-char sk- word is not a key');
});

await test('redact: scrubVerified proves the change is limited to the replacements', () => {
	const id = 'C'.repeat(32);
	const text = `line one ${id}\nline two ${publicIp(198, 51, 100, 7)}\n`;
	const scrubbed = scrubVerified(text, 'unit-test');
	eq(scrubbed.counts.total, 2, 'both classes were found');
	eq(scrubbed.text.split('\n').length, text.split('\n').length, 'no line was added or removed');
	// The byte delta is a real check, not a restatement: it fails if any byte other
	// than a replaced span moved.
	eq(scrubbed.delta, Buffer.byteLength(scrubbed.text, 'utf8') - Buffer.byteLength(text, 'utf8'), 'the reported delta equals the actual byte change');
	// Clean text is a no-op, not an error — the writer calls this on every write.
	eq(scrubVerified('nothing sensitive here', 'unit-test').counts.total, 0);
});

await test('redact: isScrubbablePath separates text assets from binaries', () => {
	ok(isScrubbablePath('lib\\index.js'), 'js is text');
	ok(isScrubbablePath('rules/PITFALLS.md'), 'md is text');
	ok(isScrubbablePath('_scripts\\deploy\\82-set-real-peerid.sh'), 'a shell script is text');
	ok(isScrubbablePath('pnpm-lock.yaml'), 'yaml is text');
	eq(isScrubbablePath('media/2026-09-15T004753-deadbeef.png'), false, 'an image must stay byte-for-byte');
	eq(isScrubbablePath('koffi/build/Release/koffi.node'), false, 'a native module is not text');
});

// ── seq-space change (DSH 2.0.10's session.v3 log) ──────────────────────────

await test('parseStamp reads the tree\'s own stamp shape, offset included', () => {
	// The tree writes `2026-09-15 00:52:06 +08:00`. V8 is not required to accept that
	// space-separated form with a trailing offset, and a silent NaN here would read
	// exactly like "nothing new happened" — so it is parsed by hand and pinned here.
	const epoch = parseStamp('2026-09-15 00:52:06 +08:00');
	eq(epoch, Date.UTC(2026, 8, 14, 16, 52, 6), '+08:00 means 16:52:06Z the day before');
	eq(parseStamp('2026-09-15T00:52:06Z'), Date.UTC(2026, 8, 15, 0, 52, 6), 'the ISO form is accepted too');
	eq(parseStamp('2026-09-15 00:52:06 -05:00'), Date.UTC(2026, 8, 15, 5, 52, 6), 'a negative offset shifts forward');
	eq(parseStamp('nonsense'), undefined, 'an unrecognised shape is undefined, never NaN');
	eq(parseStamp(undefined), undefined);
});

await test('firstSeqAfter finds the first event strictly after a moment', () => {
	const base = Date.UTC(2026, 8, 15, 0, 0, 0);
	const events = [
		{ seq: 5, time: base - 1000 },
		{ seq: 9, time: base },
		{ seq: 3, time: base + 1000 },
		{ seq: 7, time: base + 2000 }
	];
	// Strictly after: the event exactly AT the boundary belongs to the covered side.
	eq(firstSeqAfter(events, base), 3, 'the lowest seq that is newer wins, not the first seen');
	eq(firstSeqAfter(events, base + 5000), undefined, 'nothing newer ⇒ undefined');
	eq(firstSeqAfter(events, undefined), undefined, 'an unknown boundary matches nothing');
	eq(firstSeqAfter([], base), undefined);
});

report();
