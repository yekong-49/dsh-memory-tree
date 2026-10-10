/**
 * The media archive: images that appeared in a conversation, kept beside the
 * day they belong to.
 *
 * Layout — `media/` sits INSIDE the day directory, next to the day file and its
 * snapshots, so drilling into a day puts its images right there:
 *
 *     <root>/<yyyy>/<mm>/<dd>/media/2026-09-13T055105-T42-deadbeef-a1b2c3d4.png
 *
 * That directory name is not accidental. Both of the tree's enumerations
 * whitelist NUMERIC directory names (`#subdirs` filters `/^\d{2,4}$/`,
 * `treeOverview` uses YEAR/MONTH/DAY regexes) and the search path builds its
 * file list by concatenation rather than readdir, so `media` is never scanned,
 * never searched and never rolled up — the same property that makes
 * `_bootstrap` safe at the tree root. Two tests pin it.
 *
 * The name carries the whole provenance: date-time (so lexicographic order is
 * chronological, matching every other file in the tree), the turn `T<n>`, the
 * session token, and the first 8 hex digits of the attachment's sha256. A file
 * moved out of its directory still says which conversation and which turn it
 * came from.
 * @module dsh-memory-tree/media
 */
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { joinPath, localParts, nodePaths } from './paths.js';

/** Directory name holding one day's images. */
export const MEDIA_DIR = 'media';

/** Media types this archive will keep, mapped to their file extension. */
const EXTENSIONS = Object.freeze({
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/webp': 'webp',
	'image/gif': 'gif'
});

/**
 * File extension for one media type.
 * @param {string} mediaType - the MIME type.
 * @returns {string} the extension, or `bin` for anything unexpected.
 */
export function extensionFor(mediaType) {
	return EXTENSIONS[mediaType] ?? 'bin';
}

/**
 * The directory holding one day's archived images.
 * @param {string} root - the tree root.
 * @param {string} dateText - `yyyy-mm-dd`.
 * @returns {string} the absolute path.
 */
export function mediaDir(root, dateText) {
	return joinPath(root, ...dateText.split('-'), MEDIA_DIR);
}

/**
 * The sha256 part of a durable attachment id, or an empty string.
 * @param {any} attachment - the `ImageAttachmentRef`.
 * @returns {string} hex digits, without the `sha256:` prefix.
 */
export function sha256Of(attachment) {
	const id = String(attachment?.attachmentId ?? '');
	return id.startsWith('sha256:') ? id.slice('sha256:'.length) : '';
}

/**
 * Build the archive file name for one image.
 *
 * Zero-padded and pure ASCII so lexicographic order is chronological, matching
 * the naming rule every other file in the tree follows.
 * @param {{ stamp: string, turn?: number, sessionToken?: string, attachment: any }} input - naming inputs.
 * @returns {string} the file name.
 */
export function mediaFileName({ stamp, turn, sessionToken, attachment }) {
	// `stamp` is `yyyy-mm-dd HH:MM:SS +08:00`; the tree's own convention keeps
	// the date and time joined by `T` in file names.
	const [date, time] = String(stamp).split(' ');
	const clock = (time ?? '00:00:00').replace(/:/g, '');
	const parts = [`${date}T${clock}`];
	if (typeof turn === 'number') parts.push(`T${turn}`);
	if (typeof sessionToken === 'string' && sessionToken.length > 0) parts.push(sessionToken);
	const digest = sha256Of(attachment).slice(0, 8);
	if (digest.length > 0) parts.push(digest);
	return `${parts.join('-')}.${extensionFor(attachment?.mediaType)}`;
}

/**
 * Keep one image under its day, unless that image is already archived.
 *
 * Deduplication is by sha256 prefix across the whole day: the attachment store
 * is content-addressed, so the same screenshot committed twice is the same
 * image, and it should not occupy two files just because two turns mentioned
 * it. A day's media directory is small (tens of entries), so the scan is
 * cheaper than maintaining a separate index that could drift.
 * @param {{ root: string, dateText: string, stamp: string, turn?: number, sessionToken?: string, attachment: any, sourcePath: string }} input - the archive request.
 * @returns {Promise<{status: 'copied'|'present'|'unavailable', file?: string, path?: string, bytes?: number}>} the outcome.
 */
