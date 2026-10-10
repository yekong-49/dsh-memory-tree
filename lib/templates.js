/**
 * File templates and roll-up table rendering.
 *
 * Design invariant: every table inside a `MACHINE ROLLUP` region is a pure
 * function of the tree itself —
 *
 *   * counts (月数 / 天数 / 快照数) come from the filesystem,
 *   * each row's 一句话 is the child node's own `summary:` front-matter field,
 *   * 入口 is the child's relative path.
 *
 * Only the `summary:` values need a model. That keeps roll-ups idempotent and
 * self-healing: recomputing them can never duplicate accounting, and a row
 * lost to a crash comes back on the next snapshot.
 */

import { pad } from './paths.js';

/** Region that holds recomputable tables. */
export const ROLLUP_REGION = 'MACHINE ROLLUP';

/** Region that holds the append-only per-turn log. */
export const TURNLOG_REGION = 'TURN LOG';

/**
 * Region that holds the day's event list.
 *
 * Separate from `MACHINE ROLLUP` because the two have different sources: the
 * roll-up is recomputed from the filesystem and must be byte-stable, while this
 * comes from the model and would be destroyed by a recompute.
 *
 * **Append-only, and that is the whole point.** This region used to hold one
 * prose blob that every snapshot REPLACED with the model's newest answer. The
 * model was told to prioritise the latest progress, so it did: a day that began
 * by building a plugin came to be described by its last hour alone, and the
 * beginning was gone — not compressed, gone. The entries are therefore never
 * rewritten; every snapshot may only add. Nothing the model says later can
 * erase what an earlier snapshot recorded.
 */
export const DAY_SUMMARY_REGION = 'DAY SUMMARY';

/**
 * Marker separating the append-only entries from a pre-log summary.
 *
 * Day files written before the region became a log hold a single prose blob
 * with no entry lines in it. On the first append that text is moved below this
 * marker verbatim instead of being discarded — a migration that loses the very
 * history the migration exists to protect would be worse than no migration.
 */
export const LEGACY_MARK = '<!-- legacy-summary:begin -->';

/** Standing note at the top of the region, explaining the contract to a reader. */
export const DAY_SUMMARY_INTRO = [
	'> 逐条追加：**一条一个主要事件 / 任务 / 结论**，时刻是该条快照的时间。',
	'> 已写下的条目**永不被改写**，所以这一区块不会丢掉当天早期的内容。'
].join('\n');

/** The intro as a set, for the parser to skip. */
const INTRO_LINES = new Set(DAY_SUMMARY_INTRO.split('\n'));

/** Matches one entry line, capturing its clock and text. */
const DAY_ENTRY_RE = /^-\s+\*\*(\d{2}:\d{2})\*\*\s*(.*)$/;

/** Matches the region's own heading, so a migration does not keep a stale copy. */
const DAY_HEADING_RE = /^##\s*当日摘要\s*$/;

/**
 * Region that holds the day's archived-image index.
 *
 * Derived from the `media/` directory rather than stored, so it is recomputable
 * and self-healing exactly like `MACHINE ROLLUP` — and kept as its own region
 * so an unreadable media directory can never damage the snapshot index.
 */
export const MEDIA_REGION = 'MEDIA';

/** Placeholder text used by freshly created files. */
export const PLACEHOLDER = '（待首次快照后填写）';

/** Cells that mean "no data yet", dropped once real rows exist. */
export const PLACEHOLDER_ROW = /（暂无|（待首次快照后填写）/;

/**
 * Make arbitrary text safe inside one Markdown table cell.
 * @param {unknown} value - the raw value.
 * @param {number} [limit] - maximum length before eliding.
 * @returns {string} a single-line, pipe-escaped cell.
 */
export function cell(value, limit = 160) {
	let text = value === undefined || value === null ? '' : String(value);
	text = text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
	if (text.length === 0) return '—';
	if (text.length > limit) text = `${text.slice(0, limit - 1)}…`;
	return text;
}

/**
 * Render a Markdown table.
 * @param {string[]} headers - column headers.
 * @param {Array<Array<unknown>>} rows - row cells (already-rendered strings or raw values).
 * @returns {string} the table text.
 */
