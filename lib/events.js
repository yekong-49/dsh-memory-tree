/**
 * Session-event projection: turning the durable event log into text and into
 * per-turn slices, mechanically and with zero model calls.
 *
 * Every function here is pure — it takes the frozen event array that
 * `session.snapshotEvents()` returns and produces plain data. That keeps the
 * per-turn accounting testable without a running harness, and it keeps the
 * cost of "record one line per turn" at O(events in that turn).
 *
 * Event shapes (from the session event map):
 *   user/message      data = UserMessage                      (data IS the message)
 *   assistant/message data = {turn, step, message, usage?}
 *   tool/call         data = {turn, step, callId, name, arguments}
 *   tool/result       data = {turn, step, message, error?}
 */

/** Tools whose successful call counts as "a file this turn touched". */
export const FILE_TOOLS = Object.freeze(new Set(['write', 'edit', 'notebook_edit', 'apply_patch']));

/** Text-bearing part types that carry literal content. */
const TEXT_PART_TYPES = Object.freeze(new Set(['text', 'input_text', 'output_text']));

/**
 * Extract the concatenated text of one message's content.
 * @param {unknown} message - a message-shaped value (`{content}`).
 * @returns {string} the joined text, or an empty string.
 */
/**
 * A stable one-line reference for one image attachment.
 *
 * An `ImageBlock` is `{ type: 'image', attachment }` and carries no text of its
 * own, but it is not nothing: recording the attachment id is what lets a
 * snapshot say an image existed, and lets the media archive find it later.
 * @param {any} attachment - the `ImageAttachmentRef`.
 * @returns {string} e.g. `[图片 sha256:1a2b3c4d · 2560x1440 · image/png]`.
 */
export function imageRefText(attachment) {
	if (attachment === null || typeof attachment !== 'object') return '[图片（无引用信息）]'
	const id = String(attachment.attachmentId ?? 'unknown')
	const short = id.startsWith('sha256:') ? `sha256:${id.slice('sha256:'.length, 'sha256:'.length + 8)}` : id
	const size = Number.isFinite(attachment.width) && Number.isFinite(attachment.height)
		? `${attachment.width}x${attachment.height}`
		: '尺寸未知'
	return `[图片 ${short} · ${size} · ${attachment.mediaType ?? '类型未知'}]`
}

/**
 * Collect every image attachment one projected record mentions.
 *
 * Walks the same nesting as `textOfBlocks`: a screenshot arrives as an
 * `ImageBlock` inside a `tool-result` block's `content`, so a shallow scan
 * would find nothing and the archive would silently stay empty.
 * @param {{message?: any, data?: any}} record - a projected record.
 * @returns {any[]} the image attachment references, in order.
 */
export function imagesIn(record) {
	const found = [];
	walkBlocks(record?.message?.content, found);
	// `user/message` stores the message itself in `data`, so a human-pasted
	// image is reached through a different door than a tool result.
	walkBlocks(record?.data?.content, found);
	return found;
}

/**
 * Push every image attachment found in a block list, descending into tool results.
 * @param {any} content - the block list.
 * @param {any[]} found - the accumulator.
 * @returns {void}
 */
function walkBlocks(content, found) {
	if (!Array.isArray(content)) return;
	for (const part of content) {
		if (part === null || typeof part !== 'object') continue;
		if (part.type === 'image' && part.attachment !== undefined) found.push(part.attachment);
		else if (part.type === 'tool-result') walkBlocks(part.content, found);
	}
}

/**
 * Join the text of one content block list, descending into nested tool results.
 *
 * The nesting is the whole point. `createToolResultMessage` builds
 * `{ type: 'tool-result', toolCallId, content, isError }` — the real content
 * lives in the NESTED `content`, and the outer block has no `.text` at all, so
 * reading only top-level `.text` silently dropped EVERY tool output the tree
 * ever recorded. Measured on the first two snapshots: 519 of 519 tool results
 * were stored as an empty result. DSH walks this same nesting for its own image
 * policy (`contentHasImage` in `dsh-llm`), so the shape is not a guess.
 * @param {any} content - a message's content: a string, or a block array.
 * @returns {string} the joined text.
 */
