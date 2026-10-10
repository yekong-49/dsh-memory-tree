/**
 * The summarization scheme: two model calls per snapshot.
 *
 *   call 1  raw verbatim slice + the recent entries → NEW day entries (a delta)
 *   call 2  the whole day's entries
 *           + this month's other day gists
 *           + this year's month gists
 *           + every year's gist               → day, month, year, long-term gists
 *
 * Why two calls and not five: each level's input is only the level below it, so
 * the upper call stays tiny no matter how long the day was. Splitting it per
 * level would multiply the latency of every snapshot for no extra information.
 *
 * Why call 1 returns a DELTA and call 2 returns the day's line: the two answer
 * different questions, and conflating them is what broke this tree. Call 1 asks
 * "what happened since last time" — its answer is appended to the day log and
 * can never remove anything. Call 2 asks "what was this day, all of it" — its
 * answer replaces one index line, which is safe precisely because the thing it
 * summarises is permanent and one level down. A single call doing both jobs had
 * to rewrite the day's account from memory every time, and the day's beginning
 * went missing the first time the model judged it least relevant.
 *
 * Why the model never writes table rows: roll-ups are recomputed from the
 * filesystem (`tree.js`). The model's only durable output is a `summary:` gist
 * per node, which keeps roll-ups idempotent and self-healing.
 *
 * The route is read from the session's own request header, so these calls use
 * exactly the provider/model the conversation already uses, with no separate
 * configuration to drift out of date.
 */

import { randomUUID } from 'node:crypto';

/** Purpose tag accepted by `GenerateOptions.purpose` (a closed union). */
const PURPOSE = undefined;

/**
 * Assemble streamed chunks into text.
 *
 * The chunk protocol is a sequence of `block-start` / `*-delta` / `block-end`
 * records plus a terminal `finish` or `error`. We only consume text, but we
 * record every chunk type seen so `memory_status --probe` can report the real
 * protocol instead of an assumed one.
 */
export class TextAssembler {
	/** @type {Map<number, {type: string, text: string}>} */
	#blocks = new Map();

	/** Terminal reason, when one arrived. */
	finish = undefined;

	/** Terminal failure, when one arrived. */
	failure = undefined;

	/** Usage record, when one arrived. */
	usage = undefined;

	/** Every chunk type observed, in first-seen order. */
	observed = [];

	/** Total chunks pushed. */
	count = 0;

	/**
	 * Consume one chunk.
	 * @param {any} chunk - a stream chunk.
	 * @returns {void}
	 */
	push(chunk) {
		if (chunk === null || typeof chunk !== 'object') return;
		this.count += 1;
		const type = typeof chunk.type === 'string' ? chunk.type : '(untyped)';
		if (!this.observed.includes(type)) this.observed.push(type);
		switch (type) {
			case 'block-start':
				this.#blocks.set(numberOr(chunk.index, this.#blocks.size), {
					type: typeof chunk.blockType === 'string' ? chunk.blockType : 'text',
					text: ''
				});
				break;
			case 'text-delta':
			case 'reasoning-delta': {
				const index = numberOr(chunk.index, 0);
				const block = this.#block(index, type === 'reasoning-delta' ? 'reasoning' : 'text');
				block.text += typeof chunk.text === 'string' ? chunk.text : typeof chunk.delta === 'string' ? chunk.delta : '';
				break;
			}
			case 'block-end': {
				const index = numberOr(chunk.index, 0);
				const block = this.#block(index, 'text');
				const final = chunk.block?.text;
				// Some adapters ship the authoritative text only in block-end.
				if (typeof final === 'string' && final.length > block.text.length) block.text = final;
				break;
			}
			case 'finish':
				this.finish = chunk.reason ?? chunk;
				break;
			case 'error':
				this.failure = chunk.failure ?? chunk;
				break;
			case 'usage':
				this.usage = chunk;
				break;
			default:
				break;
		}
	}

	/**
	 * Read or create one block slot.
	 * @param {number} index - block index.
	 * @param {string} type - fallback block type.
	 * @returns {{type: string, text: string}} the slot.
	 */
	#block(index, type) {
		const existing = this.#blocks.get(index);
		if (existing !== undefined) return existing;
		const created = { type, text: '' };
		this.#blocks.set(index, created);
		return created;
	}

	/**
	 * The assembled text of every text block, in index order.
	 * @returns {string} the joined text.
	 */
	get text() {
		return [...this.#blocks.entries()]
			.sort((a, b) => a[0] - b[0])
			.filter(([, block]) => block.type === 'text')
			.map(([, block]) => block.text)
			.join('')
			.trim();
	}

	/**
	 * Whether the stream ended without a terminal failure.
	 * @returns {boolean} whether the call completed.
	 */
	get ok() {
		if (this.failure !== undefined) return false;
		const kind = this.finish?.kind;
		return kind === undefined || kind === 'stop';
	}
}