export function table(headers, rows) {
	const lines = [`| ${headers.join(' | ')} |`, `|${headers.map(() => '---').join('|')}|`];
	for (const row of rows) lines.push(`| ${row.map((value) => (typeof value === 'string' ? value : cell(value))).join(' | ')} |`);
	return lines.join('\n');
}

/**
 * The `longterm.md` template — one row per year.
 * @param {string} stamp - creation stamp, `yyyy-mm-dd HH:MM:SS +08:00`.
 * @returns {string} the file body.
 */
export function longtermTemplate(stamp) {
	return `---
kind: memory-longterm
schema: 1
created: ${stamp}
updated: ${stamp}
summary: ${PLACEHOLDER}
---

# 长期记忆摘要（最高层）

> 本文件是这棵树的**最高层摘要**：**一年一行**，概括该年的内容。
> 这是逐级下钻的第一步——先在这里定位到哪一年，再进年 → 月 → 日 → 快照。
> 本文件与年/月/日各层一起，**在每次存储（快照）时自动更新**。

<!-- BEGIN MACHINE ROLLUP -->
${table(['年', '一句话', '月数', '快照数'], [['2026', PLACEHOLDER, '1', '0']])}
<!-- END MACHINE ROLLUP -->

> 本树从 **2026-09-13** 开始记。更早的时间不在树内。
> 更高层（跨年趋势、长期主题）可以由人来补充——写在机器区之外即可，插件不会触碰。
`;
}

/**
 * The `<yyyy>/<yyyy>.md` template — one row per month of that year.
 * @param {{year: string, dateText: string, stamp: string, previousYear: string|undefined}} input - template inputs.
 * @returns {string} the file body.
 */
export function yearTemplate({ year, dateText, stamp, previousYear }) {
	const previousNote = previousYear === undefined
		? `> 本树从 **${dateText}** 开始记，这是树里的第一年。`
		: `> 上一层：[${previousYear} 年](../${previousYear}/${previousYear}.md)　|　本树从 2026-09-13 开始记。`;
	return `---
kind: memory-year
year: ${year}
from: ${dateText}
updated: ${stamp}
summary: ${PLACEHOLDER}
---

# ${year} 年 · 月级摘要

> 上一层：[长期摘要](../longterm.md)　|　下一层：本月 → \`<月>/${year}-<月>.md\`
> 本文件是**该年各月的摘要**，在每次存储时与其余各级一起更新。

<!-- BEGIN MACHINE ROLLUP -->
${table(['月', '一句话', '天数', '快照数', '入口'], [[dateText.slice(5, 7), PLACEHOLDER, '1', '0', `${dateText.slice(5, 7)}/${year}-${dateText.slice(5, 7)}.md`]])}
<!-- END MACHINE ROLLUP -->

${previousNote}
> 更早或更晚的月份在**该月首次写入**时才创建目录与月表（惰性创建，见 \`index.md\`）。
`;
}

/**
 * The `<yyyy>/<mm>/<yyyy>-<mm>.md` template — one block per day of that month.
 * @param {{year: string, month: string, dateText: string, stamp: string}} input - template inputs.
 * @returns {string} the file body.
 */
export function monthTemplate({ year, month, dateText, stamp }) {
	const day = dateText.slice(8, 10);
	return `---
kind: memory-month
year: ${year}
month: ${month}
from: ${dateText}
updated: ${stamp}
summary: ${PLACEHOLDER}
---

# ${year}-${month} · 每日关键事件

> 上一层：[${year} 年](../${year}.md)　|　下一层：本日 → \`<日>/${year}-${month}-<日>.md\`
> 本文件**按天分条列出当天的重要事件**（每一条来自那一天自己的只追加条目），在每次存储时与其余各级一起更新。
> 想读某一天的完整过程就点该天的日文件链接；想看本月整体发生了什么，读本文件自己的 \`summary:\`。

<!-- BEGIN MACHINE ROLLUP -->
${renderMonth([{ day, date: dateText, snapshots: 0, entry: `${day}/${year}-${month}-${day}.md`, entries: [] }])}
<!-- END MACHINE ROLLUP -->

> 本树只记 **2026-09-13 及之后**；更早的日期不创建。
> 没有内容的日期**不预建目录**——该日首次写入时才生成。
`;
}