function textOfBlocks(content) {
	if (typeof content === 'string') return content
	if (!Array.isArray(content)) return ''
	const parts = [];
	for (const part of content) {
		if (part === null || typeof part !== 'object') {
			if (typeof part === 'string') parts.push(part);
			continue;
		}
		if (part.type === 'tool-result') {
			const nested = textOfBlocks(part.content);
			if (nested.length > 0) parts.push(nested);
			continue;
		}
		if (part.type === 'image') {
			parts.push(imageRefText(part.attachment));
			continue;
		}
		if (typeof part.text === 'string' && (part.type === undefined || TEXT_PART_TYPES.has(part.type))) parts.push(part.text);
	}
	return parts.join('\n');
}

/**
 * Read the human-readable text out of one message.
 * @param {any} message - a message with string or block-array content.
 * @returns {string} the joined text, or an empty string.
 */
export function messageText(message) {
	return textOfBlocks(message?.content);
}

/**
 * Project one durable event into a normalized record.
 * @param {{type: string, seq?: number, time?: number, data?: any}} event - a session event.
 * @returns {{type: string, seq: number, time: number, turn: number|undefined, step: number|undefined, text: string, message: unknown, data: any}|undefined} the record, or `undefined` for events with no text.
 */
export function projectEvent(event) {
	const type = event?.type;
	const data = event?.data ?? {};
	const base = {
		type,
		seq: typeof event?.seq === 'number' ? event.seq : -1,
		time: typeof event?.time === 'number' ? event.time : 0,
		turn: typeof data.turn === 'number' ? data.turn : undefined,
		step: typeof data.step === 'number' ? data.step : undefined,
		data
	};
	switch (type) {
		case 'user/message':
			return { ...base, message: data, text: messageText(data) };
		case 'assistant/message':
			return { ...base, message: data.message, text: messageText(data.message) };
		case 'tool/call': {
			// `arguments` is a JSON string produced by the model; a truncated or
			// malformed payload must not break turn accounting.
			let parsed;
			try {
				parsed = JSON.parse(typeof data.arguments === 'string' ? data.arguments : '{}');
			} catch {
				parsed = undefined;
			}
			return { ...base, message: undefined, tool: { name: typeof data.name === 'string' ? data.name : '', args: parsed } , text: '' };
		}
		case 'tool/result':
			return { ...base, message: data.message, text: messageText(data.message), error: data.error };
		default:
			return undefined;
	}
}

/**
 * Project an event array, dropping events with no textual meaning.
 * @param {Iterable<unknown>} events - the session's events.
 * @returns {Array<ReturnType<typeof projectEvent>>} normalized records in log order.
 */
export function projectEvents(events) {
	const output = [];
	for (const event of events ?? []) {
		const record = projectEvent(event);
		if (record !== undefined) output.push(record);
	}
	return output;
}

/**
 * Whether a record is the human's own message, i.e. the start of a turn.
 *
 * The turn's day is keyed on THIS timestamp, not on when the reply finished:
 * a message sent at 23:50 and answered at 00:10 belongs to the day it was sent.
 * `source.kind === 'user'` is the harness's own discriminator for real human
 * input, which keeps plugin-injected messages (including this tree's own
 * reminders) from being mistaken for a new turn.
 * @param {any} record - a projected record.
 * @returns {boolean} whether this record starts a turn.
 */
export function isTurnStart(record) {
	return record?.type === 'user/message' && record?.data?.source?.kind === 'user';
}