/**
 * Coerce a possibly-absent numeric field.
 * @param {unknown} value - candidate.
 * @param {number} fallback - value to use when absent.
 * @returns {number} the number.
 */
function numberOr(value, fallback) {
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Build the one user message a plugin-initiated call sends.
 *
 * Mirrors the harness's own `createUserMessage` shape (role, content parts,
 * plugin source, stable id) so the call passes the same validation the
 * built-in title and compaction calls do.
 * @param {string} text - the prompt body.
 * @param {string} plugin - owning plugin name; becomes the producer-owned `plugin:<name>` kind.
 * @returns {{role: 'user', id: string, content: Array<{type: 'text', text: string}>, source: {kind: string}}} the message.
 */
export function pluginUserMessage(text, plugin) {
	return {
		role: 'user',
		id: randomUUID(),
		content: [{ type: 'text', text }],
		// Producer-owned kind: v4 admission refuses the retired `kind: 'plugin'`
		// wrapper and fails the whole turn carrying it (see reminder.js).
		source: { kind: `plugin:${plugin}` }
	};
}

/**
 * Combine a caller signal with a timeout, when the runtime supports it.
 * @param {AbortSignal|undefined} signal - caller cancellation.
 * @param {number} timeoutMs - budget in milliseconds.
 * @returns {AbortSignal|undefined} the combined signal.
 */
function withTimeout(signal, timeoutMs) {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return signal;
	if (typeof AbortSignal?.timeout !== 'function') return signal;
	const timeout = AbortSignal.timeout(timeoutMs);
	if (signal === undefined) return timeout;
	return typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : signal;
}

/**
 * Run one plugin-initiated model call and assemble its text.
 * @param {{llm: any, route: {provider: string, model: string}, system: string, user: string, maxTokens: number, sessionId?: string, signal?: AbortSignal, timeoutMs?: number, plugin: string}} input - call request.
 * @returns {Promise<{ok: boolean, text: string, finish: any, failure: any, chunks: number, observed: string[], error?: string}>} the call outcome.
 */
export async function runCall({ llm, route, system, user, maxTokens, sessionId, signal, timeoutMs = 180_000, plugin }) {
	const assembler = new TextAssembler();
	if (llm === undefined || typeof llm.stream !== 'function') {
		return { ok: false, text: '', finish: undefined, failure: undefined, chunks: 0, observed: [], error: 'the llm service is unavailable' };
	}
	if (route?.provider === undefined || route?.model === undefined) {
		return { ok: false, text: '', finish: undefined, failure: undefined, chunks: 0, observed: [], error: 'no provider/model route is known for this session yet' };
	}
	const callSignal = withTimeout(signal, timeoutMs);
	const options = {
		provider: route.provider,
		model: route.model,
		messages: [pluginUserMessage(user, plugin)],
		system,
		maxTokens,
		...(sessionId === undefined ? {} : { sessionId }),
		...(callSignal === undefined ? {} : { signal: callSignal }),
		...(PURPOSE === undefined ? {} : { purpose: PURPOSE })
	};
	try {
		for await (const chunk of llm.stream(options)) assembler.push(chunk);
	} catch (error) {
		return {
			ok: false,
			text: assembler.text,
			finish: assembler.finish,
			failure: assembler.failure,
			chunks: assembler.count,
			observed: assembler.observed,
			error: error?.message ?? String(error)
		};
	}
	return {
		ok: assembler.ok && assembler.text.length > 0,
		text: assembler.text,
		finish: assembler.finish,
		failure: assembler.failure,
		chunks: assembler.count,
		observed: assembler.observed,
		...(assembler.ok ? {} : { error: describeTerminal(assembler) })
	};
}

/**
 * Describe why a call produced no usable text.
 * @param {TextAssembler} assembler - the finished assembler.
 * @returns {string} a human-readable reason.
 */
function describeTerminal(assembler) {
	if (assembler.failure !== undefined) return `stream failed: ${assembler.failure?.message ?? JSON.stringify(assembler.failure)}`;
	const kind = assembler.finish?.kind;
	if (kind !== undefined && kind !== 'stop') return `stream finished with ${kind}`;
	if (assembler.count === 0) return 'the stream produced no chunks';
	return 'the model produced no text';
}

