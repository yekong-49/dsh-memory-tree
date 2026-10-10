/**
 * Sentinel regions: the boundary between machine-owned and hand-written text.
 *
 * Two regions exist in the tree, with different mutability contracts:
 *
 *   MACHINE ROLLUP   recomputable — replaced wholesale from tree truth on
 *                    every snapshot. Its content is a pure function of the
 *                    snapshot files and each node's own `summary:` field, so
 *                    a lost or duplicated table row self-heals.
 *   TURN LOG         append-only — one mechanical line per turn. Never
 *                    recomputed, because the individual turns are not
 *                    reconstructable from anything cheaper than the session
 *                    logs, and losing them would lose history.
 *
 * Everything OUTSIDE a region is hand-written and is never touched by this
 * plugin. An absent region is created (appended at the end of the file)
 * rather than approximated, so an older file upgrades in place.
 */

/**
 * Build the pair of marker lines for a region.
 * @param {string} name - region name, e.g. `MACHINE ROLLUP`.
 * @returns {{begin: string, end: string}} the marker lines.
 */
function markers(name) {
	if (!/^[A-Z][A-Z0-9 _-]*$/.test(name)) throw new TypeError(`memory-tree: invalid region name ${JSON.stringify(name)}`);
	return { begin: `<!-- BEGIN ${name} -->`, end: `<!-- END ${name} -->` };
}

/**
 * Locate a region in a document.
 * @param {string} text - the whole file.
 * @param {string} name - region name.
 * @returns {{found: boolean, inner: string, beginEnd: number, endStart: number}} the region, or `found: false` when absent/malformed.
 */
export function readRegion(text, name) {
	const source = typeof text === 'string' ? text : '';
	const { begin, end } = markers(name);
	const beginIndex = source.indexOf(begin);
	if (beginIndex === -1) return { found: false, inner: '', beginEnd: -1, endStart: -1 };
	const beginEnd = beginIndex + begin.length;
	const endIndex = source.indexOf(end, beginEnd);
	if (endIndex === -1) return { found: false, inner: '', beginEnd, endStart: -1 };
	return { found: true, inner: source.slice(beginEnd, endIndex), beginEnd, endStart: endIndex };
}

/**
 * Read a region's inner text.
 * @param {string} text - the whole file.
 * @param {string} name - region name.
 * @returns {string} trimmed inner text, or an empty string when absent.
 */
export function regionText(text, name) {
	return readRegion(text, name).inner.trim();
}

/**
 * Replace a region's inner content, preserving everything outside it.
 *
 * When the region is absent the whole block is appended after the existing
 * body, so hand-written content stays above the machine block.
 * @param {string} text - the whole file.
 * @param {string} name - region name.
 * @param {string} inner - the new inner text (may be multi-line; trimmed).
 * @returns {string} the updated document with `\n` line endings.
 */
export function replaceRegion(text, name, inner) {
	const source = typeof text === 'string' ? text.replace(/\r\n/g, '\n') : '';
	const { begin, end } = markers(name);
	const body = String(inner ?? '').replace(/\r\n/g, '\n').replace(/^\n+|\n+$/g, '');
	const region = `${begin}\n${body.length === 0 ? '' : `${body}\n`}${end}`;
	const found = readRegion(source, name);
	if (!found.found) {
		const trimmed = source.replace(/\n+$/, '');
		return trimmed.length === 0 ? `${region}\n` : `${trimmed}\n\n${region}\n`;
	}
	return `${source.slice(0, found.beginEnd)}\n${body.length === 0 ? '' : `${body}\n`}${source.slice(found.endStart)}`;
}

/**
 * Append lines to the end of a region's existing content.
 *
 * Append-only by construction: existing lines are never reordered or
 * rewritten, so the region is a durable log. An absent region is created.
 * @param {string} text - the whole file.
 * @param {string} name - region name.
 * @param {string|string[]} lines - line(s) to append; blank lines are dropped.
 * @param {{dropMatching?: RegExp}} [options] - optional filter applied to existing content.
 * @returns {{text: string, appended: number}} the updated document and how many lines were added.
 */
export function appendRegion(text, name, lines, options = {}) {
	const source = typeof text === 'string' ? text.replace(/\r\n/g, '\n') : '';
	const additions = (Array.isArray(lines) ? lines : [lines])
		.map((line) => String(line).replace(/\r?\n/g, ' ').trimEnd())
		.filter((line) => line.trim().length > 0);
	if (additions.length === 0) return { text: source, appended: 0 };
	const current = readRegion(source, name);
	const existing = current.found ? current.inner.replace(/^\n+|\n+$/g, '') : '';
	let kept = existing;
	if (options.dropMatching instanceof RegExp && existing.length > 0) {
		kept = existing
			.split('\n')
			.filter((line) => !options.dropMatching.test(line))
			.join('\n')
			.replace(/\n+$/, '');
	}
	const merged = kept.length === 0 ? additions.join('\n') : `${kept}\n${additions.join('\n')}`;
	return { text: replaceRegion(source, name, merged), appended: additions.length };
}

/**
 * Test whether a document already contains a region.
 * @param {string} text - the whole file.
 * @param {string} name - region name.
 * @returns {boolean} whether the region is present and well formed.
 */
export function hasRegion(text, name) {
	return readRegion(text, name).found;
}