/**
 * Split a seq range into per-day segments, using the day each TURN started in.
 *
 * Why the range has to be split at all. A session outlives a calendar day, and
 * the tree is organised by calendar day, so a range that crosses midnight
 * contains content belonging to two days. Attributing the whole range to either
 * side misfiles the other: filing it under the earlier day buries the new day's
 * work where nobody looks for it, and filing it under the later day does the
 * same to the evening's work. The turn is the smallest unit that has a single
 * unambiguous day, so the split happens at turn boundaries.
 *
 * Records before the first human message keep the day of the first record: a
 * range can begin mid-turn, and those records belong with the turn they are
 * part of rather than with an invented date.
 *
 * `dayOf` is injected rather than imported so this module stays dependency-free
 * and the timezone rule stays in one place, in the caller.
 * @param {Iterable<unknown>} events - the session's events.
 * @param {number} fromSeq - inclusive lower bound.
 * @param {number} toSeq - inclusive upper bound.
 * @param {(epochMs: number) => string} dayOf - maps an event time to a `yyyy-mm-dd`.
 * @returns {Array<{dateText: string, fromSeq: number, toSeq: number, records: number, startTime: number, endTime: number}>} consecutive day segments.
 */
export function turnDaySegments(events, fromSeq, toSeq, dayOf) {
	const segments = [];
	let current;
	let turnStartedAt;
	for (const record of projectEvents(events)) {
		if (record.seq < fromSeq || record.seq > toSeq) continue;
		if (isTurnStart(record)) turnStartedAt = record.time;
		// Falls back to the record's own time until the first human message of the
		// range is seen.
		const stamp = turnStartedAt ?? record.time;
		const dateText = dayOf(stamp);
		if (current === undefined || current.dateText !== dateText) {
			current = {
				dateText,
				fromSeq: record.seq,
				toSeq: record.seq,
				records: 0,
				startTime: record.time,
				endTime: record.time
			};
			segments.push(current);
		}
		current.toSeq = record.seq;
		current.records += 1;
		current.endTime = record.time;
	}
	// The segments must TILE the requested range: no gap, no overlap. Coverage is
	// recorded as `fromSeq`/`toSeq`, and the next snapshot resumes at the highest
	// `toSeq` — so a gap silently loses events forever, and an overlap records the
	// same ones twice. Projection drops events that carry no text, so a segment's
	// own first and last RECORD are not good enough: the first segment has to
	// start at the range's start and the last has to end at the range's end, with
	// each boundary in between landing one past the previous segment.
	for (let index = 0; index < segments.length; index += 1) {
		segments[index].fromSeq = index === 0 ? fromSeq : segments[index - 1].toSeq + 1;
	}
	if (segments.length > 0) segments[segments.length - 1].toSeq = toSeq;
	return segments;
}

/**
 * The seq range a turn covers.
 * @param {Array<{type: string, turn: number|undefined, seq: number}>} records - projected records.
 * @param {number} turn - the turn number.
 * @returns {{fromSeq: number, toSeq: number}|undefined} the inclusive range, or `undefined` when the turn produced nothing.
 */
export function turnRange(records, turn) {
	let fromSeq = Number.POSITIVE_INFINITY;
	let toSeq = -1;
	for (const record of records) {
		if (record.turn !== turn) continue;
		if (record.seq < fromSeq) fromSeq = record.seq;
		if (record.seq > toSeq) toSeq = record.seq;
	}
	if (toSeq < 0 || !Number.isFinite(fromSeq)) return undefined;
	return { fromSeq, toSeq };
}

/**
 * Collect the distinct files a turn's tool calls touched.
 * @param {Array<ReturnType<typeof projectEvent>>} records - projected records.
 * @returns {string[]} ordinal-preserving unique file labels (basename when unambiguous).
 */
export function changedFiles(records) {
	const seen = new Set();
	const output = [];
	for (const record of records) {
		if (record.type !== 'tool/call' || record.tool === undefined) continue;
		if (!FILE_TOOLS.has(record.tool.name)) continue;
		const args = record.tool.args;
		if (args === undefined || args === null || typeof args !== 'object') continue;
		const candidate = args.file_path ?? args.path ?? args.filePath ?? args.target_file;
		if (typeof candidate !== 'string' || candidate.trim().length === 0) continue;
		const normalized = candidate.trim().replace(/\\/g, '/');
		if (seen.has(normalized)) continue;
		seen.add(normalized);
		output.push(normalized);
	}
	return output;
}