/** System prompt for the day-entry call. */
const DAY_SYSTEM = `你是跨会话记忆树的**事件记录器**。你会读到一段会话的**逐字原文切片**（用户与助手消息、工具调用与结果）。
你的任务：找出这段切片里**值得永久记下的主要事件 / 任务 / 决定 / 结论**，每个写**一小段**摘要。

规则（按重要性）：

1. **一条一个主要事件或任务**。不要把一次任务拆成一堆琐碎步骤，也不要把几件不相关的事揉成一条。
2. **只写本次新增的内容**。下面会给你「本日已记的最近条目」，**已经记过的不要再写一遍**。
   如果这次切片是同一任务的**新进展**，就另写一条，开头标「（续）」。
3. **没有产出的东西不要记**：纯问答、闲聊、重复的调试、试了又撤回的尝试，都不写。
4. 每条 1–3 句、**不超过 200 字**，必须带上最关键的实体名（文件 / 插件 / 工具 / 数值）和结论。
5. 只写原文里真实出现的信息；不确定就写「不确定」，**不要编造**。原文是英文就保留英文术语。
6. **不要写入敏感值的字面量**：公网 IP、32 位十六进制 ID（openid / peerId）、API key / 密码 / token。
   需要指代时写「云端主机」「那个 openid」，或直接写遮蔽标记（形如 [REDACTED] / [REDACTED-IP]）。写入端会强制兜底遮蔽，
   但**你先不写**才能保证记录读得懂——被兜底遮蔽的原文会变成一串遮蔽标记，信息就没了。

只输出下面两个区块，**不要开场白、不要任何解释**：

## 一句话
不超过 40 字，概括**这一段切片本身**（给快照索引用：这一份快照覆盖了什么）。
必须单行、含最关键的实体名或结论。它**不是**当天的总结——当天的总结另有其人在写。

## 事件
- 条目一
- 条目二

「事件」区块里如果**没有任何值得记的主要事件**，就写一个字：无`;

/**
 * Build the user prompt for the day-entry call.
 * @param {{dateText: string, trigger: string, slice: string, truncated: boolean, recent?: string, turnLog?: string}} input - prompt inputs.
 * @returns {string} the prompt body.
 */
export function dayPrompt({ dateText, trigger, slice, truncated, recent, turnLog }) {
	const parts = [
		`# 日期\n${dateText}（触发：${trigger}）`,
		truncated ? '> 注意：本次切片因体积上限被截断，末尾可能不完整。' : '',
		recent !== undefined && recent.trim().length > 0 ? `# 本日已记的最近条目（不要重复这些）\n${recent.trim()}` : '# 本日已记的最近条目\n（本日还没有任何条目）',
		turnLog !== undefined && turnLog.trim().length > 0 ? `# 本次机械流水\n${turnLog.trim()}` : '',
		`# 逐字原文切片\n${slice}`
	];
	return parts.filter((part) => part.length > 0).join('\n\n');
}

/**
 * Split a sectioned model answer into its named sections.
 * @param {string} text - the model output.
 * @param {string[]} names - expected section names (Chinese headings).
 * @returns {Record<string, string>} section name → trimmed body.
 */
export function parseSections(text, names) {
	const output = {};
	const lines = String(text ?? '').split(/\r?\n/);
	let current;
	const buffer = [];
	const flush = () => {
		if (current !== undefined) output[current] = buffer.join('\n').trim();
		buffer.length = 0;
	};
	for (const line of lines) {
		const match = /^#{1,6}\s*(.+?)\s*$/.exec(line);
		if (match !== null && names.includes(match[1].trim())) {
			flush();
			current = match[1].trim();
			continue;
		}
		if (current !== undefined) buffer.push(line);
	}
	flush();
	return output;
}

/** Lines that mean "this slice held nothing worth recording". */
const NOTHING_RE = /^(无|（无）|\(无\)|无新增|无新增事件|没有|none|nothing)[。.！!]?$/i;

/**
 * Read the event entries out of a model answer.
 *
 * Bullets are the contract. Two fallbacks exist because a malformed answer must
 * not silently become "nothing happened": an explicit 无 is respected, and a
 * single short line is taken at face value. Anything longer without bullets is
 * rejected, so the caller can record that the call failed instead of appending
 * a paragraph of the model's own preamble as if it were an event.
 * @param {string} text - the model output.
 * @returns {{entries: string[], nothing: boolean, malformed: boolean}} the parse.
 */
