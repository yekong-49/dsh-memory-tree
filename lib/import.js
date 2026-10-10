/**
 * Reading DSH's own session logs, so history can be replayed into the tree.
 *
 * A memory tree only knows what happened while it was running. On a machine with
 * months of conversation on disk, a fresh install therefore starts empty. The
 * logs are still there — this module turns them back into an event stream the
 * snapshot pipeline already understands.
 *
 * Everything here is pure file reading and shaping. Nothing writes.
 *
 * @module dsh-memory-tree/import
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

/** zstd frame magic (`28 b5 2f fd`). */
const MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

/**
 * Event types worth keeping.
 *
 * A DSH log is mostly streaming fragments — measured on one real session, the
 * split was 85.7% `reasoning-chunks` / `assistant/chunk` / `tool-call-chunks`
 * against 1.8% human text. Those fragments are the message being typed out
 * piece by piece; the finished `assistant/message` already contains the result,
 * so keeping the chunks would multiply the tree's size by ~6 for no content.
 *
 * These four are exactly what `projectEvent` understands, so the reader and the
 * snapshot writer agree by construction.
 */
const KEEP = new Set(['user/message', 'assistant/message', 'tool/call', 'tool/result']);

/**
 * Split a multi-frame zstd log into frames and decompress each one.
 *
 * NOT `zstdDecompressSync(wholeFile)`. DSH appends one frame per line, so a log
 * is tens of thousands of concatenated frames; the one-shot call stops at the
 * first and returns just the session header — a 178-byte "success" on a 36 MB
 * file, indistinguishable from an empty log. That mistake silently produced a
 * corpus with zero rows and looked like it had worked.
 *
 * @param {Buffer} buffer - the whole log file.
 * @returns {string} the concatenated decompressed text.
 */
export function decompressFrames(buffer) {
	const offsets = [];
	let at = 0;
	while (at < buffer.length) {
		const hit = buffer.indexOf(MAGIC[0], at);
		if (hit === -1) break;
		if (buffer[hit + 1] === MAGIC[1] && buffer[hit + 2] === MAGIC[2] && buffer[hit + 3] === MAGIC[3]) offsets.push(hit);
		at = hit + 4;
	}
	const parts = [];
	for (let i = 0; i < offsets.length; i += 1) {
		const end = i + 1 < offsets.length ? offsets[i + 1] : buffer.length;
		try {
			parts.push(zstdDecompressSync(buffer.subarray(offsets[i], end)).toString('utf8'));
		} catch {
			// A final partial frame is normal after an unclean shutdown; the rest of
			// the log is still good, so skip rather than abandon the session.
		}
	}
	return parts.join('');
}

/**
 * Find the session logs under a DSH sessions directory.
 *
 * Prefers the newest format when several exist for one session: they are the
 * same conversation at different schema versions, and reading two would record
 * every turn twice.
 *
 * @param {string} root - the sessions directory.
 * @param {number} [maxDepth] - how deep to walk.
 * @returns {Array<{id: string, file: string}>} one entry per session.
 */
export function discoverSessionLogs(root, maxDepth = 4) {
	const found = [];
	(function walk(dir, depth) {
		if (depth > maxDepth) return;
		let items = [];
		try { items = readdirSync(dir, { withFileTypes: true }); } catch { return; }
		for (const item of items) {
			if (!item.isDirectory()) continue;
			const child = join(dir, item.name);
			for (const name of ['session.v4.jsonl.zstd', 'session.v3.jsonl.zstd', 'session.jsonl.zstd']) {
				const file = join(child, name);
				if (existsSync(file)) { found.push({ id: item.name, file }); break; }
			}
			walk(child, depth + 1);
		}
	})(root, 0);
	return found;
}

/**
 * Read one session log into an event stream the snapshot pipeline can consume.
 *
 * @param {string} file - the log path.
 * @returns {{id: string, cwd: string|undefined, events: any[], firstTime: number, lastTime: number}|undefined} the parsed session, or `undefined` when nothing usable was found.
 */
export function readSessionLog(file) {
	let buffer;
	try { buffer = readFileSync(file); } catch { return undefined; }
	const text = decompressFrames(buffer);
	let id;
	let cwd;
	const events = [];
	let firstTime = 0;
	let lastTime = 0;
	for (const line of text.split('\n')) {
		if (line.length === 0) continue;
		let event;
		try { event = JSON.parse(line); } catch { continue; }
		if (event.type === 'session') {
			id = id ?? event.id;
			cwd = cwd ?? event.cwd;
			continue;
		}
		if (!KEEP.has(event.type)) continue;
		events.push(event);
		const ms = Number(event.time);
		if (Number.isFinite(ms) && ms > 0) {
			if (firstTime === 0 || ms < firstTime) firstTime = ms;
			if (ms > lastTime) lastTime = ms;
		}
	}
	if (events.length === 0) return undefined;
	return { id, cwd, events, firstTime, lastTime };
}

/**
 * The local calendar days a session's turns started in.
 *
 * Keyed on the TURN's timestamp, not the reply's — the same rule the tree uses
 * everywhere, so a message sent at 23:50 and answered at 00:10 lands on the day
 * it was sent rather than the day it finished.
 *
 * @param {any[]} events - the session's events.
 * @param {(epochMs: number) => string} dayOf - epoch → `yyyy-mm-dd`.
 * @returns {string[]} distinct dates, in order.
 */
export function daysOfTurns(events, dayOf) {
	const seen = new Set();
	for (const event of events) {
		const ms = Number(event.time);
		if (!Number.isFinite(ms) || ms <= 0) continue;
		seen.add(dayOf(ms));
	}
	return [...seen].sort();
}

/**
 * The highest `seq` in a log, which is what a snapshot's `toSeq` must clear.
 * @param {any[]} events - the session's events.
 * @returns {number} the maximum seq, or 0.
 */
export function maxSeq(events) {
	let max = 0;
	for (const event of events) {
		const seq = Number(event.seq);
		if (Number.isFinite(seq) && seq > max) max = seq;
	}
	return max;
}