/**
 * Shrink file paths to readable labels, keeping enough context to disambiguate.
 *
 * Both separators are accepted because a caller may hand this either a raw
 * Windows path or the normalized form `changedFiles` produces. An ambiguous
 * basename grows leftward until the labels are distinct, so two `index.js`
 * files never render as the same label.
 * @param {string[]} paths - full paths as passed to the tool.
 * @param {number} [limit] - maximum labels to return.
 * @returns {string} a comma-separated label list.
 */
export function fileLabel(paths, limit = 4) {
	if (paths.length === 0) return '—';
	const segmentLists = paths.map((path) => path.split(/[\\/]/).filter((part) => part.length > 0));
	const labels = segmentLists.map(() => undefined);
	// Assign each entry the SHORTEST suffix that is unique among the group. An
	// entry that can never be made unique (two identical paths) keeps its
	// basename rather than degrading into a full absolute path.
	for (let depth = 1; depth <= 8; depth += 1) {
		const candidates = segmentLists.map((segments) => segments.slice(-depth).join('/'));
		const counts = new Map();
		for (const candidate of candidates) counts.set(candidate, (counts.get(candidate) ?? 0) + 1);
		for (let index = 0; index < labels.length; index += 1) {
			if (labels[index] !== undefined) continue;
			const candidate = candidates[index];
			if (candidate.length > 0 && (counts.get(candidate) ?? 0) === 1) labels[index] = candidate;
		}
	}
	for (let index = 0; index < labels.length; index += 1) {
		if (labels[index] === undefined) labels[index] = segmentLists[index][segmentLists[index].length - 1] ?? paths[index];
	}
	const shown = labels.slice(0, limit);
	const extra = labels.length - shown.length;
	return `${shown.join(', ')}${extra > 0 ? ` (+${extra})` : ''}`;
}

/**
 * The turn's headline: the first meaningful line of its last assistant message.
 * @param {Array<ReturnType<typeof projectEvent>>} records - projected records.
 * @param {number} [limit] - maximum characters.
 * @returns {string} a single-line summary, or a placeholder.
 */
