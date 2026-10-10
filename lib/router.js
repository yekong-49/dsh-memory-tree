/**
 * router.js — "这条消息和过去哪些记忆有关？" 的召回层。
 *
 * 为什么单独一个模块：它要能被**离线测试**（注入 index 与 transport，不碰网络、不碰磁盘），
 * 而它跑在 DSH 的进程里 —— 每轮一次，实测 **5 ms**（编码 10 ms 首次 + 余弦扫 1005 条 ~2 ms）。
 *
 * ⚠ 三条设计约束（都是踩过的）：
 *  1. **绝不 spawn 子进程** —— `node route.js` 每次要 50~100 ms（进程启动比活贵 10 倍），所以直接 HTTP。
 *  2. **绝不抛进 agent 路径** —— 任何失败都吞掉并记 `lastError`，返回 undefined；记忆检索坏了不该把对话搞挂。
 *  3. **写出去的文本先脱敏** —— 反馈里含用户原话，而它落在 `<MEMORY_ROOT>` 里面（树里不许有敏感值）。
 */

import http from 'node:http';
import { readFile } from 'node:fs/promises';

/** 余弦：向量在加载时已归一化，所以就是点积。 */
function dot(a, b) {
	let sum = 0;
	for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
	return sum;
}

function unit(vec) {
	let norm = 0;
	for (let i = 0; i < vec.length; i += 1) norm += vec[i] * vec[i];
	norm = Math.sqrt(norm) || 1;
	const out = new Float32Array(vec.length);
	for (let i = 0; i < vec.length; i += 1) out[i] = vec[i] / norm;
	return out;
}

/**
 * The default transport: one POST to the local embeddings server.
 * @param {{baseUrl: string, path: string, body: unknown, timeoutMs: number}} request - the call.
 * @returns {Promise<unknown>} the parsed JSON body.
 */
export function httpTransport(request) {
	return new Promise((resolve, reject) => {
		const url = new URL(request.baseUrl + request.path);
		const payload = JSON.stringify(request.body);
		const call = http.request({
			host: url.hostname,
			port: url.port,
			path: url.pathname,
			method: 'POST',
			timeout: request.timeoutMs,
			headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
		}, (response) => {
			let text = '';
			response.on('data', (chunk) => { text += chunk; });
			response.on('end', () => {
				try { resolve(JSON.parse(text)); } catch { reject(new Error(`embeddings: bad JSON (${response.statusCode})`)); }
			});
		});
		call.on('error', reject);
		call.on('timeout', () => { call.destroy(new Error('embeddings: timeout')); });
		call.write(payload);
		call.end();
	});
}

const normDate = (value) => {
	const match = String(value ?? '').match(/^(\d{2})-(\d{2})$/);
	return match ? `2026-${match[1]}-${match[2]}` : String(value ?? '');
};
const dayDiff = (iso, now) => Math.abs(now - new Date(iso).getTime()) / 86_400_000;

/** Pull a calendar date out of the message (2026-09-18 / 9月18日 / 09-18). A missing year
 * means this year, unless that would land in the future — then last year. YYYY-MM-DD | null. */
function extractDate(text, nowMs) {
	const raw = String(text ?? '');
	let year = null; let month = null; let day = null;
	let m = raw.match(/(\d{4})\s*[-\/.年]\s*(\d{1,2})\s*[-\/.月]\s*(\d{1,2})/);
	if (m) { year = Number(m[1]); month = Number(m[2]); day = Number(m[3]); }
	if (year === null) { m = raw.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/); if (m) { month = Number(m[1]); day = Number(m[2]); } }
	if (month === null) { m = raw.match(/(?:^|[^\d])(\d{1,2})\s*[-\/]\s*(\d{1,2})(?!\d)/); if (m) { month = Number(m[1]); day = Number(m[2]); } }
	if (month === null || day === null || month < 1 || month > 12 || day < 1 || day > 31) return null;
	if (year === null) {
		year = new Date(nowMs).getFullYear();
		if (new Date(year, month - 1, day).getTime() - nowMs > 2 * 86_400_000) year -= 1;
	}
	const pad = (n) => String(n).padStart(2, '0');
	return year + '-' + pad(month) + '-' + pad(day);
}

/** What the message says BESIDES the date, so "9月18号那天我说过什么" (date is the only clue)
 * can be told apart from "9月18号我要出差，顺便问显卡" (the date is incidental). */