/**
 * The `<yyyy>/<mm>/<dd>/<yyyy>-<mm>-<dd>.md` template.
 *
 * Three regions with three different contracts: prose replaced on each
 * snapshot, an index recomputed from the snapshot files, and an append-only
 * per-turn log.
 * @param {{dateText: string, stamp: string, monthEntry: string}} input - template inputs.
 * @returns {string} the file body.
 */
export function dayTemplate({ dateText, stamp, monthEntry }) {
	return `---
kind: memory-day
date: ${dateText}
updated: ${stamp}
summary: ${PLACEHOLDER}
---

# ${dateText} · 当日摘要 + 快照索引 + 机械流水

> 上一层：[${dateText.slice(0, 7)}](${monthEntry})

<!-- BEGIN DAY SUMMARY -->
${renderDaySummary([])}
<!-- END DAY SUMMARY -->

<!-- BEGIN MACHINE ROLLUP -->
## 快照索引

${table(['时间', '触发', '会话', '覆盖区间', '一句话', '文件'], [['—', '—', '—', '—', '（暂无快照）', '—']])}
<!-- END MACHINE ROLLUP -->

<!-- BEGIN TURN LOG -->
### 机械流水（每轮一行，只追加）

${table(['时间', '轮次', 'Δtoken', '改动的文件', '一句话'], [])}
<!-- END TURN LOG -->

<!-- BEGIN MEDIA -->
${renderMedia([])}
<!-- END MEDIA -->

> 当日摘要**按事件逐条追加、永不改写**（一条一个主要事件）；快照索引与图片归档由磁盘推出（可安全重算）；
> 机械流水只追加。四个机器区块之外的手写内容插件永不触碰。
`;
}

/**
 * Human-readable byte size.
 * @param {number} bytes - the size.
 * @returns {string} e.g. `5.9 MB`.
 */