export function parseEntries(text) {
	const source = String(text ?? '');
	const entries = [];
	for (const line of source.split(/\r?\n/)) {
		const match = /^\s*(?:[-*+]|\d+[.)])\s+(.*\S)\s*$/.exec(line);
		if (match !== null) entries.push(match[1]);
	}
	if (entries.length > 0) return { entries, nothing: false, malformed: false };
	const flat = source.trim();
	if (flat.length === 0) return { entries: [], nothing: false, malformed: true };
	if (NOTHING_RE.test(flat)) return { entries: [], nothing: true, malformed: false };
	const lines = flat.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
	if (lines.length === 1 && lines[0].length <= 200) return { entries: lines, nothing: false, malformed: false };
	return { entries: [], nothing: false, malformed: true };
}

/**
 * Summarize one snapshot's verbatim slice: its own one-liner, and NEW day entries.
 *
 * Two answers from one call because they serve two different readers and must not
 * be conflated. The **one-liner describes this slice** and becomes the snapshot's
 * row in the day's index — the index is how a day is navigated, so every row has
 * to say what ITS snapshot covered. The **entries** are appended to the day's log
 * and describe the day.
 *
 * Conflating them is a mistake that was made here and caught by reading the
 * result: the day's whole-day line was stamped into each new snapshot's header,
 * so every row of the index repeated the day's summary verbatim and the index
 * stopped being an index.
 * @param {{llm: any, route: {provider: string, model: string}, sessionId?: string, signal?: AbortSignal, maxTokens: number, timeoutMs: number, plugin: string, dateText: string, trigger: string, slice: string, truncated: boolean, recent?: string, turnLog?: string}} input - call request.
 * @returns {Promise<{ok: boolean, gist?: string, entries?: string[], nothing?: boolean, error?: string, observed: string[]}>} the slice's one-liner and the new entries.
 */
export async function summarizeDay(input) {
	const result = await runCall({
		llm: input.llm,
		route: input.route,
		system: DAY_SYSTEM,
		user: dayPrompt(input),
		maxTokens: input.maxTokens,
		sessionId: input.sessionId,
		signal: input.signal,
		timeoutMs: input.timeoutMs,
		plugin: input.plugin
	});
	if (!result.ok) return { ok: false, error: result.error, observed: result.observed };
	const sections = parseSections(result.text, ['一句话', '事件']);
	const gist = truncate((sections['一句话'] ?? '').replace(/^[-*\s]+/, '').replace(/\s*\n\s*/g, ' ').trim(), 160);
	const hasEvents = typeof sections['事件'] === 'string';
	const parsed = hasEvents ? parseEntries(sections['事件']) : { entries: [], nothing: true, malformed: false };
	if (parsed.malformed) {
		return { ok: false, error: 'the event list had no recognizable bullet lines', observed: result.observed };
	}
	// A missing `事件` section is "nothing to record", not a failure: the one-liner
	// proves the call worked, and the slice still reaches the tree through the
	// snapshot itself and the turn log.
	return {
		ok: true,
		...(gist.length === 0 ? {} : { gist }),
		entries: parsed.entries,
		nothing: parsed.nothing,
		observed: result.observed
	};
}

/** System prompt for the roll-up call. */
const UPPER_SYSTEM = `你是跨会话记忆树的摘要器。你会读到**当日事件（逐条）**与**下级摘要**（本月其余各日、本年各月、历年）。
请写出四个层级各自的一行摘要。只输出下面四个区块，不要任何额外说明：

## 当日
用不超过 60 字概括**本日全天**（覆盖当天的主要事件，而不是只写最新那一条）

## 月
用不超过 60 字概括该月（单行）

## 年
用不超过 60 字概括该年（单行）

## 长期
用不超过 120 字概括这棵记忆树到目前为止的长期走向（单行；关注长期目标、持续主题、反复出现的问题）

**每一级都必须覆盖它所概括的整个单元**：当日要覆盖全天、月要覆盖该月每一天、年要覆盖该年每一月、
长期要覆盖历年——**不要只写最后发生的那件事**。这些行是永久保留的索引行，只写最新一条会让整棵树塌缩成「刚才」。

只写下级摘要与事件里真实出现的信息，不要编造。
**不要写敏感值的字面量**（公网 IP、32 位 openid/peerId、API key / 密码 / token）：需要指代时写「云端主机」「那个 openid」。
**即使线索很少，也要用现有信息写出最具体的一句话**（可以带范围，如「2026-09：开始为 DSH 开发插件」）；
不要写「信息不足」这类占位话——占位话会一直留在树里。`;

/**
 * Build the user prompt for the roll-up call.
 * @param {{monthLabel: string, yearLabel: string, daySummary?: string, monthGists: string[], yearGists: string[], allYears: string[], previous?: {day?: string, month?: string, year?: string, longterm?: string}}} input - prompt inputs.
 * @returns {string} the prompt body.
 */
