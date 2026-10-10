/**
 * Filesystem primitives: atomic writes, exclusive creation, appends, and a
 * per-path mutex.
 *
 * Two rules from the tree spec are enforced here:
 *
 *   * **atomic write** — write a temp file in the destination directory, then
 *     rename over the target, so a reader never observes a half-written file.
 *   * **exclusive create** — a template is created with `wx`, so when two
 *     sessions race into the same day exactly one writes the template and the
 *     other observes `EEXIST` and leaves the file alone.
 *
 * `rename` on Windows is `MoveFileEx(MOVEFILE_REPLACE_EXISTING)`, so replacing
 * an existing file is a single atomic step. Antivirus and the search indexer
 * can still hold a transient handle, which is why every replace retries.
 */

import { constants } from 'node:fs';
import { access, appendFile, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { scrubVerified } from './redact.js';

/** Retry budget for a transient Windows sharing violation. */
const REPLACE_ATTEMPTS = 8;

/**
 * Sleep briefly without blocking the event loop for the whole backoff.
 * @param {number} ms - milliseconds to wait.
 * @returns {Promise<void>} resolves after the delay.
 */
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Test whether a path exists.
 * @param {string} path - the path to test.
 * @returns {Promise<boolean>} whether it exists.
 */
export async function exists(path) {
	try {
		await access(path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Read a file, tolerating absence.
 * @param {string} path - the file to read.
 * @returns {Promise<string|undefined>} the text, or `undefined` when absent.
 */
export async function readIfExists(path) {
	try {
		return await readFile(path, 'utf8');
	} catch (error) {
		if (error?.code === 'ENOENT') return undefined;
		throw error;
	}
}

/**
 * Create a directory chain (mkdir -p semantics).
 * @param {string} path - the directory to create.
 * @returns {Promise<boolean>} whether this call created the final component.
 */
export async function ensureDir(path) {
	const before = await exists(path);
	await mkdir(path, { recursive: true });
	return !before;
}

/**
 * Write a file atomically: temp file in the same directory, then rename.
 *
 * Sensitive literals are scrubbed **before** anything reaches the disk (see
 * `redact.js`): this is the tree's single write choke point, so a value that is
 * masked here is never in the tree at all — which is the only version of "remove
 * it" an append-only archive can honour retroactively.
 * @param {string} path - destination file.
 * @param {string} text - full contents.
 * @returns {Promise<{bytes: number, replaced: boolean, redacted: number}>} write outcome.
 */
export async function atomicWrite(path, text) {
	const directory = dirname(path);
	await mkdir(directory, { recursive: true });
	const replaced = await exists(path);
	// Scrub before the temp file exists: a verification failure must leave the
	// destination untouched rather than half-written.
	const scrubbed = scrubVerified(text, path);
	const temp = join(directory, `.${Date.now().toString(36)}-${process.pid.toString(36)}-${Math.random().toString(36).slice(2, 8)}.tmp`);
	const payload = Buffer.from(scrubbed.text, 'utf8');
	try {
		await writeFile(temp, payload);
		let lastError;
		for (let attempt = 0; attempt < REPLACE_ATTEMPTS; attempt += 1) {
			try {
				await rename(temp, path);
				return { bytes: payload.length, replaced, redacted: scrubbed.counts.total };
			} catch (error) {
				lastError = error;
				if (error?.code !== 'EPERM' && error?.code !== 'EBUSY' && error?.code !== 'EACCES') break;
				await sleep(10 * (attempt + 1));
			}
		}
		throw lastError;
	} catch (error) {
		// Leave no temp litter behind on failure.
		await rm(temp, { force: true }).catch(() => {});
		throw error;
	}
}

/**
 * Create a file only if it does not already exist.
 *
 * The template itself is scrubbed too: `createExclusive` writes the file the
 * session will later append to, and a value must not be able to enter the tree by
 * riding in on a template either.
 * @param {string} path - destination file.
 * @param {string} text - full contents.
 * @returns {Promise<'created'|'existed'>} whether this call won the race.
 */
export async function createExclusive(path, text) {
	await mkdir(dirname(path), { recursive: true });
	const scrubbed = scrubVerified(text, path);
	let handle;
	try {
		handle = await open(path, 'wx');
		await handle.writeFile(scrubbed.text, 'utf8');
		return 'created';
	} catch (error) {
		if (error?.code === 'EEXIST') return 'existed';
		throw error;
	} finally {
		await handle?.close().catch(() => {});
	}
}

/**
 * Append lines to a file, opening and closing it for each call.
 *
 * Open-append-close is what makes two sessions appending to the same day file
 * safe: the OS serializes each append, and no buffered writer is left holding
 * state across a crash.
 * @param {string} path - destination file.
 * @param {string|string[]} lines - line(s) to append; a trailing newline is added.
 * @returns {Promise<number>} bytes appended.
 */
export async function appendLines(path, lines) {
	const list = (Array.isArray(lines) ? lines : [lines]).map((line) => String(line).replace(/\r?\n/g, ' '));
	if (list.length === 0) return 0;
	await mkdir(dirname(path), { recursive: true });
	// Scrubbed as one payload rather than per line: a literal can only live on a
	// single line here (newlines were just flattened), and one pass keeps the byte
	// accounting that `scrubVerified` checks exact.
	const payload = scrubVerified(`${list.join('\n')}\n`, path).text;
	await appendFile(path, payload, 'utf8');
	return Buffer.byteLength(payload, 'utf8');
}

/**
 * List a directory, tolerating absence.
 * @param {string} path - directory to list.
 * @returns {Promise<Array<{name: string, isDirectory: boolean, isFile: boolean}>>} entries sorted by name.
 */
export async function listDir(path) {
	try {
		const entries = await readdir(path, { withFileTypes: true });
		return entries
			.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory(), isFile: entry.isFile() }))
			.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	} catch (error) {
		if (error?.code === 'ENOENT') return [];
		throw error;
	}
}

/**
 * Read a file's size in bytes.
 * @param {string} path - the file to stat.
 * @returns {Promise<number|undefined>} the size, or `undefined` when absent.
 */
export async function sizeOf(path) {
	try {
		return (await stat(path)).size;
	} catch (error) {
		if (error?.code === 'ENOENT') return undefined;
		throw error;
	}
}

/**
 * A per-path promise chain that serializes read-modify-write cycles.
 *
 * Without it, two snapshots finishing at the same instant could each read the
 * month file, each add its own row, and the second write would drop the first
 * row. The mutex is in-process only: the atomic rename plus recompute-from-
 * truth roll-ups keep concurrent DSH processes consistent too.
 */
export class PathMutex {
	/** @type {Map<string, Promise<unknown>>} */
	#chains = new Map();

	/**
	 * Run one critical section for a key, after every earlier one settles.
	 * @template T
	 * @param {string} key - the resource key (a file path).
	 * @param {() => Promise<T>} action - the critical section.
	 * @returns {Promise<T>} the action's result.
	 */
	async run(key, action) {
		const previous = this.#chains.get(key) ?? Promise.resolve();
		const current = previous.then(() => action());
		// The stored link never rejects, so a failed action cannot poison the
		// chain for the next waiter.
		const guard = current.then(() => undefined, () => undefined);
		this.#chains.set(key, guard);
		try {
			return await current;
		} finally {
			// Delete only when we are still the tail; a caller that chained
			// while we ran has already replaced the entry.
			if (this.#chains.get(key) === guard) this.#chains.delete(key);
		}
	}
}