export function formatBytes(bytes) {
	if (!Number.isFinite(bytes) || bytes < 0) return '—';
	if (bytes < 1024) return `${bytes} B`;
	const units = ['KB', 'MB', 'GB', 'TB'];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * The clock portion of an archive file name.
 * @param {string} file - e.g. `2026-09-13T055105-T42-deadbeef-a1b2c3d4.png`.
 * @returns {string} `05:51:05`, or `—` when the name does not carry one.
 */
export function clockOfMedia(file) {
	const match = /T(\d{2})(\d{2})(\d{2})/.exec(String(file));
	return match === null ? '—' : `${match[1]}:${match[2]}:${match[3]}`;
}

/**
 * Render the day's archived-image index.
 *
 * Rows link the file instead of embedding it: the day file stays readable as
 * plain text, and the images are one click away rather than dragging megabytes
 * of base64 into every read of the node.
 * @param {Array<{file: string, bytes: number, turn?: number, sessionToken?: string}>} entries - the archive listing.
 * @returns {string} the region content.
 */
export function renderMedia(entries) {
	if (!Array.isArray(entries) || entries.length === 0) {
		return ['### 图片归档（本日）', '', '（本日还没有归档图片）'].join('\n');
	}
	const rows = entries.map((entry) => [
		clockOfMedia(entry.file),
		entry.turn === undefined ? '—' : `T${entry.turn}`,
		entry.sessionToken ?? '—',
		formatBytes(entry.bytes),
		`[${entry.file}](media/${entry.file})`
	]);
	return ['### 图片归档（本日）', '', table(['时间', '轮次', '会话', '大小', '文件'], rows)].join('\n');
}

/**
 * Render the `longterm.md` roll-up region.
 * @param {Array<{year: string, summary: string, months: number, snapshots: number}>} rows - one per year.
 * @returns {string} the region content.
 */
export function renderLongterm(rows) {
	return table(
		['年', '一句话', '月数', '快照数'],
		rows.map((row) => [row.year, cell(row.summary), String(row.months), String(row.snapshots)])
	);
}

/**
 * Render a year file's roll-up region.
 * @param {Array<{month: string, summary: string, days: number, snapshots: number, entry: string}>} rows - one per month.
 * @returns {string} the region content.
 */
export function renderYear(rows) {
	return table(
		['月', '一句话', '天数', '快照数', '入口'],
		rows.map((row) => [row.month, cell(row.summary), String(row.days), String(row.snapshots), row.entry])
	);
}

/**
 * Render a month file's roll-up region: one block per day, holding that day's
 * own event entries.
 *
 * Not a table, and not one line per day. A single index line could NAME a day
 * but not let you READ it: drilling long-term → year → month landed on a line
 * that described only the newest thing that had happened, so a day that began by
 * building a plugin looked like a day that consisted of whatever was going on at
 * the end of it. The entries below are the child's own, reproduced verbatim —
 * still recomputed from the day file on every pass like every other row, so the
 * region stays a pure function of the tree and a lost month file heals on the
 * next snapshot.
 *
 * Costs tokens that a one-line table did not. That is the trade: the point of
 * drilling to this level is to find out what a day contained, and a level that
 * cannot answer that is not a level, it is a signpost.
 * @param {Array<{day: string, date: string, summary: string, snapshots: number, entry: string, entries?: Array<{clock: string, text: string, line?: string}>}>} rows - one per day.
 * @returns {string} the region content.
 */
export function renderMonth(rows) {
	if (!Array.isArray(rows) || rows.length === 0) return PLACEHOLDER;
	return rows.map((row) => {
		const lines = (Array.isArray(row.entries) ? row.entries : [])
			.map((entry) => (typeof entry.line === 'string' && entry.line.length > 0 ? entry.line : dayEntryLine(entry.clock, entry.text)))
			.filter((line) => line.length > 0);
		return [
			`### ${row.day} 日 · ${row.date ?? row.day}`,
			'',
			`> ${row.snapshots} 份快照　|　[日文件](${row.entry})`,
			'',
			lines.length === 0 ? '（这一天还没有关键事件条目）' : lines.join('\n')
		].join('\n');
	}).join('\n\n');
}

/**
 * Render a day file's roll-up region: the snapshot index.
 *
 * Derived from the snapshot files themselves, so recomputing after a crash
 * restores a lost row instead of dropping it.
 * @param {Array<{time: string, trigger: string, session: string, range: string, summary: string, file: string}>} snapshots - snapshots in time order.
 * @returns {string} the region content.
 */
export function renderSnapshotIndex(snapshots) {
	const indexRows = snapshots.length === 0
		? [['—', '—', '—', '—', '（暂无快照）', '—']]
		: snapshots.map((snapshot) => [
			snapshot.time,
			snapshot.trigger,
			snapshot.session,
			snapshot.range,
			cell(snapshot.summary, 120),
			`[${snapshot.file}](${encodeURI(snapshot.file)})`
		]);
	return ['## 快照索引', '', table(['时间', '触发', '会话', '覆盖区间', '一句话', '文件'], indexRows)].join('\n');
}

/**
 * Render the day's event list from its parts.
 *
 * Pure, and the inverse of `parseDaySummary`: every rewrite of the region goes
 * through this pair, so an append can never lose an entry or a legacy block.
 * @param {Array<{clock: string, text: string}|string>} [entries] - entry records, or ready-made lines.
 * @param {string} [legacy] - pre-log prose, kept verbatim below `LEGACY_MARK`.
 * @returns {string} the region content.
 */
export function renderDaySummary(entries = [], legacy) {
	const lines = (Array.isArray(entries) ? entries : [])
		.map((entry) => (typeof entry === 'string' ? entry.trim() : dayEntryLine(entry.clock, entry.text)))
		.filter((line) => line.length > 0);
	const parts = ['## 当日摘要', '', DAY_SUMMARY_INTRO, '', lines.length === 0 ? PLACEHOLDER : lines.join('\n')];
	const kept = typeof legacy === 'string' ? legacy.trim() : '';
	if (kept.length > 0) parts.push('', LEGACY_MARK, kept);
	return parts.join('\n');
}

/**
 * Render one entry line.
 * @param {string} clock - `HH:MM`, the time of the snapshot that recorded it.
 * @param {string} text - the entry text.
 * @returns {string} the Markdown line.
 */
export function dayEntryLine(clock, text) {
	return `- **${clock}** ${String(text ?? '').trim()}`;
}

/**
 * Take the region body apart into entries and a legacy block.
 *
 * `residue` is whatever is neither: it is how a pre-log day file is recognized,
 * because such a body carries prose but no entry lines.
 * @param {string} body - the region's inner text.
 * @returns {{entries: Array<{clock: string, text: string, line: string}>, legacy: string|undefined, residue: string}} the parts.
 */
export function parseDaySummary(body) {
	const text = String(body ?? '').replace(/\r\n/g, '\n');
	const marker = text.indexOf(LEGACY_MARK);
	const head = marker === -1 ? text : text.slice(0, marker);
	const tail = marker === -1 ? undefined : text.slice(marker + LEGACY_MARK.length).replace(/^\n+/, '').replace(/\s+$/, '');
	const entries = [];
	const leftovers = [];
	for (const raw of head.split('\n')) {
		const line = raw.trim();
		if (line.length === 0) continue;
		const match = DAY_ENTRY_RE.exec(line);
		if (match !== null) {
			entries.push({ clock: match[1], text: match[2].trim(), line });
			continue;
		}
		if (DAY_HEADING_RE.test(line) || INTRO_LINES.has(line) || line === PLACEHOLDER) continue;
		leftovers.push(line);
	}
	return { entries, legacy: tail, residue: leftovers.join('\n') };
}

/**
 * Append entries to a day-summary region body.
 *
 * The ONLY mutating operation allowed on this region, and it can only ever add:
 * existing entries are re-emitted straight from the parse, and a body that
 * predates the log is demoted into the legacy block rather than overwritten.
 *
 * Duplicate suppression is not politeness, it is the guard against the one way
 * an append-only log can still rot. The model is shown the recent entries so it
 * can avoid repeating itself, but a model that echoes them anyway would
 * otherwise append a copy on every single snapshot — and nothing later could
 * take it back out.
 * @param {string} body - the current region body.
 * @param {Array<string|{clock?: string, text: string}>} incoming - candidate entries from the model
 *   (plain text, stamped with `options.clock`) or from another instance's tree (an object carrying its
 *   own `clock`, which is preserved — see below).
 * @param {{clock: string, stamp?: string, maxChars?: number}} options - the snapshot's clock and limits.
 * @returns {{body: string, entries: Array<{clock: string, text: string}>, added: Array<{clock: string, text: string}>, migrated: boolean}} the new body and what changed.
 */
export function appendDayEntries(body, incoming, options = {}) {
	const clock = String(options.clock ?? '').trim();
	const maxChars = Number.isFinite(options.maxChars) && options.maxChars > 0 ? Math.floor(options.maxChars) : 400;
	const parsed = parseDaySummary(body);
	const migrated = parsed.legacy === undefined && parsed.residue.length > 0;
	const legacy = parsed.legacy ?? (migrated
		? [`（旧版「整体改写式」摘要，${options.stamp ?? clock} 停用；原文原样保留，不再更新）`, '', parsed.residue].join('\n')
		: undefined);
	const seen = new Set(parsed.entries.map((entry) => normalizeEntry(entry.text)));
	const added = [];
	for (const raw of Array.isArray(incoming) ? incoming : []) {
		// An entry may carry its OWN clock. That happens when the entries come from a
		// different instance's tree (importing a cloud/QQ turn into the canonical tree):
		// there the clock is the moment the event was actually recorded, and re-stamping
		// it with `options.clock` would silently move a recorded event to the import time.
		// A model-supplied entry is plain text and takes the snapshot's clock as before.
		const carried = raw !== null && typeof raw === 'object' ? raw : undefined;
		const entryClock = typeof carried?.clock === 'string' && carried.clock.trim().length > 0 ? carried.clock.trim() : clock;
		const text = entryText(carried ? carried.text : raw, maxChars);
		if (text.length === 0) continue;
		const key = normalizeEntry(text);
		if (key.length === 0 || seen.has(key)) continue;
		// A new entry that an existing one already covers is the model restating
		// what is recorded, not a new event. Two shapes of that are caught: the
		// same event written SHORTER (a prefix, since the model tends to drop the
		// detail rather than reorder it), and a short entry wholly contained in a
		// longer one. A restatement that ADDS information is kept on purpose —
		// dropping a real event is the failure this log exists to prevent, so the
		// guard errs toward keeping.
		if (parsed.entries.some((entry) => {
			const existing = normalizeEntry(entry.text);
			if (existing === key) return true;
			if (key.length >= 16 && existing.includes(key)) return true;
			return key.length >= 6 && existing.startsWith(key);
		})) continue;
		seen.add(key);
		added.push({ clock: entryClock, text });
	}
	const entries = [...parsed.entries.map((entry) => ({ clock: entry.clock, text: entry.text })), ...added];
	return { body: renderDaySummary(entries, legacy), entries, added, migrated };
}

/**
 * Reduce a model-produced line to one clean entry text.
 * @param {unknown} raw - the candidate line.
 * @param {number} [maxChars] - per-entry cap.
 * @returns {string} the text, or an empty string when nothing usable is left.
 */
export function entryText(raw, maxChars = 400) {
	let text = String(raw ?? '')
		.replace(/\r?\n/g, ' ')
		.replace(/^\s*[-*+]\s+/, '')
		.replace(/^\*\*\d{2}:\d{2}\*\*\s*/, '')
		.replace(/\s+/g, ' ')
		.trim();
	if (text.length > maxChars) text = `${text.slice(0, Math.max(0, maxChars - 1))}…`;
	return text;
}

/**
 * Normalize an entry for duplicate comparison.
 * @param {string} text - the entry text.
 * @returns {string} the text with whitespace, punctuation and symbols removed.
 */
function normalizeEntry(text) {
	return String(text ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

/**
 * Render the YAML header of a snapshot file.
 * @param {{dateText: string, stamp: string, trigger: string, sessionId: string, cwd: string, provider: string, model: string, fromSeq: number, toSeq: number, contextTokens: number, summary: string, truncated: boolean, bytes: number}} input - snapshot metadata.
 * @returns {string} the header text.
 */
export function snapshotHeader(input) {
	const lines = [
		'---',
		'kind: memory-snapshot',
		'schema: 1',
		`date: ${input.dateText}`,
		`time: ${input.stamp}`,
		`trigger: ${input.trigger}`,
		`session: ${input.sessionId}`,
		`cwd: ${escapeScalar(input.cwd)}`,
		`route: ${escapeScalar(`${input.provider}/${input.model}`)}`,
		`fromSeq: ${input.fromSeq}`,
		`toSeq: ${input.toSeq}`,
		`contextTokens: ${input.contextTokens}`,
		`bytes: ${input.bytes}`,
		`truncated: ${input.truncated ? 'true' : 'false'}`,
		`summary: ${escapeScalar(input.summary)}`,
		'---'
	];
	return lines.join('\n');
}

/**
 * Quote a scalar for the snapshot header when it could confuse a reader.
 * @param {string} value - raw value.
 * @returns {string} the serialized scalar.
 */
function escapeScalar(value) {
	const text = String(value ?? '').replace(/\r?\n/g, ' ');
	if (text === '' || /[:#"]/.test(text) || text !== text.trim()) {
		return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
	}
	return text;
}

/**
 * Compose a complete snapshot document.
 * @param {{header: string, body: string}} input - header and verbatim body.
 * @returns {string} the snapshot file text.
 */
export function snapshotDocument({ header, body }) {
	const text = body.replace(/\r\n/g, '\n').replace(/^\n+|\n+$/g, '');
	return `${header}\n\n# 逐字原文切片\n\n${text.length === 0 ? '（本次区间没有可记录的文本）' : text}\n`;
}

/**
 * Render a `yyyy-mm` label from a `yyyy-mm-dd` date.
 * @param {string} dateText - the full date.
 * @returns {string} the month label.
 */
export function monthOf(dateText) {
	return dateText.slice(0, 7);
}

/**
 * Render an `HH:MM:SS` clock label with a `T`-separated name prefix.
 * @param {string} stamp - `yyyy-mm-dd HH:MM:SS +08:00`.
 * @returns {string} the clock portion.
 */
export function clockOf(stamp) {
	const match = /\d{4}-\d{2}-\d{2} (\d{2}:\d{2}:\d{2})/.exec(stamp);
	return match === null ? stamp : match[1];
}

/**
 * Render a day number with leading zeros.
 * @param {string} dateText - the full date.
 * @returns {string} the zero-padded day.
 */
export function dayOf(dateText) {
	return pad(Number(dateText.slice(8, 10)));
}