export function turnHeadline(records, limit = 72) {
	for (let index = records.length - 1; index >= 0; index -= 1) {
		const record = records[index];
		if (record.type !== 'assistant/message') continue;
		const text = record.text ?? '';
		const line = text
			.split(/\r?\n/)
			.map((candidate) => candidate.replace(/^[#>*\-\s`]+/, '').trim())
			.find((candidate) => candidate.length > 0);
		if (line !== undefined) return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
	}
	return '（本轮无文本输出）';
}

/**
 * Sum the token usage reported inside one turn.
 * @param {Array<ReturnType<typeof projectEvent>>} records - projected records.
 * @returns {{input: number, output: number, total: number, calls: number}} summed usage.
 */
export function turnUsage(records) {
	let input = 0;
	let output = 0;
	let calls = 0;
	for (const record of records) {
		if (record.type !== 'assistant/message') continue;
		const usage = record.data?.usage;
		if (usage === null || typeof usage !== 'object') continue;
		calls += 1;
		input += numberOrZero(usage.inputTokens ?? usage.input_tokens ?? usage.promptTokens);
		output += numberOrZero(usage.outputTokens ?? usage.output_tokens ?? usage.completionTokens);
	}
	return { input, output, total: input + output, calls };
}

/**
 * Coerce a possibly-absent numeric field.
 * @param {unknown} value - candidate.
 * @returns {number} the number, or 0.
 */
function numberOrZero(value) {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Render a compact token delta such as `+12.3k`, `-840`, or `—`.
 * @param {number|undefined} delta - the signed change.
 * @returns {string} the rendered delta.
 */
export function formatDelta(delta) {
	if (typeof delta !== 'number' || !Number.isFinite(delta)) return '—';
	const sign = delta > 0 ? '+' : delta < 0 ? '-' : '±';
	const abs = Math.abs(delta);
	if (abs >= 1000) return `${sign}${(abs / 1000).toFixed(1)}k`;
	return `${sign}${abs}`;
}

/**
 * Slice the events of one turn and derive its accounting.
 * @param {Iterable<unknown>} events - the session's events.
 * @param {number} turn - the turn number.
 * @returns {{records: Array<ReturnType<typeof projectEvent>>, files: string[], headline: string, usage: {input: number, output: number, total: number, calls: number}, range: {fromSeq: number, toSeq: number}|undefined}} the turn slice.
 */
export function turnSlice(events, turn) {
	const records = projectEvents(events).filter((record) => record.turn === turn);
	return {
		records,
		files: changedFiles(records),
		headline: turnHeadline(records),
		usage: turnUsage(records),
		range: turnRange(records, turn)
	};
}

/**
 * Render the verbatim slice of a seq range as Markdown.
 *
 * This is the authoritative layer: the model may summarize it lossily, but the
 * original wording stays reachable by drilling down to the snapshot.
 *
 * When the range does not fit, keep BOTH ends and drop the middle — the same
 * shape (`headRatio` 0.34) `windowSlice` uses for the prompt, and for the same
 * reason. Keeping only the head is backwards for a record: on 2026-09-14 a slice
 * that had been mis-ranged to span a whole session spent its 4 MB keeping the
 * OLDEST events — which thirteen earlier snapshots already held — and dropped
 * everything from that point to the present, so the newest half-day ended up in
 * no snapshot at all. A record that survives is worth more than one that is
 * complete only where it is redundant.
 *
 * Memory note: the range is rendered into an array so the two ends can be chosen
 * exactly. That is bounded because the range is only the session's UNCOVERED
 * tail — which is what `findSessionWatermark` guarantees. It was unbounded when
 * that lookup was per-day, because the range could then be the entire session.
 * @param {Iterable<unknown>} events - the session's events.
 * @param {number} fromSeq - inclusive lower bound.
 * @param {number} toSeq - inclusive upper bound.
 * @param {number} [maxBytes] - truncation budget for the rendered text.
 * @returns {{text: string, truncated: boolean, records: number}} the slice.
 */
export function verbatimSlice(events, fromSeq, toSeq, maxBytes = 512 * 1024) {
	const rendered = [];
	for (const event of events ?? []) {
		const seq = typeof event?.seq === 'number' ? event.seq : -1;
		if (seq < fromSeq || seq > toSeq) continue;
		const record = projectEvent(event);
		if (record === undefined) continue;
		const text = renderRecord(record, event);
		if (text === undefined) continue;
		rendered.push({ text, size: Buffer.byteLength(text, 'utf8') });
	}
	const total = rendered.reduce((sum, entry) => sum + entry.size, 0);
	if (total <= maxBytes) {
		return { text: rendered.map((entry) => entry.text).join('\n\n'), truncated: false, records: rendered.length };
	}

	const headBudget = Math.floor(maxBytes * 0.34);
	const tailBudget = Math.max(0, maxBytes - headBudget - TRUNCATION_MARKER_SIZE);
	const head = [];
	let headUsed = 0;
	let index = 0;
	for (; index < rendered.length && headUsed + rendered[index].size <= headBudget; index += 1) {
		head.push(rendered[index].text);
		headUsed += rendered[index].size;
	}
	const tail = [];
	let tailUsed = 0;
	let fromEnd = rendered.length - 1;
	for (; fromEnd >= index && tailUsed + rendered[fromEnd].size <= tailBudget; fromEnd -= 1) {
		tail.push(rendered[fromEnd].text);
		tailUsed += rendered[fromEnd].size;
	}
	tail.reverse();
	const omitted = fromEnd - index + 1;
	const marker = `…（此处省略中段 ${omitted} 条；以下内容更接近本次快照的末尾）…`;
	return {
		text: [...head, marker, ...tail].join('\n\n'),
		truncated: true,
		records: rendered.length
	};
}

/** Byte budget reserved for the middle-omitted marker. */
const TRUNCATION_MARKER_SIZE = 160;

/**
 * Render one projected record as a Markdown block.
 * @param {ReturnType<typeof projectEvent>} record - the projected record.
 * @param {{type: string, seq?: number, time?: number}} event - the source event.
 * @returns {string|undefined} the block, or `undefined` when the record is not worth keeping.
 */
function renderRecord(record, event) {
	const when = typeof event?.time === 'number' ? new Date(event.time).toISOString() : 'unknown';
	const heading = `### seq ${record.seq} · ${record.type} · ${when}`;
	switch (record.type) {
		case 'user/message': {
			const source = record.data?.source?.kind ?? 'unknown';
			const text = record.text.trim();
			if (text.length === 0) return undefined;
			return `${heading}\n\n_来源：${source}_\n\n${text}`;
		}
		case 'assistant/message': {
			const text = record.text.trim();
			if (text.length === 0) return undefined;
			return `${heading}\n\n${text}`;
		}
		case 'tool/call': {
			const args = record.tool?.args;
			const rendered = args === undefined ? String(record.data?.arguments ?? '') : JSON.stringify(args, null, 2);
			return `${heading}\n\n\`${record.tool?.name ?? '?'}\`\n\n\`\`\`json\n${rendered.slice(0, 4000)}\n\`\`\``;
		}
		case 'tool/result': {
			const text = record.text.trim();
			const status = record.error === undefined ? 'ok' : `error: ${record.error?.name ?? 'unknown'}`;
			if (text.length === 0) return `${heading}\n\n_结果：${status}（无文本）_`;
			return `${heading}\n\n_结果：${status}_\n\n${text.length > 8000 ? `${text.slice(0, 8000)}\n…（结果被截断）` : text}`;
		}
		default:
			return undefined;
	}
}

/**
 * The highest seq already covered by a set of snapshot headers.
 * @param {Array<Record<string, string>>} headers - parsed snapshot front matters.
 * @returns {number} the highest `toSeq`, or -1 when none is recorded.
 */
export function highestCoveredSeq(headers) {
	let highest = -1;
	for (const header of headers) {
		const value = Number(header?.toSeq);
		if (Number.isFinite(value) && value > highest) highest = value;
	}
	return highest;
}

/**
 * Parse the tree's own stamp shape into epoch ms.
 *
 * The shape is what the plugin writes: `2026-09-15 00:52:06 +08:00`. Parsed by
 * hand rather than with `Date.parse`, because the space-separated form with a
 * trailing offset is not one V8 is required to accept — and a parse that
 * silently returns `NaN` here would look exactly like "there is nothing new".
 * @param {unknown} text - the stamp.
 * @returns {number|undefined} epoch ms, or `undefined` when the shape is unrecognised.
 */
export function parseStamp(text) {
	if (typeof text !== 'string') return undefined;
	const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(text.trim());
	if (match === null) return undefined;
	const [, year, month, day, hour, minute, second, millis, zone] = match;
	const base = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), Number(millis ?? 0));
	if (zone === undefined) return base; // no offset written ⇒ read as UTC: wrong by hours, but deterministic
	if (zone === 'Z') return base;
	const sign = zone.startsWith('-') ? -1 : 1;
	const [zoneHour, zoneMinute] = zone.replace(/^[+-]/, '').split(':');
	return base - sign * (Number(zoneHour) * 60 + Number(zoneMinute ?? 0)) * 60_000;
}

/**
 * The lowest seq whose event time is strictly after `sinceMs`.
 *
 * This is the rebase boundary for a session whose log changed seq space: after
 * DSH 2.0.10 the live log is `session.v3.jsonl.zstd`, whose `seq` restarts near
 * 0, while the tree's watermark still carries the OLD numbering — so
 * `toSeq < fromSeq` holds forever and every snapshot answers `empty` while the
 * tree looks healthy from the outside. Time is the one axis that survives it.
 * @param {readonly unknown[]} events - the session's events.
 * @param {number|undefined} sinceMs - exclusive lower bound; `undefined` matches nothing.
 * @returns {number|undefined} the seq, or `undefined` when no event is newer.
 */
export function firstSeqAfter(events, sinceMs) {
	if (!Number.isFinite(sinceMs)) return undefined;
	let best;
	for (const event of events) {
		const seq = typeof event?.seq === 'number' ? event.seq : undefined;
		const time = typeof event?.time === 'number' ? event.time : undefined;
		if (seq === undefined || time === undefined || time <= sinceMs) continue;
		if (best === undefined || seq < best) best = seq;
	}
	return best;
}