export async function archiveImage({ root, dateText, stamp, turn, sessionToken, attachment, sourcePath }) {
	const digest = sha256Of(attachment).slice(0, 8);
	if (digest.length === 0) return { status: 'unavailable' };
	if (typeof sourcePath !== 'string' || sourcePath.length === 0) return { status: 'unavailable' };
	const dir = mediaDir(root, dateText);
	// Reuse any file already holding this image, whatever turn named it first.
	const existing = await findById(dir, digest);
	if (existing !== undefined) return { status: 'present', file: existing.file, path: existing.path, bytes: existing.bytes };
	const file = mediaFileName({ stamp, turn, sessionToken, attachment });
	const target = join(dir, file);
	try {
		await mkdir(dir, { recursive: true });
		await copyFile(sourcePath, target);
		const info = await stat(target);
		return { status: 'copied', file, path: target, bytes: info.size };
	} catch (error) {
		return { status: 'unavailable', file, error: String(error) };
	}
}

/**
 * Find an already-archived image by its sha256 prefix.
 * @param {string} dir - the day's media directory.
 * @param {string} digest - the 8-hex-digit prefix.
 * @returns {Promise<{file: string, path: string, bytes: number}|undefined>} the hit, if any.
 */
async function findById(dir, digest) {
	if (!existsSync(dir)) return undefined;
	let names;
	try {
		names = await readdir(dir);
	} catch {
		return undefined;
	}
	const hit = names.find((name) => name.includes(`-${digest}.`) || name.includes(`-${digest}`));
	if (hit === undefined) return undefined;
	const path = join(dir, hit);
	try {
		const info = await stat(path);
		return info.isFile() ? { file: hit, path, bytes: info.size } : undefined;
	} catch {
		return undefined;
	}
}

/**
 * List one day's archived images, in name order.
 * @param {string} dir - the day's media directory.
 * @returns {Promise<Array<{file: string, bytes: number, turn?: number, sessionToken?: string, digest?: string}>>} the entries.
 */
export async function listMedia(dir) {
	if (!existsSync(dir)) return [];
	let names;
	try {
		names = await readdir(dir);
	} catch {
		return [];
	}
	const entries = [];
	for (const file of names.sort()) {
		if (file.startsWith('.')) continue;
		try {
			const info = await stat(join(dir, file));
			if (!info.isFile()) continue;
			entries.push({ file, bytes: info.size, ...parseMediaName(file) });
		} catch {
			// A file that vanished mid-scan is simply not listed.
		}
	}
	return entries;
}

/**
 * Recover provenance from an archive file name.
 *
 * Parsing the name back is what keeps the index derived rather than stored: the
 * MEDIA table can be recomputed from the directory at any time, so a lost or
 * corrupted table heals itself on the next write, exactly like the roll-ups.
 * @param {string} file - the file name.
 * @returns {{turn?: number, sessionToken?: string, digest?: string}} whatever the name encodes.
 */
export function parseMediaName(file) {
	const base = file.replace(/\.[^.]+$/, '');
	const parts = base.split('-');
	const turnPart = parts.find((part) => /^T\d+$/.test(part));
	const digest = /^[0-9a-f]{8}$/.test(parts.at(-1) ?? '') ? parts.at(-1) : undefined;
	// Layout: <date>T<clock>-T<turn>-<session>-<digest>; the session token is the
	// part between the turn and the digest when both are present.
	const turnIndex = parts.indexOf(turnPart ?? '');
	const sessionToken = turnIndex >= 0 && parts.length > turnIndex + 1 && parts[turnIndex + 1] !== digest
		? parts[turnIndex + 1]
		: undefined;
	return {
		turn: turnPart === undefined ? undefined : Number(turnPart.slice(1)),
		sessionToken,
		digest
	};
}

/**
 * Timestamp text for one moment, without the timezone suffix.
 * @param {Date} [when] - the moment.
 * @param {string} [timezone] - IANA zone.
 * @returns {string} `yyyy-mm-dd HH:MM:SS`.
 */
export function stampNow(when = new Date(Date.now()), timezone = 'Asia/Shanghai') {
	return localParts(when, timezone).stamp;
}

/**
 * The day directory that owns one date, for callers that need the parent.
 * @param {string} root - the tree root.
 * @param {string} dateText - `yyyy-mm-dd`.
 * @returns {string} the absolute day directory.
 */
export function dayDir(root, dateText) {
	return nodePaths(root, dateText).dayDir ?? joinPath(root, ...dateText.split('-'));
}
