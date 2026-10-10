/**
 * build-corpus.mjs — build the recall corpus and its vector index from the
 * session logs DSH already keeps on disk.
 *
 * The recall path (`lib/router.js`) reads two files:
 *
 *   <corpus>.jsonl   one JSON row per remembered utterance
 *   <index>.bin      Float32 vectors, row-for-row with the corpus
 *   <index>_meta.json  { model, dim, count, dates, builtAt }
 *
 * Nothing writes them for you — this is that writer. Run it once after
 * installing, then on a schedule (see "Scheduling" below).
 *
 * Design notes, each one paid for:
 *
 *  1. **Embedding runs in-process** through the plugin's own
 *     `lib/embed-onnx.js`. An earlier version posted to a local HTTP server,
 *     which meant "scheduled rebuild" also meant "keep that server running" —
 *     a rebuild that silently stops working the moment nobody restarts a
 *     daemon is worse than no rebuild.
 *  2. **Global dedupe** by `time|snippet`. Duplicates dilute recall and make
 *     re-running the builder additive instead of idempotent.
 *  3. **Incremental** when the old `.bin` still lines up row-for-row: only the
 *     new rows are embedded. When it does not line up (e.g. a dedupe pass just
 *     removed rows) it falls back to a full re-encode automatically.
 *  4. **Atomic writes** — `.tmp` then rename. The plugin may be reading at the
 *     instant this runs, and a half-written index is a wrong answer, not an
 *     error.
 *  5. **No new content ⇒ no write.** Leaving mtime alone means the plugin's
 *     own reload logic is never woken for nothing.
 *  6. **Scrub before embedding.** A hit is rendered into a UI card, so an
 *     unscrubbed key inside the corpus is a credential-display channel. The
 *     corpus is rebuilt on a schedule, so deleting a bad line by hand is
 *     useless — the generator has to scrub.
 *
 * What gets indexed: the human's own messages only. Measured on a real
 * session log (83.5 MB decompressed), the split was 1.8% human text, 12.5%
 * assistant text, and 85.7% streaming fragments (`reasoning-chunks`,
 * `assistant/chunk`, `tool-call-chunks`). Indexing the fragments would bury
 * the signal; indexing human turns alone is deliberate.
 *
 * Usage:
 *   node build-corpus.mjs [--dry] [--force]
 *
 *   --dry    report what would change, write nothing
 *   --force  rebuild even when nothing new was found
 *
 * Configuration (env vars, all optional):
 *
 *   MEMORY_TREE_CORPUS   corpus .jsonl path      default <root>/router/corpus.jsonl
 *   MEMORY_TREE_INDEX    index basename (no ext) default <root>/router/index/embed
 *   MEMORY_TREE_MODEL    model id                default bge-small-zh-v1.5-onnx
 *   MEMORY_TREE_ONNX_DIR directory holding the model
 *   MEMORY_TREE_SESSIONS DSH session-log root    default ~/.dsh/sessions
 *   MEMORY_TREE_ROOT     tree root               default ~/DSHMemory
 *
 * `--root <path>` also works and wins over MEMORY_TREE_ROOT.
 *
 * Scheduling: on Windows, a scheduled task every N hours is enough. On POSIX,
 * cron. The script is safe to run concurrently with the plugin: it only ever
 * replaces the index atomically.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { zstdDecompressSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DRY = process.argv.includes('--dry');
const FORCE = process.argv.includes('--force');
const argRoot = (() => {
	const i = process.argv.indexOf('--root');
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : '';
})();

const ROOT = argRoot || process.env.MEMORY_TREE_ROOT || path.join(os.homedir(), 'DSHMemory');
const DATA_DIR = process.env.MEMORY_TREE_DATA_DIR || path.join(ROOT, 'router');
const CORPUS = process.env.MEMORY_TREE_CORPUS || path.join(DATA_DIR, 'corpus.jsonl');
const INDEX = process.env.MEMORY_TREE_INDEX || path.join(DATA_DIR, 'index', 'embed');
const MODEL = process.env.MEMORY_TREE_MODEL || 'bge-small-zh-v1.5-onnx';
const ONNX_DIR = process.env.MEMORY_TREE_ONNX_DIR || path.join(ROOT, 'models');
const SESSIONS = process.env.MEMORY_TREE_SESSIONS || path.join(os.homedir(), '.dsh', 'sessions');
const BATCH = 32;

/** zstd frame magic. DSH appends one frame per line, so a log is many frames. */
const MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