function withoutDate(text) {
	return String(text ?? '')
		.replace(/\d{4}\s*[-\/.年]\s*\d{1,2}\s*[-\/.月]\s*\d{1,2}\s*[日号]?/g, '')
		.replace(/\d{1,2}\s*月\s*\d{1,2}\s*[日号]?/g, '')
		.replace(/(?:^|[^\d])\d{1,2}\s*[-\/]\s*\d{1,2}(?!\d)/g, '')
		.replace(/[\s，。！!？?、,.：:；;~～「」【】()（）]/g, '');
}

/** Does the message point at a day, and does that day have anything to do with it?
 * @returns {{date: string, cosine: number, mode: string}|null} mode = pure | boost | null. */
function dateAnchorOf(text, scored, config) {
	if (config.routerDateAnchor === false) return null;
	const date = extractDate(text, Date.now());
	if (date === null) return null;
	const rowsForDate = scored.filter((row) => row.date === date);
	if (rowsForDate.length === 0) return null;
	const cosine = rowsForDate.reduce((acc, row) => Math.max(acc, row.cosine), 0);
	// Strip words that carry no subject matter, so "那天我说过什么" is recognised as a pure date
	// reference while "我要出差一趟，另外那个显卡的事" is not (measured 2026-10-02).
	const CONTENTLESS_RE = /(那天|那天你|当时|之前|以前|记得|记不记得|我说过|说过|聊过|聊了什么|讨论过|提过|什么|啥|来着|了吗|吗|呢|吧|你|我|我们|咱们|一下|那个|这个)/g;
	const rest = withoutDate(text).replace(CONTENTLESS_RE, '');
	const pureChars = Number.isFinite(config.routerDateAnchorPureChars) ? config.routerDateAnchorPureChars : 6;
	if (rest.length <= pureChars) return { date: date, cosine: cosine, mode: 'pure' };
	const floor = Number.isFinite(config.routerDateAnchorMinCos) ? config.routerDateAnchorMinCos : 0.60;
	// The floor is deliberately the same as the gate: a date mention earns a promotion only when
// that day is at least as relevant as anything the gate would have accepted anyway. 0.45 sat
// inside the noise band — for "9月18号我要出差，另外那个显卡的事怎么说" 09-18 scored 0.557
// and hijacked the answer away from 2026-10-02, exactly the trap the human warned about.
return cosine >= floor ? { date: date, cosine: cosine, mode: 'boost' } : null;
}


/**
 * Build a router. Nothing is read until `warmup()` or the first `route()`.
 * @param {Record<string, any>} config - resolved plugin config (router* keys).
 * @param {{transport?: Function, index?: {dates: string[], vectors: Float32Array[], texts?: string[]}, now?: () => number, readFileImpl?: Function}} [options] - test seams.
 * @returns {any} the router.
 */
