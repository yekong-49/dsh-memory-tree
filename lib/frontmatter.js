/**
 * A deliberately small YAML front-matter reader/writer.
 *
 * The tree's headers are flat `key: value` maps written by this plugin and by
 * hand, so a full YAML parser would be a liability (surprising coercions,
 * dependency weight) rather than a help. This module only understands:
 *
 *   ---
 *   key: value
 *   quoted: "value with: a colon"
 *   ---
 *   body...
 *
 * It preserves unknown keys and their original lines, so a hand-added field
 * survives every plugin write.
 */

const DELIMITER = '---';

/**
 * Strip one layer of matching quotes and unescape the result.
 * @param {string} raw - the raw value text.
 * @returns {string} the plain value.
 */
function unquote(raw) {
	const text = raw.trim();
	if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
		return text.slice(1, -1).replace(/\\(["\\])/g, '$1');
	}
	if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
		return text.slice(1, -1).replace(/''/g, "'");
	}
	return text;
}

/**
 * Decide whether a value must be quoted to survive a round trip.
 * @param {string} value - the plain value.
 * @returns {boolean} whether quoting is required.
 */
function needsQuote(value) {
	if (value === '') return true;
	if (value !== value.trim()) return true;
	if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(value)) return true;
	if (/[:#]\s|\s#/.test(value)) return true;
	if (/[\n\r\t]/.test(value)) return true;
	return false;
}

/**
 * Render one scalar for the header.
 * @param {string} value - the plain value.
 * @returns {string} the serialized scalar.
 */
function quote(value) {
	const text = String(value);
	if (!needsQuote(text)) return text;
	return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ')}"`;
}

/**
 * Split a document into its front matter and body.
 * @param {string} text - the whole file.
 * @returns {{entries: Array<{key: string, value: string, raw: string}>, body: string, hasFrontMatter: boolean}} parsed parts.
 */
export function parseFrontMatter(text) {
	const source = typeof text === 'string' ? text.replace(/^\uFEFF/, '') : '';
	const lines = source.split(/\r?\n/);
	if (lines[0]?.trim() !== DELIMITER) {
		return { entries: [], body: source, hasFrontMatter: false };
	}
	const entries = [];
	let end = -1;
	for (let index = 1; index < lines.length; index += 1) {
		const line = lines[index];
		if (line.trim() === DELIMITER) {
			end = index;
			break;
		}
		const match = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
		if (match === null) {
			// A stray line inside the header: keep it byte-for-byte so a
			// hand-written comment is never silently dropped.
			entries.push({ key: `\u0000raw${index}`, value: '', raw: line, opaque: true });
			continue;
		}
		entries.push({ key: match[1], value: unquote(match[2]), raw: line });
	}
	if (end === -1) {
		// Unterminated header: treat the whole file as a body rather than
		// guessing, so we never rewrite a file we do not understand.
		return { entries: [], body: source, hasFrontMatter: false };
	}
	return { entries, body: lines.slice(end + 1).join('\n'), hasFrontMatter: true };
}

/**
 * Read one header value.
 * @param {string} text - the whole file.
 * @param {string} key - the field to read.
 * @returns {string|undefined} the plain value, or `undefined` when absent.
 */
export function frontMatterValue(text, key) {
	const { entries } = parseFrontMatter(text);
	for (const entry of entries) if (entry.key === key) return entry.value;
	return undefined;
}

/**
 * Read every header value as a plain object (opaque lines excluded).
 * @param {string} text - the whole file.
 * @returns {Record<string, string>} the header map.
 */
export function frontMatterMap(text) {
	const output = {};
	for (const entry of parseFrontMatter(text).entries) {
		if (entry.opaque !== true) output[entry.key] = entry.value;
	}
	return output;
}

/**
 * Return a new document with the given header fields set.
 *
 * Existing keys keep their position; new keys are appended at the end of the
 * header. A body without front matter gains one.
 * @param {string} text - the whole file.
 * @param {Record<string, string|number>} values - fields to set.
 * @returns {string} the updated document, with `\n` line endings.
 */
export function setFrontMatter(text, values) {
	const source = typeof text === 'string' ? text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n') : '';
	const { entries, body, hasFrontMatter } = parseFrontMatter(source);
	const pending = new Map(Object.entries(values).map(([key, value]) => [key, String(value)]));
	const rendered = [];
	for (const entry of entries) {
		if (entry.opaque === true) {
			rendered.push(entry.raw);
			continue;
		}
		if (pending.has(entry.key)) {
			rendered.push(`${entry.key}: ${quote(pending.get(entry.key))}`);
			pending.delete(entry.key);
		} else {
			rendered.push(entry.raw);
		}
	}
	for (const [key, value] of pending) rendered.push(`${key}: ${quote(value)}`);
	const header = [DELIMITER, ...rendered, DELIMITER].join('\n');
	if (!hasFrontMatter) {
		const trailing = body.length === 0 ? '' : body.replace(/^\n+/, '');
		return trailing.length === 0 ? `${header}\n` : `${header}\n\n${trailing}`;
	}
	return `${header}\n${body}`;
}