/** Format a millisecond timestamp as the local `yyyy-mm-dd`. */
const dayText = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: process.env.MEMORY_TREE_TZ || 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const mmdd = (ms) => dayText(ms).slice(5);
const isImageRow = (snippet) => /^\[图片 sha256:|^\[image sha256:/i.test(String(snippet ?? '').trim());
const keyOf = (row) => String(row?.time ?? '') + '|' + String(row?.snippet ?? '').slice(0, 160);

/**
 * Write a file by replacing it, never by truncating it in place.
 * @param {string} target - destination path.
 * @param {string|Buffer} data - what to write.
 */
function writeAtomic(target, data) {
	fs.mkdirSync(path.dirname(target), { recursive: true });
	const tmp = target + '.tmp';
	fs.writeFileSync(tmp, data);
	fs.renameSync(tmp, target);
}

/**
 * Mask secrets and identifying values BEFORE they enter the corpus.
 *
 * A corpus row is shown to the human in a recall card, so anything left here
 * is a disclosure channel — and because the corpus is regenerated on a
 * schedule, hand-deleting one bad row accomplishes nothing.
 *
 * Loopback and private ranges are deliberately KEPT: they carry meaning and
 * are not reachable from outside.
 *
 * @param {string} text - the raw snippet.
 * @returns {string} the masked snippet.
 */
function scrub(text) {
	return String(text ?? '')
		.replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED-KEY]')
		.replace(/apikey[_\-]?[A-Za-z0-9\-_]{6,}/gi, '[REDACTED-KEY]')
		.replace(/\bapi[_-]?key\b\s*[:=]\s*["']?[^\s"',}]{4,}/gi, '[REDACTED-KEY]')
		.replace(/\bBearer\s+[A-Za-z0-9._-]{12,}/gi, 'Bearer [REDACTED]')
		.replace(/\b[0-9a-fA-F]{32}\b/g, '[REDACTED]')
		.replace(/\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g,
			(m) => (/^(?:127\.|0\.0\.0\.0$|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(m) ? m : '[REDACTED-IP]'));
}

/**
 * Split a multi-frame zstd log into its frames and decompress each one.
 *
 * This is NOT `zstdDecompressSync(buf)`: that stops at the first frame, and a
 * DSH log is one frame per appended line (measured: 82,309 frames in a 36 MB
 * log). Passing the whole buffer returns just the session header — a silent
 * 178-byte "success" that looks like the log is empty.
 *
 * @param {Buffer} buf - the whole log.
 * @returns {string} the concatenated decompressed text.
 */
function decompressFrames(buf) {
	const offsets = [];
	let at = 0;
	while ((at = buf.indexOf(MAGIC[0], at)) !== -1) {
		if (buf[at + 1] === MAGIC[1] && buf[at + 2] === MAGIC[2] && buf[at + 3] === MAGIC[3]) offsets.push(at);
		at += 4;
	}
	const parts = [];
	for (let i = 0; i < offsets.length; i += 1) {
		const end = i + 1 < offsets.length ? offsets[i + 1] : buf.length;
		try { parts.push(zstdDecompressSync(buf.subarray(offsets[i], end)).toString('utf8')); } catch { /* a truncated final frame */ }
	}
	return parts.join('');
}

/** Embed texts in batches through the plugin's in-process ONNX transport. */
async function embedAll(texts, transport) {
	const vectors = [];
	for (let i = 0; i < texts.length; i += BATCH) {
		const response = await transport({ baseUrl: 'local', path: '/v1/embeddings', body: { model: MODEL, input: texts.slice(i, i + BATCH) }, timeoutMs: 120000 });
		if (!response?.data) throw new Error('embedding failed at batch ' + i);
		for (const item of response.data) vectors.push(item.embedding);
		process.stdout.write('    ' + Math.min(i + BATCH, texts.length) + '/' + texts.length + '\r');
	}
	return vectors;
}

(async () => {
	console.log('语料: ' + CORPUS);
	console.log('索引: ' + INDEX + '.bin');
	console.log('会话: ' + SESSIONS);

	const old = fs.existsSync(CORPUS)
		? fs.readFileSync(CORPUS, 'utf8').trim().split('\n').map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean)
		: [];
	const seen = new Set();
	const kept = [];
	let droppedDup = 0;
	let droppedImage = 0;
	for (const row of old) {
		if (isImageRow(row.snippet)) { droppedImage += 1; continue; }
		const key = keyOf(row);
		if (seen.has(key)) { droppedDup += 1; continue; }
		seen.add(key);
		kept.push({ seq: row.seq ?? null, time: row.time ?? null, date: row.date ?? null, snippet: row.snippet, session: row.session ?? null, context_before: [], context_after: [] });
	}
	console.log('  旧语料 ' + old.length + ' 条 ⇒ 去重 ' + droppedDup + ' / 图片 ' + droppedImage + ' ⇒ 保留 ' + kept.length);

	// Discover session logs. Prefer the newest format when both exist: they are
	// the same conversation, and indexing both would double every turn.
	const found = [];
	(function walk(dir, depth) {
		if (depth > 4) return;
		let items = [];
		try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
		for (const it of items) {
			if (!it.isDirectory()) continue;
			const p = path.join(dir, it.name);
			for (const name of ['session.v4.jsonl.zstd', 'session.jsonl.zstd']) {
				const f = path.join(p, name);
				if (fs.existsSync(f)) { found.push({ id: it.name, f }); break; }
			}
			walk(p, depth + 1);
		}
	})(SESSIONS, 0);
	console.log('  会话日志: ' + found.length + ' 份');

	const turns = [];
	const sessionByTime = new Map();
	let skipped = 0;
	for (const session of found) {
		let buf;
		try { buf = fs.readFileSync(session.f); } catch { continue; }
		for (const line of decompressFrames(buf).split('\n')) {
			if (!line.trim()) continue;
			let event;
			try { event = JSON.parse(line); } catch { continue; }
			if (event.type !== 'user/message') continue;
			// The message is FLATTENED into `data` (content/source/role/id), not `data.message`.
			const message = event.data ?? {};
			// `source.kind === 'user'` excludes the plugin's own injected notes —
			// those are our text, not the human's, and indexing them makes recall
			// score our own reminders against themselves.
			if (message.source?.kind !== 'user') { skipped += 1; continue; }
			const body = (Array.isArray(message.content) ? message.content : [])
				.filter((part) => part?.type === 'text')
				.map((part) => String(part.text ?? '')).join(' ').replace(/\s+/g, ' ').trim();
			if (body.length === 0) continue;
			const ms = Number(event.time);
			const turn = {
				seq: event.seq ?? null,
				time: Number.isFinite(ms) ? ms : null,
				date: Number.isFinite(ms) ? mmdd(ms) : null,
				snippet: scrub(body).slice(0, 220),
				session: session.id
			};
			turns.push(turn);
			if (turn.time !== null) sessionByTime.set(String(turn.time), session.id);
		}
	}
	console.log('  真人发言: ' + turns.length + ' 条（跳过插件注记 ' + skipped + ' 条）');

	let added = 0;
	for (const row of turns) {
		if (isImageRow(row.snippet)) continue;
		const key = keyOf(row);
		if (seen.has(key)) continue;
		seen.add(key);
		kept.push({ seq: row.seq, time: row.time, date: row.date, snippet: row.snippet, session: row.session ?? null, context_before: [], context_after: [] });
		added += 1;
	}
	console.log('  合并后: ' + kept.length + ' 条（新增 ' + added + '）');

	// Backfill the session id: rows carried over from an older corpus have no
	// session field, but their timestamp identifies one now that the logs are read.
	let backfilled = 0;
	for (const row of kept) {
		if (row.session) continue;
		const hit = row.time === null ? undefined : sessionByTime.get(String(row.time));
		if (hit) { row.session = hit; backfilled += 1; }
	}
	if (backfilled > 0) console.log('  回填 session: ' + backfilled + ' 行');

	if (added === 0 && droppedDup === 0 && droppedImage === 0 && !FORCE) {
		console.log('  没有新内容 ⇒ 不写文件（不惊动热重载）');
		return;
	}
	if (DRY) { console.log('  --dry：只报告，不写'); return; }

	const metaPath = INDEX + '_meta.json';
	const binPath = INDEX + '.bin';
	let dim = 512;
	let meta = {};
	try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); dim = meta.dim ?? 512; } catch { }
	const oldVectors = [];
	try {
		const raw = fs.readFileSync(binPath);
		const count = Math.floor(raw.length / 4 / dim);
		for (let i = 0; i < count; i += 1) {
			const vector = new Float32Array(dim);
			for (let j = 0; j < dim; j += 1) vector[j] = raw.readFloatLE((i * dim + j) * 4);
			oldVectors.push(vector);
		}
	} catch { }
	const preExisting = kept.length - added;
	const reusable = oldVectors.length > 0 && oldVectors.length === preExisting;
	console.log('  旧向量 ' + oldVectors.length + ' 条 ⇒ ' + (reusable ? '复用 ' + preExisting + ' 条，只编码新增 ' + added + ' 条' : '行序对不上 ⇒ 全量重编码 ' + kept.length + ' 条'));

	// Resolve the plugin's own transport by relative path, so the builder works
	// from any checkout instead of only from the machine it was written on.
	const here = path.dirname(fileURLToPath(import.meta.url));
	const embedPath = path.join(here, '..', 'lib', 'embed-onnx.js');
	let createOnnxTransport;
	try {
		({ createOnnxTransport } = await import(pathToFileURL(embedPath).href));
	} catch (error) {
		console.log('  ✗ 找不到 lib/embed-onnx.js（' + embedPath + '）：' + String(error.message).slice(0, 80));
		console.log('    这个脚本要放在插件的 scripts/ 目录下运行。');
		process.exitCode = 1;
		return;
	}

	// ── 先体检模型，因为不体检时的报错完全指不到地方 ──
	// 没有这一段时，模型缺失会表现成一句被截断的加载器英文
	// （"`local_files_only=true` or `env.allowRemoteModels=false` and…"），
	// 紧接着 HTTP 兜底也失败、抛一个裸的 ECONNREFUSED 栈 —— 两句话都没说清"它去哪找了"。
	// 所以这里直接点名路径与缺失的文件，任一步都不再往下走。
	const modelRoot = path.join(ONNX_DIR, MODEL);
	const modelFiles = [['config.json'], ['tokenizer.json'], ['vocab.txt'], ['onnx', 'model_quantized.onnx']];
	const missing = modelFiles.filter((part) => !fs.existsSync(path.join(modelRoot, ...part)));
	const filesAreMissing = missing.length > 0;

	if (filesAreMissing) {
		console.log('');
		console.log('✗ 找不到嵌入模型 —— 算不了向量，因此【没有写任何文件】。');
		console.log('');
		console.log(`  我在这里找：${modelRoot}`);
		if (!fs.existsSync(ONNX_DIR)) {
			console.log(`  连 ${ONNX_DIR} 这个目录都不存在。`);
		} else if (!fs.existsSync(modelRoot)) {
			console.log(`  ${ONNX_DIR} 存在，但里面【没有 ${MODEL} 这个文件夹】。`);
		} else {
			console.log(`  ${modelRoot} 存在，但缺这些文件：`);
			for (const part of missing) console.log(`    · ${part.join('/')}`);
		}
		console.log('');
		console.log('  怎么修：把模型文件夹放成下面这个样子——');
		console.log(`    ${modelRoot}\\`);
		console.log('      config.json   tokenizer.json   tokenizer_config.json');
		console.log('      special_tokens_map.json   vocab.txt');
		console.log('      onnx\\model_quantized.onnx');
		console.log('');
		console.log('  模型放在别处也行，但要告诉脚本它在哪（注意：指向的是【含 ');
		console.log(`  ${MODEL} 的那一层】，不是它本身）：`);
		console.log('    跑本脚本时  →  设环境变量 MEMORY_TREE_ONNX_DIR=<那一层>');
		console.log('    插件运行时  →  改 profile 的 cordis.patch.yml 里的 routerOnnxDir');
		console.log('');
		if (fs.existsSync(ONNX_DIR)) {
			const siblings = fs.readdirSync(ONNX_DIR, { withFileTypes: true })
				.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
			console.log(`  线索：${ONNX_DIR} 下面现在有这些子目录——`);
			if (siblings.length === 0) console.log('    （空的）');
			else for (const name of siblings) console.log(`    · ${name}`);
			console.log('    如果模型是【多套了一层目录】或者【名字不一样】，看这几行就知道了。');
		}
		process.exitCode = 1;
		return;
	}

	const onnx = createOnnxTransport({ onnxDir: ONNX_DIR, onnxModel: MODEL });
	let transport = onnx;
	try {
		await onnx({ baseUrl: 'local', path: '/v1/embeddings', body: { model: MODEL, input: '预热' }, timeoutMs: 120000 });
		console.log(`  嵌入: 进程内 ONNX ✓（${modelRoot}）`);
	} catch (error) {
		console.log(`  ⚠ 进程内 ONNX 加载失败（模型在 ${modelRoot}）`);
		console.log(`    ${String(error?.message ?? error).slice(0, 300)}`);
		console.log('    ⇒ 试试 HTTP 兜底 127.0.0.1:1234（需要一个 OpenAI 兼容的嵌入服务在跑）');
		transport = async (request) => {
			const response = await fetch('http://127.0.0.1:1234/v1/embeddings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request.body) });
			if (!response.ok) throw new Error('http ' + response.status);
			return await response.json();
		};
		// 先证明兜底真的能用，再让几百行数据走它 ——
		// 否则连接错误会在几分钟后才出现，而且长成一次崩溃的样子。
		try {
			await transport({ baseUrl: 'local', path: '/v1/embeddings', body: { model: MODEL, input: '预热' }, timeoutMs: 5000 });
			console.log('    HTTP 兜底可用 ✓');
		} catch (fallbackError) {
			console.log('');
			console.log('✗ 两条路都不通 —— 【没有写任何文件】。');
			console.log('  · 进程内 ONNX：模型文件在，但加载失败。上面那行是原始报错，常见两种原因——');
			console.log('      ① 依赖没装：本目录缺 node_modules（跑 npm install / pnpm install）');
			console.log('      ② 模型文件不完整或被截断（对照发布方的 sha256 重量一遍）');
			console.log('  · HTTP 兜底：127.0.0.1:1234 上没有 OpenAI 兼容的嵌入服务');
			console.log('');
			console.log('  推荐用进程内 ONNX（不依赖任何常驻服务）—— 先看①。');
			process.exitCode = 1;
			return;
		}
	}

	const started = Date.now();
	const vectors = reusable ? oldVectors.slice() : [];
	const freshTexts = reusable ? kept.slice(preExisting).map((row) => row.snippet) : kept.map((row) => row.snippet);
	if (freshTexts.length > 0) {
		// Catch it here rather than letting it escape as an unhandled rejection:
		// a raw stack trace at this point reads as "the script is broken", when the
		// actual message is almost always about the model or the encoding service.
		let embedded;
		try {
			embedded = await embedAll(freshTexts, transport);
		} catch (error) {
			console.log('');
			console.log(`✗ 编码 ${freshTexts.length} 条时失败 —— 【没有写任何文件】，语料与索引都保持原样。`);
			console.log(`    ${String(error?.message ?? error).slice(0, 300)}`);
			console.log('');
			console.log('  已处理的条目不受影响；修好之后重跑即可（幂等）。');
			process.exitCode = 1;
			return;
		}
		for (const vector of embedded) vectors.push(vector);
	}
	dim = vectors[0]?.length ?? dim;
	console.log('');
	console.log('  ✓ 向量齐备: ' + vectors.length + ' × ' + dim + '，用时 ' + (Date.now() - started) + ' ms');

	const buffer = Buffer.alloc(vectors.length * dim * 4);
	vectors.forEach((vector, i) => { for (let j = 0; j < dim; j += 1) buffer.writeFloatLE(vector[j] ?? 0, (i * dim + j) * 4); });
	if (fs.existsSync(binPath) && !fs.existsSync(binPath + '.v1.bak')) fs.copyFileSync(binPath, binPath + '.v1.bak');
	writeAtomic(binPath, buffer);
	writeAtomic(metaPath, JSON.stringify({ model: MODEL, dim, count: vectors.length, dates: kept.map((row) => row.date), builtAt: new Date().toISOString(), builtBy: 'build-corpus.mjs' }));
	writeAtomic(CORPUS, kept.map((row) => JSON.stringify(row)).join('\n') + '\n');
	console.log('  ✓ 已写入（原子替换）: ' + binPath + '  ' + buffer.length + ' B');
	console.log('  ✓ 语料 ' + kept.length + ' 条  ' + fs.statSync(CORPUS).size + ' B');
	const last = kept[kept.length - 1];
	console.log('  ✓ 最后一条: [' + last.date + '] ' + String(last.snippet).slice(0, 60));
})();