export function createRouter(config, options = {}) {
	const transport = options.transport ?? httpTransport;
	// Same-session recent rows are skipped (see setSession below).
	let skipSession = null;
	let skipAfterMs = null;   // same-session rows at/after this time are skipped (see setSession)
	let recentBigrams = [];   // [{set, text}] of the human's latest messages (see setRecentTexts)
	let rowBigrams = [];      // per-row cache, cleared whenever the index reloads

	/** Character bigrams of a text (CJK-friendly, zero dependencies). */
	function bigrams(text) {
	  const s = String(text ?? '').replace(/\s+/g, '');
	  const set = new Set();
	  for (let i = 0; i + 2 <= s.length; i += 1) set.add(s.slice(i, i + 2));
	  return set;
	}

	/** Jaccard overlap of two bigram sets. */
	function jaccard(left, right) {
	  if (left.size === 0 || right.size === 0) return 0;
	  let inter = 0;
	  for (const item of left) if (right.has(item)) inter += 1;
	  return inter / (left.size + right.size - inter);
	}
	// Hot reload: a scheduled rebuild rewrites the index files (atomically). Stat them now
	// and then, so new turns become recallable WITHOUT restarting DSH. An injected index
	// (tests) never reloads, and any failure keeps the table we already have.
	const reloadAfterMs = Number.isFinite(options.reloadAfterMs) ? Number(options.reloadAfterMs) : 30000;
	const statImpl = options.statImpl;
	let indexStamp = null;
	let lastStampCheck = 0;
	async function currentStamp() {
	  try {
	    const base = String(config.routerIndex ?? '');
	    if (base.length === 0) return null;
	    const statSync = statImpl ?? (await import('node:fs')).statSync;
	    const bin = statSync(`${base}.bin`);
	    let meta = null;
	    try { meta = statSync(`${base}_meta.json`); } catch { meta = null; }
	    return `${bin.mtimeMs}:${bin.size}:${meta === null ? 0 : meta.mtimeMs}:${meta === null ? 0 : meta.size}`;
	  } catch { return null; }
	}
	async function maybeReload() {
	  if (options.index !== undefined) return;        // injected index: never reload
	  if (loaded !== true) return;                    // the first read goes through loadIndex()
	  const nowMs = nowFn();
	  if (nowMs - lastStampCheck < reloadAfterMs) return;
	  lastStampCheck = nowMs;
	  const stamp = await currentStamp();
	  if (stamp === null || stamp === indexStamp) return;
	  indexStamp = stamp;
	  loaded = false;                                 // force a re-read on the next line
	  index = undefined;
	}
	const nowFn = options.now ?? (() => Date.now());
	const readFileImpl = options.readFileImpl ?? readFile;
	let index = options.index ?? undefined;
	let loaded = false;
	let lastError;
	let warm = false;

	async function loadIndex() {
		if (loaded) return index;
		// An injected index (tests) skips the disk path, so normalise HERE as well:
		// `dot()` assumes unit vectors and the model output is not unit length.
		if (index !== undefined) {
			index = { dates: index.dates, texts: index.texts, times: index.times, vectors: index.vectors.map((vector) => unit(vector instanceof Float32Array ? vector : Float32Array.from(vector))) };
			loaded = true;
			return index;
		}
		const base = config.routerIndex;
		const meta = JSON.parse(await readFileImpl(`${base}_meta.json`, 'utf8'));
		// NO encoding argument: reading a Float32 blob as 'utf8' mangles every byte
		// above 0x7f, which made the whole corpus score ~0.07 instead of ~0.8.
		const buffer = await readFileImpl(`${base}.bin`);
		const raw = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
		const dim = meta.dim;
		const vectors = [];
		for (let i = 0; i < meta.count; i += 1) {
			const vector = new Float32Array(dim);
			for (let j = 0; j < dim; j += 1) vector[j] = raw.readFloatLE((i * dim + j) * 4);
			// The stored vectors are the model's raw output, which is NOT unit length;
			// `dot()` assumes unit vectors, so normalise here or every score (and the
			// 0.6 threshold) is scaled by an arbitrary magnitude.
			vectors.push(unit(vector));
		}
		let texts;
		let times;
		let sessions;
		if (typeof config.routerCorpus === 'string' && config.routerCorpus.length > 0) {
			try {
				const lines = (await readFileImpl(config.routerCorpus, 'utf8')).split('\n');
				texts = lines.map((line) => { try { return JSON.parse(line).snippet ?? ''; } catch { return ''; } });
				// The corpus rows carry the wall-clock time of the turn; the card shows it so the
				// human can tell WHAT was matched and WHEN (asked 2026-09-30). Same file, same order.
				times = lines.map((line) => { try { return JSON.parse(line).time ?? null; } catch { return null; } });
				// Which session each row came from. The current conversation is already in the model's
				// context, so recalling its own recent turns is pure noise (measured cos 0.947 to a
				// question asked two minutes earlier, 2026-10-01).
				sessions = lines.map((line) => { try { return JSON.parse(line).session ?? null; } catch { return null; } });
			} catch { texts = undefined; }
		}
		index = { dates: meta.dates.map(normDate), vectors, texts, times, sessions };
		indexStamp = await currentStamp();
		rowBigrams = [];
		loaded = true;
		return index;
	}

	async function embed(text) {
		const body = { model: config.routerModel, input: String(text).slice(0, config.routerMaxChars) };
		const response = await transport({ baseUrl: config.routerBaseUrl, path: '/v1/embeddings', body, timeoutMs: config.routerTimeoutMs });
		const vector = response?.data?.[0]?.embedding;
		if (!Array.isArray(vector)) throw new Error('embeddings: no vector in response');
		return vector;
	}

	return {
		/**
		* Remember which session is asking and how far back to ignore it. The service calls
		* this on every pre-step, so automatic recall and the memory_route tool share one rule.
		* @param {string} [sessionId] - the asking session (omitted clears the rule).
		* @param {number} [windowMs] - how recent a same-session row must be to be skipped.
		*/
		setSession(sessionId, windowMs) {
		  skipSession = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null;
		  skipAfterMs = Number.isFinite(windowMs) ? Number(windowMs) : null;
		},

		/**
		* The human's latest messages. A hit that repeats one of them is not a memory — it is
		* the conversation already in front of the model (measured 2026-10-01: top hit was the
		* previous turn at cos 0.99). Excluded by CONTENT, because how much is still in the
		* context window is not knowable from here.
		* @param {string[]} texts - recent human messages, oldest first.
		*/
		setRecentTexts(texts) {
		  recentBigrams = (Array.isArray(texts) ? texts : [])
		    .map((text) => ({ set: bigrams(String(text).slice(0, 400)), text: String(text).replace(/\s+/g, '').slice(0, 200) }))
		    .filter((item) => item.set.size >= 4)
		    .slice(-20);
		},

		get lastError() { return lastError; },
		get ready() { return loaded; },
		get warm() { return warm; },

		/** One cheap call so the model is resident before the human needs it. Silently degrades. */
		async warmup() {
			try {
				await embed('预热');
				warm = true;
				lastError = undefined;
				return true;
			} catch (error) {
				warm = false;
				lastError = String(error?.message ?? error);
				return false;
			}
		},

		/**
		 * Score one message against the corpus.
		 * @param {string} query - the human's message.
		 * @returns {Promise<{verdict: string, reason: string, candidates: any[], costMs: number}|undefined>} undefined on any failure.
		 */
		async route(query) {
			const started = nowFn();
			try {
				await maybeReload();
				const table = await loadIndex();
				const vector = unit(await embed(query));
				const now = nowFn();
				const scored = [];
				for (let i = 0; i < table.vectors.length; i += 1) {
					if (skipSession !== null && table.sessions?.[i] === skipSession) {
					  const at = Number(table.times?.[i]);
					  const cutoff = skipAfterMs ?? now - 43_200_000;      // default: skip the last 12 hours
					  if (Number.isFinite(at) && at >= cutoff) continue;
					}
					const cosine = dot(vector, table.vectors[i]);
					// Skip hits that merely repeat what the human just said: those words are already in
					// front of the model, so recalling them is echoing, not remembering.
					if (recentBigrams.length > 0 && cosine >= 0.5) {
					  const rowText = String(table.texts?.[i] ?? '');
					  const rowSet = rowBigrams[i] ?? (rowBigrams[i] = bigrams(rowText));
					  let echoes = false;
					  for (const recent of recentBigrams) {
					    if (recent.text.length >= 8 && rowText.includes(recent.text)) { echoes = true; break; }
					    if (jaccard(rowSet, recent.set) >= 0.6) { echoes = true; break; }
					  }
					  if (echoes) continue;
					}
					const date = table.dates[i] ?? 'unknown';
					const iso = /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T12:00:00+08:00` : date;
					const days = dayDiff(iso, now);
					// Precision first: the human's labels show today's rows are almost never what they
					// mean by a memory, and cosine alone cannot separate the two classes.
					if (config.routerExcludeToday === true && Number.isFinite(days) && days < 0.5) continue;
					scored.push({ date, cosine, days, score: cosine * Math.exp(-config.routerLambda * days), text: table.texts?.[i] ?? '', time: table.times?.[i] ?? null });
				}
				scored.sort((left, right) => right.score - left.score);
				// Date anchor (2026-10-02): a named day is a strong clue, but only when the message has
				// something to do with that day — dateAnchorOf enforces that with a topical floor.
				const anchor = dateAnchorOf(query, scored, config);
				const top = scored.slice(0, config.routerTopK);
				const best = top[0];
				// Gate on the MOST SIMILAR turn inside the day window — NOT on the top-by-decayed-score
				// row. Using the decayed winner as the relevance gate hid a cos 0.74 match whenever a
				// borderline recent row (cos 0.5996) outranked it, so the whole lookup said `none`
				// (measured 2026-10-01). Decay is for ORDERING; the cosine is for RELEVANCE.
				const inWindow = scored.filter((row) => row.days <= config.routerMaxDays);
				const bestCos = inWindow.reduce((acc, row) => (acc === undefined || row.cosine > acc.cosine ? row : acc), undefined);
				// A message that is essentially ONLY a date has no other clue to rank by, so the day it
				// names may carry the injection alone (measured: "9月18号那天你记得我说过什么吗" was
				// otherwise not found at all).
				const anchorPure = anchor !== null && anchor.mode === 'pure';
				const related = anchorPure || (bestCos !== undefined && bestCos.cosine >= config.routerMinCos);
				const byDate = new Map();
				for (const hit of top) {
					const entry = byDate.get(hit.date) ?? { date: hit.date, days: Math.round(hit.days * 10) / 10, cosine: Math.round(hit.cosine * 1000) / 1000, hits: [] };
					if (entry.hits.length < 2) entry.hits.push({ cosine: Math.round(hit.cosine * 1000) / 1000, text: hit.text.slice(0, 80), time: hit.time ?? null });
					byDate.set(hit.date, entry);
				}
				lastError = undefined;

				// Order only: the anchored day goes first when it earned it (relevance is still the cosine
				// gate). This lifts a real "那个 9 月 18 号的事" from rank 4 to rank 1 without letting an
				// incidental date hijack a message that is actually about something else.
				let ordered = [...byDate.values()];
				if (anchor !== null) {
					const existing = ordered.find((entry) => entry.date === anchor.date);
					const source = scored.find((row) => row.date === anchor.date);
					// The anchored day must carry its OWN words. Three failures measured 2026-10-02:
					// (a) hits: [] rendered as "命中 0 条", which the human cannot judge; (b) picking
					// that day's rows by cosine showed "3吧，是做插件么？" for a query about the
					// control-computer plugin; (c) picking the LONGEST row showed a build-log line.
					// For a contentless "9月13号那天" every corpus row scores about the same, so the
					// corpus is the wrong place to ask "what happened that day" — the tree's own
					// day file already answers it. Read its DAY SUMMARY first (through the injected
					// reader, the same async seam the index uses) and keep a corpus row as backup.
					const dayRows = scored.filter((row) => row.date === anchor.date);
					const byCosine = [...dayRows].sort((a, b) => b.cosine - a.cosine);
					const byLength = [...dayRows].sort((a, b) => String(b.text ?? '').length - String(a.text ?? '').length);
					let summary = '';
					try {
						const dayFile = config.root + '/' + anchor.date.slice(0, 4) + '/' + anchor.date.slice(5, 7) + '/' + anchor.date.slice(8, 10) + '/' + anchor.date + '.md';
						const dayText = await readFileImpl(dayFile, 'utf8');
						const block = String(dayText).match(/DAY SUMMARY[\s\S]{0,2000}/);
						if (block !== null) {
							const line = block[0].split('\n').map((row) => row.trim()).find((row) => /^-\s+\S/.test(row));
							if (line !== undefined) summary = line.replace(/^-\s*/, '').replace(/\*\*/g, '').slice(0, 110);
						}
					} catch { }
					const base = existing ?? {
						date: anchor.date,
						days: Math.round((source?.days ?? 0) * 10) / 10,
						cosine: Math.round(anchor.cosine * 1000) / 1000,
						hits: []
					};
					const hits = [];
					if (summary.length > 0) hits.push({ cosine: Math.round(anchor.cosine * 1000) / 1000, text: summary, time: null });
					for (const row of [...byCosine, ...byLength]) {
						if (hits.length >= 2) break;
						const words = String(row.text ?? '').slice(0, 80);
						if (words.length === 0 || hits.some((hit) => hit.text === words)) continue;
						hits.push({ cosine: Math.round(row.cosine * 1000) / 1000, text: words, time: row.time ?? null });
					}
					const entry = { ...base, hits: hits.slice(0, 2) };
					ordered = [entry, ...ordered.filter((item) => item.date !== anchor.date)];
				}
				return {
					verdict: related ? 'related' : 'none',
					reason: related
						? `best cosine ${bestCos.cosine.toFixed(3)} >= ${config.routerMinCos} and ${bestCos.days.toFixed(1)}d <= ${config.routerMaxDays}d`
						: `best cosine ${(bestCos?.cosine ?? 0).toFixed(3)} / ${(bestCos?.days ?? 0).toFixed(1)}d — below the threshold (cosine >= ${config.routerMinCos}, <= ${config.routerMaxDays}d)`,
					candidates: ordered,
					costMs: nowFn() - started,
					anchor: anchor === null ? null : { date: anchor.date, cosine: Math.round(anchor.cosine * 1000) / 1000, mode: anchor.mode }
				};
			} catch (error) {
				lastError = String(error?.message ?? error);
				return undefined;
			}
		}
	};
}