export function upperPrompt({ monthLabel, yearLabel, daySummary, monthGists, yearGists, allYears, previous }) {
	const list = (items) => (items.length === 0 ? '（无）' : items.map((item) => `- ${item}`).join('\n'));
	return [
		`# 本日当日事件（逐条，按时间；这是本日的完整记录）\n${daySummary === undefined || daySummary.trim().length === 0 ? '（本日还没有条目）' : daySummary.trim()}`,
		`# 本月（${monthLabel}）其余各日摘要\n${list(monthGists)}`,
		`# 本年（${yearLabel}）各月摘要\n${list(yearGists)}`,
		`# 历年摘要\n${list(allYears)}`,
		previous !== undefined
			? `# 上一版（可参考）\n当日：${previous.day ?? '—'}\n月：${previous.month ?? '—'}\n年：${previous.year ?? '—'}\n长期：${previous.longterm ?? '—'}`
			: ''
	]
		.filter((part) => part.length > 0)
		.join('\n\n');
}

/**
 * Summarize the day, month, year, and long-term levels in one call.
 * @param {{llm: any, route: {provider: string, model: string}, sessionId?: string, signal?: AbortSignal, maxTokens: number, timeoutMs: number, plugin: string, monthLabel: string, yearLabel: string, daySummary?: string, monthGists: string[], yearGists: string[], allYears: string[], previous?: {day?: string, month?: string, year?: string, longterm?: string}}} input - call request.
 * @returns {Promise<{ok: boolean, day?: string, month?: string, year?: string, longterm?: string, error?: string, observed: string[]}>} the upper summaries.
 */
export async function summarizeUpper(input) {
	const result = await runCall({
		llm: input.llm,
		route: input.route,
		system: UPPER_SYSTEM,
		user: upperPrompt(input),
		maxTokens: input.maxTokens,
		sessionId: input.sessionId,
		signal: input.signal,
		timeoutMs: input.timeoutMs,
		plugin: input.plugin
	});
	if (!result.ok) return { ok: false, error: result.error, observed: result.observed };
	const sections = parseSections(result.text, ['当日', '月', '年', '长期']);
	const clean = (value) => (typeof value === 'string' ? value.replace(/^[-*\s]+/, '').replace(/\s*\n\s*/g, ' ').trim() : undefined);
	const day = clean(sections['当日']);
	const month = clean(sections['月']);
	const year = clean(sections['年']);
	const longterm = clean(sections['长期']);
	if (day === undefined && month === undefined && year === undefined && longterm === undefined) {
		return { ok: false, error: 'the roll-up answer had no recognizable sections', observed: result.observed };
	}
	return {
		ok: true,
		...(day === undefined ? {} : { day: truncate(day, 160) }),
		...(month === undefined ? {} : { month: truncate(month, 160) }),
		...(year === undefined ? {} : { year: truncate(year, 160) }),
		...(longterm === undefined ? {} : { longterm: truncate(longterm, 240) }),
		observed: result.observed
	};
}

/**
 * Shorten text without splitting a surrogate pair.
 * @param {string} text - the text.
 * @param {number} limit - maximum length.
 * @returns {string} the possibly-shortened text.
 */
export function truncate(text, limit) {
	const value = String(text ?? '');
	if (value.length <= limit) return value;
	return `${value.slice(0, Math.max(0, limit - 1))}…`;
}

/**
 * Keep the head AND the tail of an over-long slice, dropping the middle.
 *
 * A plain head-only cut summarises the OLDEST part of a long session: on the
 * first live run a 526 KB slice was cut to its first 120 k characters, and the
 * resulting day summary described work from hours earlier while the session's
 * current state never appeared. Since the question a future session asks is
 * "where did this end up", the tail gets the larger share and the marker says
 * which direction the surviving text points.
 * @param {string} text - the slice.
 * @param {number} limit - maximum characters.
 * @param {number} [headRatio] - share of the budget given to the head.
 * @returns {string} the windowed slice.
 */
export function windowSlice(text, limit, headRatio = 0.34) {
	const value = String(text ?? '');
	if (!Number.isFinite(limit) || limit <= 0 || value.length <= limit) return value;
	const marker = '\n\n…（此处省略中段；以下内容更接近当前状态）…\n\n';
	const budget = Math.max(0, limit - marker.length);
	const head = Math.floor(budget * Math.min(Math.max(headRatio, 0), 1));
	const tail = Math.max(0, budget - head);
	return `${value.slice(0, head)}${marker}${value.slice(value.length - tail)}`;
}
