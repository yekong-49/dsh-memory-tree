/**
 * The per-turn mechanical log: one line per turn, zero model calls.
 *
 * Spec (`<MEMORY_ROOT>\index.md`):
 *   `时间戳 | 轮次 | +token | 改动的文件 | 一句话`
 *
 * Rendered as a row in the day file's append-only TURN LOG region. The turn
 * cell carries the owning session (`T12·deadbeef`) so a hook that fires twice
 * for one turn — a resumed session, a replayed seed — can be deduplicated
 * exactly instead of appending the same line again.
 *
 * Nothing here calls a model. Everything is derived from session events that
 * are already in memory, which is what keeps "record every turn" affordable.
 */

import { appendRegion, regionText } from './sentinel.js';
import { readIfExists, atomicWrite } from './atomic.js';
import { cell, TURNLOG_REGION } from './templates.js';
import { fileLabel, formatDelta } from './events.js';
import { setFrontMatter } from './frontmatter.js';

/**
 * Render the deduplication marker for one turn.
 * @param {number} turn - turn number.
 * @param {string} sessionToken - short session token.
 * @returns {string} the marker text to search for.
 */
export function turnMarker(turn, sessionToken) {
	return `| T${turn}·${sessionToken} |`;
}

/**
 * Render one turn-log table row.
 * @param {{clock: string, turn: number, sessionToken: string, delta: number|undefined, files: string[], headline: string}} input - row fields.
 * @returns {string} the Markdown table row.
 */
export function turnRow({ clock, turn, sessionToken, delta, files, headline }) {
	return `| ${cell(clock)} | T${turn}·${sessionToken} | ${cell(formatDelta(delta))} | ${cell(fileLabel(files), 90)} | ${cell(headline, 100)} |`;
}

/**
 * Append one turn row to a day file's TURN LOG region.
 *
 * Read-modify-write under a caller-supplied mutex, then a single atomic
 * replace, so concurrent turns on the same day cannot interleave. The row is
 * skipped when the marker is already present, which makes the whole operation
 * idempotent.
 * @param {{dayFile: string, row: string, marker: string, mutex: {run: (key: string, action: () => Promise<any>) => Promise<any>}, stamp?: string}} input - write request.
 * @returns {Promise<'appended'|'duplicate'|'missing'>} the outcome.
 */
export async function appendTurnRow({ dayFile, row, marker, mutex, stamp }) {
	return mutex.run(dayFile, async () => {
		const current = await readIfExists(dayFile);
		if (current === undefined) return 'missing';
		const existing = regionText(current, TURNLOG_REGION);
		if (existing.includes(marker)) return 'duplicate';
		let { text, appended } = appendRegion(current, TURNLOG_REGION, row);
		if (appended === 0) return 'duplicate';
		// Keep `updated:` honest: it should name the last write of ANY kind. It
		// used to move only on a snapshot, so a day whose only activity was turns
		// claimed it had not been touched since the previous snapshot — visible
		// in the live tree, where the log ran to 05:00 while `updated` said 04:47.
		if (typeof stamp === 'string' && stamp.length > 0) text = setFrontMatter(text, { updated: stamp });
		await atomicWrite(dayFile, text);
		return 'appended';
	});
}
