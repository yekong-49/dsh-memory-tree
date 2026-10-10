/**
 * embed-onnx.js —— **进程内**嵌入（transformers.js + 本地 ONNX 模型目录）。
 *
 * 为什么要它（2026-10-01 实测）：原来的 transport 是往 `127.0.0.1:1234` 发 HTTP，
 * 那个服务寄生在 LM Studio / Bionic 里。**那个应用一关，召回就整条静默失效** ✗ ——
 * 界面上只显示"召回 0 · 注入 0"，看起来像"没有相关记忆"，实际是"根本没在工作"。
 * 进程内跑就没有这个依赖：不占显存、不需要任何 GUI、DSH 一起来就能用。
 *
 * 与 HTTP 路线的等价性（同一天实测，同样两个查询）：
 *   · 「想搞个多卡平台跑本地 ai」     Bionic 0.810 / top 09-30  ⇒  本模块 0.800 / top 09-30 ✓
 *   · 「双卡互联跑模型吃卡间通信吗」 Bionic 0.909 / top 10-01  ⇒  本模块 0.906 / top 10-01 ✓
 *   · 用时 2~6 ms（比走 HTTP 还快，因为没有网络往返）
 * 关键点：**pooling 必须是 CLS**（不是 mean）✓，模型用 `dtype:'q8'`（24 MB 那份 ✓）。
 *
 * 契约与 httpTransport **完全一致**：收 `{ baseUrl, path, body, timeoutMs }`，
 * 返 `{ data: [{ embedding: number[] }] }` ⇒ router.js 不需要认识 ONNX。
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * @param {{onnxDir?: string, onnxModel?: string, importImpl?: Function}} [config] - 本地模型位置（目录 + 子目录名）。
 * @returns {Function} 与 httpTransport 同形状的 transport；失败会把原因留在 `transport.lastError` 上。
 */
export function createOnnxTransport(config = {}) {
	const state = { pipe: undefined, loading: undefined, lastError: undefined, calls: 0, failures: 0 };
	const dir = config.onnxDir;
	const model = config.onnxModel ?? 'bge-small-zh-v1.5-onnx';

	async function load() {
		if (state.pipe !== undefined) return state.pipe;
		if (state.loading !== undefined) return state.loading;
		state.loading = (async () => {
			if (typeof dir !== 'string' || dir.length === 0) throw new Error('onnx: routerOnnxDir is not configured');
			// Resolved from THIS file, so it is the plugin's own dependency.
			const transformers = await (config.importImpl ?? (() => import('@huggingface/transformers')))();
			const { pipeline, env } = transformers;
			// Strictly offline: never reach for the Hub at runtime.
			env.allowRemoteModels = false;
			env.allowLocalModels = true;
			env.localModelPath = dir;
			const pipe = await pipeline('feature-extraction', model, { dtype: 'q8', local_files_only: true });
			state.pipe = pipe;
			state.lastError = undefined;
			return pipe;
		})();
		try {
			return await state.loading;
		} catch (error) {
			state.loading = undefined;
			state.lastError = String(error?.message ?? error);
			throw error;
		}
	}

	/** Same contract as httpTransport: request in, OpenAI-shaped embeddings response out. */
	async function transport(request) {
		const rawInput = request?.body?.input;
		// One string OR a batch. A batch MUST stay a batch: turning it into one string
		// silently produced one vector per 32 rows (measured 2026-10-01: 1307 rows -> 41).
		const texts = Array.isArray(rawInput) ? rawInput.map((item) => String(item)) : [String(rawInput ?? '')];
		state.calls += 1;
		try {
			const pipe = await load();
			// CLS pooling + L2 normalise — this is what the measured equivalence was verified with.
			const output = await pipe(texts.length === 1 ? texts[0] : texts, { pooling: 'cls', normalize: true });
			const dims = Array.isArray(output?.dims) ? output.dims : [];
			const width = dims.length >= 2 ? dims[dims.length - 1] : (output?.data?.length ?? 0);
			const flat = output?.data ?? [];
			if (width === 0 || flat.length === 0) throw new Error('onnx: empty embedding');
			const data = texts.map((_, i) => ({ embedding: Array.from(flat.slice(i * width, (i + 1) * width)), index: i, object: 'embedding' }));
			return { data };
		} catch (error) {
			state.failures += 1;
			state.lastError = String(error?.message ?? error);
			throw error;
		}
	}

	Object.defineProperty(transport, 'lastError', { get: () => state.lastError, enumerable: false });
	Object.defineProperty(transport, 'stats', { get: () => ({ calls: state.calls, failures: state.failures, loaded: state.pipe !== undefined }), enumerable: false });
	transport.modelPath = path.join(dir ?? '', model);
	transport.offline = true;
	return transport;
}

export const __moduleUrl = pathToFileURL(import.meta.url).href;
