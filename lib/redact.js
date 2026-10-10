/**
 * Sensitive-literal scrubbing, applied at the tree's write boundary.
 *
 * Why here rather than only in the summarizer prompt: a prompt is advisory (a
 * model can ignore it, and the mechanical turn log never goes through a model at
 * all), while this is a property of the tree. The human's rule is
 * 「写入那一刻就删除或屏蔽」— the tree is append-only, so a value written once can
 * never be taken back; scrubbing *before the first write* is the only point where
 * "never in the tree" is still true. A cleanup pass afterwards is a rewrite of
 * history, which the tree was explicitly designed not to need.
 *
 * The patterns are deliberately narrow. A false positive here silently corrupts
 * an archive meant to be permanent, so every rule has to be a shape that cannot
 * be ordinary prose:
 *
 *   * `id`  — 32 consecutive hex digits: QQ openid / peerId.
 *   * `ip`  — a routable IPv4. Loopback, the wildcard and the RFC1918 ranges are
 *     left alone on purpose: they carry meaning in this tree (the cloud
 *     instance's private NIC, the home LAN) and are not reachable from outside.
 *   * `key` — the `sk-…` API-key shape.
 *
 * **What is NOT matched, on purpose:** a QQ AppID is a bare 10-digit number, and
 * scrubbing every 10-digit run would destroy dates, byte counts, ports and
 * sequence numbers. Numeric AppIDs therefore cannot be caught by shape; keep
 * them out of the tree at the source. This limit is written down so nobody
 * "fixes" it into a rule that eats the archive.
 *
 * ⚠ The `ip` pattern is duplicated verbatim in the generator-side cleanup script
 * (the one-off cleanup pass that already ran). The writer and the re-scan tool
 * must agree on the shape, or a re-scan reports residue that the writer considers
 * clean. Change one, change the other.
 */

/**
 * Every rule: a name for the report, the marker that replaces a match, and the
 * pattern. Object.freeze'd because a stray write to a shared regex's `lastIndex`
 * is exactly the kind of bug that makes a scrubber silently skip a file.
 * @type {ReadonlyArray<{name: string, mark: string, pattern: RegExp}>}
 */
export const REDACT_RULES = Object.freeze([
	Object.freeze({
		name: 'id',
		mark: '[REDACTED]',
		pattern: /(?<![0-9A-Fa-f])[0-9A-F]{32}(?![0-9A-Fa-f])/g
	}),
	Object.freeze({
		name: 'ip',
		mark: '[REDACTED-IP]',
		pattern: /(?<![\d.])(?!127\.0\.0\.1|0\.0\.0\.0|255\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?![\d.])/g
	}),
	Object.freeze({
		name: 'key',
		mark: '[REDACTED-KEY]',
		pattern: /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{16,}(?![A-Za-z0-9_-])/g
	})
]);

/**
 * Extensions whose contents are text and therefore get scrubbed when they are
 * copied into the recovery bundle. Binaries (images, archives) are copied
 * untouched: a byte-for-byte asset must stay byte-for-byte.
 */
const SCRUBBABLE = /\.(md|markdown|txt|text|json|jsonl|ndjson|ya?ml|toml|ini|conf|cfg|properties|env|sh|bash|zsh|ps1|psm1|cmd|bat|js|mjs|cjs|ts|tsx|jsx|py|rb|rs|go|java|c|h|cpp|cs|php|sql|html?|xml|css|scss|csv|tsv|log|patch|diff|gitignore|npmrc)$/i;

/**
 * Whether a file's contents can be scrubbed as text.
 * @param {string} path - the file path.
 * @returns {boolean} true when the extension marks a text asset.
 */
export function isScrubbablePath(path) {
	return SCRUBBABLE.test(path);
}

/**
 * Count what a rule set would replace, without building the result.
 * @param {string} text - the text to inspect.
 * @returns {{id: number, ip: number, key: number, total: number}} per-rule counts.
 */
export function countSensitive(text) {
	const counts = { id: 0, ip: 0, key: 0, total: 0 };
	for (const rule of REDACT_RULES) {
		rule.pattern.lastIndex = 0;
		let match;
		let n = 0;
		while ((match = rule.pattern.exec(text)) !== null) {
			n += 1;
			// A zero-length match would spin forever; none of the rules can produce
			// one, but the guard costs nothing and this runs on every write.
			if (match.index === rule.pattern.lastIndex) rule.pattern.lastIndex += 1;
		}
		counts[rule.name] = n;
		counts.total += n;
	}
	return counts;
}

/**
 * Replace every sensitive literal with its marker.
 *
 * Returns `delta` — the exact net byte-length change the replacements imply —
 * so a caller can *prove* nothing else moved: `after - before === delta` fails
 * if any other byte changed, which is what makes this safe to run over files the
 * tree treats as append-only. (Re-running the same pattern to "verify" would
 * just repeat the same mistake, whatever it was.)
 * @param {string} text - the text to scrub.
 * @returns {{text: string, counts: {id: number, ip: number, key: number, total: number}, delta: number}} the scrubbed text and what changed.
 */
export function scrubText(text) {
	let out = text;
	let delta = 0;
	const counts = { id: 0, ip: 0, key: 0, total: 0 };
	for (const rule of REDACT_RULES) {
		rule.pattern.lastIndex = 0;
		out = out.replace(rule.pattern, (match) => {
			counts[rule.name] += 1;
			counts.total += 1;
			delta += rule.mark.length - match.length;
			return rule.mark;
		});
	}
	return { text: out, counts, delta };
}

/**
 * Scrub, then assert the result differs from the input only by the recorded
 * replacements. Throws instead of writing when any invariant fails — a corrupted
 * write into an append-only tree is worse than a failed one.
 * @param {string} text - the text to scrub.
 * @param {string} label - what to name in the error (a path, for the operator).
 * @returns {{text: string, counts: {id: number, ip: number, key: number, total: number}, delta: number}} the verified result.
 */
export function scrubVerified(text, label) {
	const result = scrubText(text);
	if (result.total === 0) return result;
	if (result.text.split('\n').length !== text.split('\n').length) {
		throw new Error(`redact: line count changed while scrubbing ${label}`);
	}
	const remaining = countSensitive(result.text);
	if (remaining.total !== 0) {
		throw new Error(`redact: ${remaining.total} hit(s) survived scrubbing ${label}`);
	}
	const actual = Buffer.byteLength(result.text, 'utf8') - Buffer.byteLength(text, 'utf8');
	if (actual !== result.delta) {
		throw new Error(`redact: byte delta ${actual} != expected ${result.delta} while scrubbing ${label}`);
	}
	return result;
}
