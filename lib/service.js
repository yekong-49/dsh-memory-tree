/**
 * The memory service: trigger detection, the snapshot pipeline, and the
 * per-turn mechanical log.
 *
 * Pipeline for one snapshot (never blocking the agent loop):
 *
 *   1. ensure the date's node chain exists (lazy, bottom-up)
 *   2. write the verbatim snapshot        ← durable first, before any model call
 *   3. call 1: slice → the day's gist + prose
 *   4. call 2: child gists → month + year + long-term gists
 *   5. recompute every roll-up table from the filesystem
 *
 * Steps 3-5 are best-effort: a failure costs prose, never the authoritative
 * verbatim record, and the next snapshot tries again.
 *
 * The service is deliberately conservative about *when* it fires — a token
 * threshold above 500k, a compaction boundary, an explicit request, or an
 * optional turn cadence — because each snapshot costs two model calls.
 */

import { appendTurnRow, turnMarker, turnRow } from './turnlog.js';
import {
	appendDaySummary,
	collectLongtermRows,
	collectMonthRows,
	collectYearRows,
	ensureNode,
	listSnapshots,
	readNodeSummary,
	recomputeRollups,
	SNAPSHOT_RE,
	writeNodeSummary
} from './tree.js';
import { assertRootForPlatform, DEFAULT_ROOT, isRecordableDate, joinPath, levelPath, localParts, nodePaths, pad, sessionToken } from './paths.js';
import { mkdirSync, appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRouter, httpTransport } from './router.js';
import { createOnnxTransport } from './embed-onnx.js';
import { scrubText } from './redact.js';
import { atomicWrite, listDir, PathMutex, readIfExists } from './atomic.js';
import { setFrontMatter } from './frontmatter.js';
import { DAY_SUMMARY_REGION, MEDIA_REGION, parseDaySummary, PLACEHOLDER, renderMedia, TURNLOG_REGION } from './templates.js';
import { regionText, replaceRegion } from './sentinel.js';
import { archiveImage, listMedia, mediaDir } from './media.js';
import { defaultDshHome } from './backup.js';
import { stampSnapshotSummary, writeSnapshot } from './snapshot.js';
import { runCall, summarizeDay, summarizeUpper, truncate, windowSlice } from './summarize.js';
import { imagesIn, messageText, turnSlice } from './events.js';
import { detectSignal, reminderText } from './reminder.js';
import { daysOfTurns, discoverSessionLogs, maxSeq, readSessionLog } from './import.js';

/** Triggers that are recorded in a snapshot name and header. */
export const SNAPSHOT_TRIGGERS = Object.freeze(['pressure', 'compaction', 'manual', 'turns', 'import']);

/** Default configuration for the service. */
export const DEFAULT_CONFIG = Object.freeze({
	// Platform-aware, and shared with `paths.js` instead of duplicated: when the
	// two copies drifted there was no way to notice, and the duplicated literal
	// was the Windows path on every platform.
	root: DEFAULT_ROOT,
	timezone: 'Asia/Shanghai',
	enabled: true,
	turnLog: true,
	// Window-relative trigger: the fraction of the context window at which a
	// snapshot starts. The harness compacts at ~80%, so 0.5 leaves ~30% of the
	// window as headroom to summarize before the context is pruned — and it
	// scales by itself when the routed model's window is not 1M.
	snapshotTriggerRatio: 0.5,
	// Absolute fallback for when the window is not known yet (before the first
	// `request/context` event). Also serves as a floor: see `thresholdFor`.
	snapshotTriggerTokens: 500_000,
	// How far the context must GROW beyond the last snapshot before pressure
	// fires again. Without this the pressure test is a STATE test, and a state
	// that a snapshot cannot change stays true forever: measured live at 22
	// snapshots in 25 minutes. This is the event side of the same rule.
	snapshotGrowthTokens: 100_000,
	minSnapshotIntervalMs: 60_000,
	compactionTrigger: true,
	snapshotOnTurns: 0,
	maxSliceBytes: 4 * 1024 * 1024,
	maxInputChars: 120_000,
	// Output budget per summary call. Generous on purpose: this route is a
	// REASONING model, so thinking is charged against the same budget as the
	// answer. At 3000 a long think consumed the lot and the call ended with
	// `finish: max-tokens` and no text at all — a day silently got no summary,
	// leaving only a W line in the log.
	maxTokens: 8_000,
	timeoutMs: 180_000,
	rollup: true,
	// The day's event list is append-only, so a runaway model cannot erase the
	// day — but it could still bury it. These bound ONE snapshot's contribution:
	// at most this many new entries, each at most this many characters.
	// `dayEntryMax` was 4 until the first live run after the rewrite, where a
	// 389-event slice produced six legitimate, distinct entries and two were
	// dropped. A cap that discards real events is the same failure this whole
	// design exists to prevent, so it now guards against a runaway answer rather
	// than rationing a busy day. Anything dropped is reported as
	// `summary.dropped`, so the loss is visible rather than silent.
	dayEntryMax: 8,
	dayEntryChars: 400,
	// How many recent entries are shown to the entry call so it can avoid
	// repeating what is already recorded. Cheap: entries are one line each.
	dayEntryRecent: 12,
	// 2026-09-30 改为 true：**子代理的活也要进树**。此前为 false 时，"用本地模型做的那批工作"
	// （记忆检索、embedding 评测）恰好都跑在被委派的子会话里，而父会话只记自己的轮次
	// ⇒ 那批工作被静默丢掉（实测：一次子代理会话跑了 272 个事件、用的是本地模型，树里一个字都没有）。
	// 想要旧行为：在插件配置里写 `includeSubagents: false` 即可（resolveConfig 认这个键）。
	includeSubagents: true,
	// ── 自动总结归纳的总开关（2026-09-30，用户要求能在界面上关掉）──────────
	// false ⇒ 不再自动做压力/压缩/轮次快照（省掉每轮两次模型调用），但**机械流水照记**
	// （每轮一行、零模型调用），手动 memory_snapshot 仍然可用。运行时可切（工具 memory_auto）。
	autoSummary: true,
	// ── 本地小模型召回（2026-09-30 加）──────────────────────────────────────
	// 消息 → bge 编码 → 与语料余弦 × 日期衰减 → 判定"有关/无关" ⇒ 注入候选日期给 agent 自己判断。
	// 实测每轮约 5 ms（编码 ~3 ms + 扫 1005 条 ~2 ms），模型常驻几十 MB。
	router: true,
	routerBaseUrl: 'http://127.0.0.1:1234',
	routerModel: 'text-embedding-bge-small-zh-v1.5',
	routerIndex: '',
	routerCorpus: '',
	routerDataDir: '',
	routerTopK: 5,
	routerMinCos: 0.7,
	routerMaxDays: 7,
	routerLambda: 0.1,
	routerMaxChars: 500,
	routerTimeoutMs: 120_000,
	routerInject: true,
	routerMinGapTurns: 2,
	routerWarmup: true,
	routerKeepAliveMs: 300_000,
	// Where the embedding runs. 'onnx' = in-process (transformers.js + a local ONNX dir ⇒
	// no LM Studio/Bionic process needed, nothing to silently die). 'http' = the old
	// local-server route. 'auto' = ONNX first, HTTP as the safety net (default).
	routerTransport: 'auto',
	routerOnnxDir: '',
	routerOnnxModel: 'bge-small-zh-v1.5-onnx',
	// Recall must not echo the conversation already in context: rows from the current
	// session inside this window are skipped (default 30 minutes).
	// Fallback when the last compaction snapshot cannot be found: skip the session's own
	// rows from the last 12 hours (a 1M-token window keeps far more than that verbatim).
	routerExcludeSameSessionMs: 43_200_000,
	// The human's own judgements say today's chatter is not a memory (6 of 8 not_relevant
	// rows had today as the top date, 2026-10-01) ⇒ only hits at least half a day old fire.
	// NOT enabled: the 18 human labels give this dimension AUC 0.537 ≈ no signal (2026-10-01).
	// One line away if a quieter recall is preferred — but that would be a taste, not evidence.
routerExcludeToday: false,
	// Below this cosine the turn is not worth asking about (no card, no options).
	routerPickFloor: 0.5,
	// Client hot-reload: when true, the injected boot-time script also pulls a FRESH copy
	// from /dsh-memory/client.js and takes over if it is newer (so client edits need no
	// restart). Fail-safe: if that fetch fails, the boot-time copy keeps running.
	clientHotReload: false,
	// Context-only turns ("继续", "重启了", "按你的想法") carry no retrievable intent of their own,
	// so ANY recall hit against them is noise — measured 2026-10-01: 4 of 4 injected recalls on
	// such turns were judged wrong. Skip recall for them entirely (the human's own observation).
	routerSkipContextOnly: true,
	// Date anchor (2026-10-02): if the message names a day AND that day is topically related
	// (cosine >= routerDateAnchorMinCos), put it first. If the message is essentially ONLY a
	// date ("那天我说过什么"), the date is the sole clue and may inject on its own.
	routerDateAnchor: true,
	routerDateAnchorMinCos: 0.60,
	routerDateAnchorPureChars: 6,
	readMaxChars: 24_000,
	// When the human reaches back to earlier work, append one reminder naming
	// the memory tools. Phrase detection only — no model call, no file read.
	reminderOn: true,
	// Turns to stay quiet after one reminder, so a follow-up turn that repeats
	// the same phrase does not stack reminders into the request.
	reminderMinGapTurns: 3,
	// Copy every image a turn produced into that day's `media/` directory and
	// refresh its index. The tree is the durable side of an attachment: the
	// harness store can be wiped or rebuilt, the archive is ours.
	mediaArchive: true,
	// Where the DSH state directory lives. Only the asset backup needs it, and it
	// is derived from the home directory, so a fresh install needs no config.
	dshHome: defaultDshHome()
});

/**
 * Resolve user configuration over the defaults, rejecting nonsense early.
 * @param {Record<string, unknown>|undefined} raw - the plugin configuration.
 * @returns {typeof DEFAULT_CONFIG} the resolved configuration.
 */
/**
 * Read a session's durable, append-only event log.
 *
 * The accessor is VERSION-DEPENDENT, and the difference was silent:
 *   · `dsh-session@0.1.2-rc.1` exposes `snapshotEvents()`.
 *   · `dsh-session@0.1.0-rc.7` has no such method; it exposes the `events` getter
 *     (`get events() { return Object.freeze([...this.log]) }`) with `seq` defined
 *     as `log.length` — the documented `seq = log.length` contiguity contract —
 *     so it is the same complete log, and the same thing this plugin needs.
 *
 * The previous guard was `typeof session.snapshotEvents === 'function' ? … : []`,
 * and on rc.7 it took the EMPTY BRANCH. That is not a fallback, it is silent data
 * loss: every turn logged the placeholder headline, every snapshot was built from
 * zero events, and `memory_snapshot` answered `empty` forever — while the tree
 * looked healthy from the outside, because files were being written.
 *
 * Why no test caught it: every fixture in this suite implemented `snapshotEvents`
 * itself, so the test double and the implementation shared one wrong assumption
 * about the host's shape. A fake that invents the API it is standing in for
 * cannot falsify anything.
 * @param {any} session - the session.
 * @returns {readonly unknown[]} the event log, or an empty array when the session exposes neither accessor.
 */
export function sessionEvents(session) {
	if (typeof session?.snapshotEvents === 'function') return session.snapshotEvents();
	if (Array.isArray(session?.events)) return session.events;
	return [];
}

export function resolveConfig(raw) {
	const config = { ...DEFAULT_CONFIG };
	for (const [key, value] of Object.entries(raw ?? {})) {
		if (!(key in DEFAULT_CONFIG)) continue;
		config[key] = value;
	}
	config.root = String(config.root ?? DEFAULT_CONFIG.root);
	if (config.root.trim().length === 0) throw new TypeError('memory-tree: root must not be empty');
	// Fail at LOAD time, not at write time. A Windows-shaped root on POSIX does
	// not fail — it writes the whole tree into flat files whose names contain
	// backslashes, leaving the configured root empty. That happened on a Linux
	// host, and nothing anywhere reported it; only the absence of files did.
	assertRootForPlatform(config.root);
	config.dshHome = String(config.dshHome ?? DEFAULT_CONFIG.dshHome);
	if (config.dshHome.trim().length === 0) throw new TypeError('memory-tree: dshHome must not be empty');
	// Recall data is rooted under the tree by default, so a fresh install needs no
	// path configuration at all: `scripts/build-corpus.mjs` writes exactly these
	// locations, and its own defaults agree with the ones below. An empty string
	// means "use the derived default", so the shipped patch can leave them blank
	// and still end up with working paths.
	const rootTail = config.root.replace(/[\\/]+$/, '');
	if (config.routerDataDir === '') config.routerDataDir = joinPath(rootTail, 'router');
	if (config.routerCorpus === '') config.routerCorpus = joinPath(config.routerDataDir, 'corpus.jsonl');
	if (config.routerIndex === '') config.routerIndex = joinPath(config.routerDataDir, 'index', 'embed');
	if (config.routerOnnxDir === '') config.routerOnnxDir = joinPath(rootTail, 'models');
	config.snapshotTriggerRatio = ratio(config.snapshotTriggerRatio, 'snapshotTriggerRatio');
	config.snapshotTriggerTokens = positive(config.snapshotTriggerTokens, 'snapshotTriggerTokens');
	config.snapshotGrowthTokens = positive(config.snapshotGrowthTokens, 'snapshotGrowthTokens');
	config.minSnapshotIntervalMs = positive(config.minSnapshotIntervalMs, 'minSnapshotIntervalMs', 0);
	config.snapshotOnTurns = positive(config.snapshotOnTurns, 'snapshotOnTurns', 0);
	config.maxSliceBytes = positive(config.maxSliceBytes, 'maxSliceBytes');
	config.maxInputChars = positive(config.maxInputChars, 'maxInputChars');
	config.maxTokens = positive(config.maxTokens, 'maxTokens');
	config.timeoutMs = positive(config.timeoutMs, 'timeoutMs');
	config.readMaxChars = positive(config.readMaxChars, 'readMaxChars');
	config.reminderMinGapTurns = positive(config.reminderMinGapTurns, 'reminderMinGapTurns', 0);
	config.dayEntryMax = positive(config.dayEntryMax, 'dayEntryMax');
	config.dayEntryChars = positive(config.dayEntryChars, 'dayEntryChars');
	config.dayEntryRecent = positive(config.dayEntryRecent, 'dayEntryRecent', 0);
	config.routerTopK = positive(config.routerTopK, 'routerTopK');
	config.routerMaxDays = positive(config.routerMaxDays, 'routerMaxDays', 0);
	config.routerLambda = positive(config.routerLambda, 'routerLambda', 0);
	config.routerMaxChars = positive(config.routerMaxChars, 'routerMaxChars');
	config.routerTimeoutMs = positive(config.routerTimeoutMs, 'routerTimeoutMs');
	config.routerMinGapTurns = positive(config.routerMinGapTurns, 'routerMinGapTurns', 0);
	config.routerKeepAliveMs = positive(config.routerKeepAliveMs, 'routerKeepAliveMs', 0);
	config.routerMinCos = ratio(config.routerMinCos, 'routerMinCos');
	return config;
}

/**
 * Validate a fraction-of-the-window setting.
 * @param {unknown} value - candidate.
 * @param {string} label - field name.
 * @returns {number} the validated ratio.
 */
/** The text of the last human message in a pre-step payload, if any. */
function lastUserText(messages) {
	if (!Array.isArray(messages)) return undefined;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.source?.kind !== 'user') continue;
		const content = message.content;
		if (typeof content === 'string') return content;
		if (!Array.isArray(content)) continue;
		const text = content.filter((part) => part?.type === 'text').map((part) => String(part.text ?? '')).join(' ').trim();
		if (text.length > 0) return text;
	}
	return undefined;
}

/** The one injected note: candidate days, how they scored, and how to read them. */
/** The texts of the last few human messages: "do not recall what was just said". */
/** Phrases that only continue or acknowledge the conversation (no intent of their own), plus a
 * very short-message rule. Kept deliberately narrow: a false negative costs one silent turn,
 * while a false positive would suppress a genuine recall. Every skip is logged to
 * router/skipped.jsonl so the rule itself can be audited and tuned (2026-10-01). */
const CONTEXT_ONLY_RE = /^(好的?|行|嗯+|哦+|可以|行吧|好吧|继续|继续吧|接着|接着来|来吧|走起|重启了?|重载了?|开了|好了|收到|明白|懂了|谢谢|多谢|辛苦|就这样|就这么办|按你的想法|按你说的|你来定|你决定|随便|都行|都听你的|没问题|ok|okay)[。！!，,、.…~～\s]*$/i;
const CONTEXT_ONLY_HINT_RE = /[?？]|怎么|为什么|为啥|要不要|是不是|该不该|哪个|哪些|是否|如何|多少|能不能|可不可以/;
/** Questions about the PRESENT state ("现在还能用么", "还好吗", "正常吗"). The tree only holds past
 * events, so any hit against one of these is guaranteed wrong — such a question must be answered
 * by CHECKING (the way computer_state answered "插件现在还能用么" on 2026-10-02), not by recall.
 * Deliberately only the *status* phrasings: a bare "现在" is too weak — "那个显卡现在还值得买吗"
 * is a real question whose answer may well be in the tree, and must NOT be skipped. */
const PRESENT_STATE_RE = /还能用|还能跑|还好吗|还好么|还在吗|还在不在|正常吗|正不正常|怎么样了|怎么样|状态如何|有没有坏|可靠吗/;
/** Imperative requests to DO something ("帮我打开…", "把 X 删了", "重启一下"). The tree holds
 * events, not actions it can perform, so the closest a hit can get is a shared generic noun —
 * the human's own words: "能关联到对应的，但是感觉是关键字" (2026-10-03, after a card offered
 * 「隔壁搞铁锈AI控制…」 and 「在E盘下新建文件夹…」 for "帮我把铁锈AI控制的所在文件夹打开下").
 * Skipped unless the message also points at the past or asks for content. */
const ACTION_REQUEST_RE = /^(请|麻烦|帮我|帮忙|给我|你去|你能不能|能不能|可以|先去)?\s*(把|将|打开|关闭|关掉|删除|删掉|去掉|改|修改|加上|添加|跑|运行|执行|启动|重启|重载|装|安装|下载|复制|移动|重命名|看一下|查一下|列一下|列出|清)/;
/** Wording that points at a specific past moment — clears the action-request rule. Deliberately
 * built only from explicit time deixis: "那个文件夹" means the folder in front of us, not a memory
 * (measured 2026-10-03: including that alternative made "把那个文件夹删了" look like a recall). */
const PAST_REF_RE = /上次|之前|以前|那天|当时|刚才|刚刚|最早|一开始|我(说|提|讲|聊|讨论)过|你(说|提|讲|聊|讨论)过/;

/** Wording that asks for CONTENT (how/what/why) — a present-state phrase plus one of these is a
 * real question about the past, not a status check, so it must still be recalled. */
const CONTENT_SEEK_RE = /怎么|如何|为什么|为啥|什么|啥|哪些|哪个|多少|谁|哪儿|哪里|是否|是不是|能不能|可不可以/;
/** Stripped iteratively from both ends: "按你的想法继续" leaves nothing behind, while
 * "继续那个记忆树的讨论" still leaves a real topic (so it is NOT treated as context-only). */
const CONTEXT_ONLY_EDGE_RE = /^(按你的想法|按你说的|你决定|你来定|都听你的|那就|就按|继续|接着|随便|都行)/;
const CONTEXT_ONLY_TAIL_RE = /(继续|接着|就行|就好|都可以|均可|吧|了|的|一下)$/;

/**
 * Is this turn only continuing/acknowledging the conversation, with no question of its own?
 * @param {string} text - the human's latest message.
 * @returns {boolean} true when recall should not even be attempted.
 */
/** Has a topic, but is not asking about the past: a present-state question ("现在还能用么") or an
 * imperative request ("帮我打开…"). These get a note but never a card. */
/** Subjective evaluation of the mechanism itself: "感觉这玩意的返回越来越不准了". These are
 * conversation about the system, not questions about the past, so they must not recall at all
 * (asked twice on 2026-10-04: such a note only shows the plugin its own history). Deliberately
 * narrow — an evaluation word AND a reference to the system AND no past pointing. */
const EVAL_RE = /不准|不准确|不够准|不好|不对|太吵|太烦|烦人|太慢|太卡|没用|没什么用|有问题|越来越|怪怪|不对劲|离谱/;
const SYSTEM_REF_RE = /这玩意|这东西|这个(系统|插件|功能|机制|回忆|召|记忆)|你这|你的(返回|召回|判定|卡片)|召回|记忆树|卡片|弹窗|关联记忆|记忆关联/;

/**
* Is this message just an evaluation of the memory mechanism itself?
* @param {string} text - the human's message.
* @returns {boolean} true when recall should not even be attempted.
*/
function isSystemFeedback(text) {
	const raw = String(text ?? '').trim();
	if (raw.length === 0) return false;
	if (!EVAL_RE.test(raw)) return false;
	if (!SYSTEM_REF_RE.test(raw)) return false;
	return !PAST_REF_RE.test(raw);
}

function isNotMemoryQuestion(text) {
	const raw = String(text ?? '').trim();
	if (raw.length === 0) return false;
	// Present-state question that asks for no content: strip the status wording FIRST, then look
	// for a content-seeking word. "现在还能用么" leaves nothing to look up, and "之前做的" is only
	// a qualifier; "上次讨论的是怎么实现的" carries no status wording and never gets here.
	if (PRESENT_STATE_RE.test(raw) && !CONTENT_SEEK_RE.test(raw.replace(PRESENT_STATE_RE, ''))) return true;
	if (ACTION_REQUEST_RE.test(raw) && !PAST_REF_RE.test(raw) && !CONTENT_SEEK_RE.test(raw)) return true;
	return false;
}

function isContextOnlyQuery(text) {
	const raw = String(text ?? '').trim();
	if (raw.length === 0) return true;
	if (CONTEXT_ONLY_RE.test(raw.replace(/[\s。！!，,、.…~～?？]/g, ''))) return true;
	const bare = raw.replace(/[\s。！!，,、.…~～?？]/g, '');
	// Very short AND no question marker: a reaction, not a question. Four characters is
	// deliberately conservative — "T10 是啥" (6) must still be asked (2026-10-01).
	if (bare.length <= 4 && !CONTEXT_ONLY_HINT_RE.test(raw)) return true;
	// Has a topic, but is not a question about the past (present-state / action request). Such a
	// message still deserves a NOTE — background about the thing it names is useful to the agent
	// (the human's point on 2026-10-03) — it just must not pop a CARD asking for a judgement.
	if (isNotMemoryQuestion(raw)) return false;
	let rest = bare;
	for (let i = 0; i < 6; i += 1) {
		const next = rest.replace(CONTEXT_ONLY_EDGE_RE, '').replace(CONTEXT_ONLY_TAIL_RE, '');
		if (next === rest) break;
		rest = next;
	}
	return rest.length <= 3;
}

function recentUserTexts(messages, limit = 20) {
  const out = [];
  if (!Array.isArray(messages)) return out;
  for (let index = messages.length - 1; index >= 0 && out.length < limit; index -= 1) {
    const message = messages[index];
    if (message?.source?.kind !== 'user') continue;
    const content = message.content;
    if (typeof content === 'string') { if (content.trim().length > 0) out.push(content.trim()); continue; }
    if (!Array.isArray(content)) continue;
    const text = content.filter((part) => part?.type === 'text').map((part) => String(part.text ?? '')).join(' ').trim();
    if (text.length > 0) out.push(text);
  }
  return out;
}

/**
 * The one injected note: candidate day ADDRESSES, how they scored, and the read protocol.
 *
 * v2 (2026-10-10, 用户定)：**注入更多节点，概述按需读**。
 *   理由（实测覆盖率，47 轮有正确答案的样本）：
 *     · 只列 3 天  → 正确日期被覆盖 21.3%
 *     · 列 12 天   → 83.0%
 *     · 列 20 天   → 95.7%      ← 甜点，边际开始递减
 *   而多列一天的增量成本只有一行「日期 + 相似度」，几十字节。
 *   ⇒ 覆盖率的瓶颈在"给不给"，不在"算得准不准"。
 *
 *   流程固定为两步（用户要求写死）：
 *     ① memory_read level=day date=<日期>  → 只读那个节点的【概述】判断是否相关
 *     ② 相关才 level=snapshot 细读原文；不相关就别读，也不必留下反馈
 *
 * v3 (2026-10-10, 用户定)：**静默读**。
 *   用户原话："这种翻一下之前的记忆这种还是不要输出发出来了，直接就去读，
 *             给人一种记忆很连贯的感觉。"
 *   ⇒ 注入文本里明写：读记忆是内部动作，不要播报"我去翻一下以前的记录"之类的过场。
 */
function renderRouterNote(result) {
	// 显示条数跟 routerTopK 对齐即可：实测 K=20（中位 9 天）时，47 轮有答案的样本已 100% 覆盖；
	// 再往上覆盖不涨，只是多摊噪音。若将来调大 routerTopK，这里自动跟着显示。
	const list = result.candidates;
	const lines = list.map((entry) => '  · ' + entry.date + '（' + entry.days + ' 天前, cos ' + entry.cosine + ', 命中 ' + entry.hits.length + ' 条）');
	return [
		'[记忆召回/本地小模型] 这条消息与过去这些对话节点可能相关（候选地址，尚未判定）：',
		...lines,
		'',
		'怎么用（两步，别跳）：',
		'  1) 先对可疑的日期执行 memory_read level=day date=<日期> —— 返回的开头就是那天的【概述】，',
		'     看概述判断"是否与当前问题相关"，不相关就换下一个，不必细读。',
		'  2) 概述确实相关的，再 memory_read level=snapshot 取原文（或 level=day 读全文）。',
		'',
		'**静默读**：读记忆是你的内部动作。不要播报「我先去翻一下以前的记录」「让我查查历史」这类过场——',
		'直接读了、直接用结论回答，让人感觉记忆是连贯的、本来就记得。',
		'只读概述、没细读的那几步不必留下反馈；唯有你实际用上了某天，才用 memory_route_feedback 记录。'
	].join('\n');
}
function ratio(value, label) {
	const number = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(number) || number <= 0 || number >= 1) {
		throw new TypeError(`memory-tree: ${label} must be a fraction strictly between 0 and 1, got ${JSON.stringify(value)}`);
	}
	return number;
}

/**
 * The last few entries of a day's region, for the entry call's prompt.
 *
 * Showing recent entries is what lets the model avoid recording the same event
 * twice. It is deliberately a TAIL and not the whole list: the append path
 * suppresses duplicates anyway, and a shorter prompt is a cheaper one.
 * @param {string} regionBody - the current `DAY SUMMARY` region body.
 * @param {number} [limit] - how many entries to include.
 * @returns {string|undefined} the entry lines, or `undefined` when there are none.
 */
export function recentEntries(regionBody, limit = 12) {
	const count = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
	if (count === 0) return undefined;
	const tail = parseDaySummary(regionBody).entries.slice(-count);
	if (tail.length === 0) return undefined;
	return tail.map((entry) => entry.line).join('\n');
}

/**
 * Render an event timestamp as `HH:MM` for a day entry.
 *
 * Used to stamp a cross-midnight note with the time that day's record actually
 * STOPPED, not the time the note was written. A note on the 13th that read
 * `10:20` — the moment a snapshot ran the next morning — would sit at the wrong
 * end of that day's timeline.
 * @param {number|undefined} epochMs - the last event's time.
 * @returns {string} `HH:MM`, or `--:--` when the time is unusable.
 */
export function clockOfEpoch(epochMs) {
	if (!Number.isFinite(epochMs) || epochMs <= 0) return '--:--';
	const when = new Date(epochMs);
	return `${pad(when.getHours())}:${pad(when.getMinutes())}`;
}

/**
 * Resolve the token count at which a snapshot starts.
 *
 * Ratio first, absolute second: a routed model with a 200k window should
 * snapshot around 100k, not at a number tuned for a 1M window. The absolute
 * value is used only while the window is unknown (before the first
 * `request/context` event), and it also acts as a FLOOR so that a
 * small-window route cannot make the trigger fire almost immediately.
 * @param {typeof DEFAULT_CONFIG} config - resolved configuration.
 * @param {{tokens: number, contextWindow?: number}|undefined} measurement - the latest measurement.
 * @returns {{threshold: number, source: 'ratio'|'absolute', contextWindow: number|undefined}} the resolved threshold and why.
 */
export function thresholdFor(config, measurement) {
	const window = measurement?.contextWindow;
	const absolute = config.snapshotTriggerTokens;
	if (typeof window === 'number' && window > 0 && config.snapshotTriggerRatio > 0) {
		const scaled = Math.floor(window * config.snapshotTriggerRatio);
		if (scaled >= absolute) return { threshold: scaled, source: 'ratio', contextWindow: window };
		// Below the floor: honour the floor, and say so rather than silently
		// firing on a route we have not been tuned for.
		return { threshold: absolute, source: 'absolute', contextWindow: window };
	}
	return { threshold: absolute, source: 'absolute', contextWindow: window };
}

/**
 * Validate a numeric configuration field.
 * @param {unknown} value - candidate.
 * @param {string} label - field name.
 * @param {number} [minimum] - inclusive minimum.
 * @returns {number} the validated number.
 */
function positive(value, label, minimum = 1) {
	const number = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(number) || number < minimum) {
		throw new TypeError(`memory-tree: ${label} must be a number ≥ ${minimum}, got ${JSON.stringify(value)}`);
	}
	return number;
}

/**
 * The memory service.
 */
export class MemoryService {
	/** @type {Map<string, any>} */
	#state = new Map();

	/** Detached work, tracked so disposal can quiesce. */
	#active = new Set();

	/** Serializes read-modify-write cycles per path. */
	mutex = new PathMutex();

	/** Counters surfaced by `memory_status`. */
	stats = {
		turnsLogged: 0,
		snapshots: 0,
		emptySnapshots: 0,
		dayCalls: 0,
		upperCalls: 0,
		callFailures: 0,
		rollups: 0,
		probes: 0,
		reminders: 0,
		mediaArchived: 0,
		routed: 0,
		routerInjected: 0,
		routerFeedback: 0,
		compactionsSeen: 0
	};

	/**
	 * @param {any} ctx - the plugin context.
	 * @param {typeof DEFAULT_CONFIG} config - resolved configuration.
	 */
	constructor(ctx, config) {
		this.ctx = ctx;
		this.config = config;
		this.lastError = undefined;
	}

	/**
	 * Per-session bookkeeping.
	 * @param {string} sessionId - the session id.
	 * @returns {any} the mutable state record.
	 */
	stateFor(sessionId) {
		let state = this.#state.get(sessionId);
		if (state === undefined) {
			state = {
				contextTokens: undefined,
				lastSnapshotAt: 0,
				lastTrigger: undefined,
				inFlight: false,
				// Which stage of the snapshot pipeline is running right now.
				// `memory_status` reports it because the counters below only move
				// when a stage *finishes*: read mid-flight, they look like a broken
				// feature rather than a busy one. Observed live — a run read 9s in
				// showed `dayCalls: 0` while both calls were in fact in progress.
				phase: undefined,
				replaceGeneration: undefined,
				eventScanFrom: undefined,
				lastCompactionSeq: undefined,
				threshold: undefined,
				thresholdSource: undefined,
				contextWindow: undefined,
				turnsLogged: 0,
				// The last turn a cross-session reminder was injected into.
				lastReminderTurn: undefined,
				// Context occupancy recorded by the last snapshot. The pressure
				// trigger compares against this instead of the bare threshold, so a
				// session that crossed the line and stopped growing is not recorded
				// again on every step.
				pressureAnchorTokens: undefined,
				// How many times the growth guard suppressed a pressure snapshot.
				// Exposed so "is the guard doing anything" is answerable.
				pressureSkipped: 0
			};
			this.#state.set(sessionId, state);
		}
		return state;
	}

	/**
	 * Whether this session's work belongs in the tree.
	 * @param {any} session - the session.
	 * @returns {boolean} whether to record it.
	 */
	includeSession(session) {
		if (session === undefined || session === null) return false;
		if (this.config.includeSubagents) return true;
		const depth = session.header?.delegationDepth;
		if (typeof depth === 'number') return depth === 0;
		return session.header?.parentSession === undefined;
	}

	/**
	 * Resolve the provider/model route from the session's own request header.
	 * @param {any} session - the session.
	 * @returns {{provider: string, model: string}|undefined} the route.
	 */
	routeOf(session) {
		try {
			const config = session?.requestHeader?.()?.config;
			if (config?.provider === undefined || config?.model === undefined) return undefined;
			return { provider: config.provider, model: config.model };
		} catch {
			return undefined;
		}
	}

	/**
	 * Read the llm service, when it is present.
	 * @returns {any} the service or `undefined`.
	 */
	llm() {
		try {
			return this.ctx.get?.('llm') ?? this.ctx.llm;
		} catch {
			return undefined;
		}
	}

	/**
	 * Read the token-meter service, when it is present.
	 * @returns {any} the service or `undefined`.
	 */
	tokenMeter() {
		try {
			return this.ctx.get?.('tokenMeter') ?? this.ctx.tokenMeter;
		} catch {
			return undefined;
		}
	}

	/**
	 * Measure a session's current context pressure.
	 *
	 * The VERIFIED return shape of `tokenMeter.measure(session)` is
	 * `{ logRevision, baseline, surfaceDeltaTokens, totalTokens, surfaceTokens,
	 * nodes }` — there is no `projectedTokens`, `pressureTokens`, or
	 * `contextWindow` on it (those names belong to a different record: the views
	 * folded over `request/context` events).
	 *
	 * Reading the wrong field made this return `undefined` for every call, which
	 * silently disabled the entire pressure trigger while every unit test still
	 * passed — because the tests' fake meter returned the shape I had wrongly
	 * assumed. The field name is therefore pinned by a regression test.
	 * @param {any} session - the session.
	 * @returns {{tokens: number, contextWindow: number|undefined, baseline: string|undefined, surfaceTokens: number|undefined}|undefined} the measurement.
	 */
	measure(session) {
		const meter = this.tokenMeter();
		if (meter === undefined || typeof meter.measure !== 'function') return undefined;
		try {
			const measurement = meter.measure(session);
			const tokens = [measurement?.totalTokens, measurement?.projectedTokens].find((value) => typeof value === 'number');
			if (tokens === undefined) return undefined;
			let contextWindow;
			try {
				contextWindow = session?.requestContext?.()?.contextWindow;
			} catch {
				contextWindow = undefined;
			}
			return {
				tokens,
				contextWindow: typeof contextWindow === 'number' ? contextWindow : undefined,
				baseline: typeof measurement?.baseline?.kind === 'string' ? measurement.baseline.kind : undefined,
				surfaceTokens: typeof measurement?.surfaceTokens === 'number' ? measurement.surfaceTokens : undefined
			};
		} catch (error) {
			this.note(error, 'token measurement');
			return undefined;
		}
	}

	/**
	 * Log a failure without ever throwing into the agent loop.
	 * @param {unknown} error - the error.
	 * @param {string} where - what was being attempted.
	 * @returns {void}
	 */
	note(error, where) {
		const message = error instanceof Error ? error.message : String(error);
		this.lastError = { where, message, at: new Date().toISOString() };
		try {
			this.ctx.logger?.warn?.(`memory-tree: ${where} failed: ${message}`);
		} catch {
			// Logging must never be the reason a hook throws.
		}
	}

	/**
	 * Run detached work, tracked for disposal.
	 * @param {() => Promise<void>} work - the work.
	 * @returns {Promise<void>} settles when the work does.
	 */
	defer(work) {
		const task = Promise.resolve()
			.then(work)
			.catch((error) => this.note(error, 'background task'));
		const tracked = task.finally(() => {
			this.#active.delete(tracked);
		});
		this.#active.add(tracked);
		return tracked;
	}

	/**
	 * Wait for every detached task to settle (used on disposal).
	 * @returns {Promise<void>} resolves when idle.
	 */
	async drain() {
		while (this.#active.size > 0) await Promise.allSettled([...this.#active]);
	}

	/**
	* The recall router, built on first use. Returns null when disabled.
	* @returns {any} the router or null.
	*/
		/**
		* Per-session overrides for the summary switch.
		*
		* Why per session: whether automatic summarisation is wanted is a property of
		* the WORK, not of the machine — one session may be a long debugging thread
		* worth recording, another a throwaway experiment. The config value stays the
		* default; a session's own choice lives here and is persisted so it survives a
		* restart (a resumed session gets its own setting back).
		* @returns {Record<string, boolean>} session id -> wanted state.
		*/
		_sessionAuto() {
			if (this.__sessionAuto !== undefined) return this.__sessionAuto;
			const table = {};
			try {
				const file = joinPath(this.config.routerDataDir, 'session-auto.json');
				const raw = readFileSync(file, 'utf8');
				const parsed = JSON.parse(raw);
				for (const [key, value] of Object.entries(parsed ?? {})) if (value === true || value === false) table[key] = value;
			} catch { }
			this.__sessionAuto = table;
			return table;
		}

		/** Write the override table back. Best effort: a failure must not break a turn. */
		_persistSessionAuto() {
			try {
				const dir = this.config.routerDataDir;
				mkdirSync(dir, { recursive: true });
				writeFileSync(joinPath(dir, 'session-auto.json'), JSON.stringify(this._sessionAuto(), null, 0), 'utf8');
			} catch { }
		}

		/** The session the page is most likely showing: the one whose step ran last. */
		currentSession() {
			return this._lastSession;
		}

		/**
		* The effective automatic-summarisation state for one session.
		* Order: session override -> configured default.
		* @param {any} [session] - the session (or its id); omitted uses the last active one.
		* @returns {boolean} whether automatic snapshots are on for it.
		*/
		autoFor(session) {
			const id = typeof session === 'string' ? session : (session?.id ?? this._lastSession);
			if (typeof id === 'string') {
				const overridden = this._sessionAuto()[id];
				if (overridden !== undefined) return overridden;
			}
			return this.config.autoSummary === true;
		}
		/**
		* Which session a UI request is about.
		*
		* The page sends its own session in the `x-dsh-session` header (it reads it from
		* its own URL). Falling back to the last session that carried a human message
		* keeps the switch usable if that header is ever missing — but the header wins,
		* because relying on "last active" was wrong: background subagent sessions step
		* too and stole it (reported 2026-09-30: "也不是每个会话独立").
		* @param {any} req - the HTTP request.
		* @returns {string|undefined} the session id.
		*/
		pickSession(req) {
			try {
				const header = req && req.headers && (req.headers['x-dsh-session'] || req.headers['X-Dsh-Session']);
				if (typeof header === 'string' && header.trim().length > 0) return header.trim();
			} catch { }
			return this._lastSession;
		}
		/** The last recall injection for a session (what the rating popup is about). */
		injectionFor(sessionId) {
			const id = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : this._lastSession;
			if (typeof id !== 'string') return null;
			const state = this.stateFor(id);
			return state.lastInjection ?? null;
		}

		/**
		* Record the HUMAN's rating of one injection. This is the training set — kept
		* separate from the agent's own verdict on purpose, because only the human's
		* judgement is ground truth (the agent's would be a feedback loop).
		* @param {{dates?: string[], verdict?: string, note?: string, query?: string, injection?: any}} request - the rating.
		* @param {string} [sessionId] - the session it belongs to.
		* @returns {any} where it was written.
		*/
		/**
		* The embedding transport's last failure — surfaced in the UI on purpose. A recall
		* that stopped working must SAY so; the 2026-10-01 incident was exactly a silent death.
		* @returns {string|null} the last error message, if any.
		*/
		/**
		* When this session was last compacted. Everything newer than that is still verbatim in
		* the context window, so recalling it is echoing, not remembering. Derived from the tree's
		* own snapshot names (`<stamp>-compaction-<sessionToken>.md`), cached for a minute.
		* @param {any} session - the session (or its id).
		* @returns {number|null} epoch ms of the newest compaction snapshot, or null.
		*/
		compactionCutoff(session) {
		  try {
		    const token = sessionToken(typeof session === 'string' ? session : session?.id);
		    if (typeof token !== 'string' || token.length === 0) return null;
		    this._cutoffCache = this._cutoffCache ?? {};
		    const cached = this._cutoffCache[token];
		    if (cached !== undefined && Date.now() - cached.at < 60_000) return cached.value;
		    let best = null;
		    for (const offset of [0, 1, 2]) {
		      const when = new Date(Date.now() - offset * 86_400_000);
		      const parts = localParts(when);
		      const dir = joinPath(this.config.root, parts.year, parts.month, parts.day);
		      for (const name of listDir(dir)) {
		        if (!String(name).includes('compaction') || !String(name).includes(token)) continue;
		        const stamp = String(name).slice(0, 15);                   // 2026-09-30T203035
		        const at = new Date(Number(stamp.slice(0, 4)), Number(stamp.slice(5, 7)) - 1, Number(stamp.slice(8, 10)), Number(stamp.slice(11, 13)), Number(stamp.slice(13, 15)), 0).getTime();
		        if (Number.isFinite(at) && (best === null || at > best)) best = at;
		      }
		    }
		    this._cutoffCache[token] = { at: Date.now(), value: best };
		    return best;
		  } catch { return null; }
		}

		routerError() {
		  try { return this._routerInstance?.lastError ?? null; } catch { return null; }
		}

		/**
		* Record the human's pick for one candidate set: a specific date, `none` (none of them
		* were right) or `skip` (no judgement). This is candidate-level ground truth — the
		* material a re-ranker needs, and the only reliable source of negatives.
		* @param {{choice?: string, key?: string, options?: any[], query?: string, note?: string}} request - the pick.
		* @param {string} [sessionId] - the session it belongs to.
		* @returns {any} where it was written.
		*/
		recordPick(request, sessionId) {
		  const choice = String(request?.choice ?? '');
		  if (!['none', 'skip'].includes(choice) && !/^\d{4}-\d{2}-\d{2}$/.test(choice)) {
		    return { ok: false, error: 'choice must be a yyyy-mm-dd date, none, or skip' };
		  }
		  const id = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : this._lastSession;
		  const candidates = this.stateFor(typeof id === 'string' ? id : '').lastCandidates;
		  const options = Array.isArray(request?.options) ? request.options : (candidates?.options ?? []);
		  const record = {
		    at: new Date().toISOString(),
		    choice,
		    session: typeof id === 'string' ? id : null,
		            injected: candidates?.injected === true,
		            // Ranking supervision: which batch was rejected, and where the human's pick sat.
		            batch: request?.batch === undefined ? null : request.batch,
		            rank: request?.rank === undefined ? null : request.rank,
		    topCosine: candidates?.topCosine ?? null,
		    query: scrubText(String(request?.query ?? candidates?.query ?? '')).text.slice(0, 300),
		    options: (Array.isArray(options) ? options : []).slice(0, 3).map((option) => ({
		      date: String(option?.date ?? ''),
		      days: option?.days ?? null,
		      cosine: option?.cosine ?? null,
		      time: option?.hits?.[0]?.time ?? null,
		      text: scrubText(String(option?.hits?.[0]?.text ?? '')).text.slice(0, 120)
		    })),
		    note: request?.note === undefined ? undefined : scrubText(String(request.note)).text.slice(0, 200)
		  };
		  const dir = this.config.routerDataDir;
		  mkdirSync(dir, { recursive: true });
		  appendFileSync(joinPath(dir, 'picks.jsonl'), JSON.stringify(record) + '\n', 'utf8');
		    // A batch rejection ("下一批") is NOT a final rating: the card must stay alive so the human can
  // page on to ranks 4-6. Only a specific date, "都不正确（全部）" or skip closes it (2026-10-02:
  // marking it rated made the freshly-paged card vanish on the next 15s poll).
  const intermediate = choice === 'none' && typeof request?.batch === 'number';
  if (candidates !== undefined) candidates.rated = choice !== 'skip' && !intermediate;
		  return { ok: true, path: joinPath(dir, 'picks.jsonl'), record };
		}

rateHuman(request, sessionId) {
			const verdict = String(request?.verdict ?? '');
			if (!['relevant', 'partly', 'not_relevant', 'skip'].includes(verdict)) {
				return { ok: false, error: 'verdict must be one of relevant | partly | not_relevant | skip' };
			}
			const id = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : this._lastSession;
			const injection = request?.injection ?? this.injectionFor(id);
			const record = {
				at: new Date().toISOString(),
				verdict,
				session: typeof id === 'string' ? id : null,
				dates: Array.isArray(request?.dates) ? request.dates.map(String).slice(0, 8)
					: (Array.isArray(injection?.dates) ? injection.dates : []),
				cosines: Array.isArray(injection?.cosines) ? injection.cosines : [],
				query: scrubText(String(request?.query ?? request?.injection?.query ?? this._lastQuery ?? '')).text.slice(0, 400),
				note: request?.note === undefined ? undefined : scrubText(String(request.note)).text.slice(0, 400)
			};
			const dir = this.config.routerDataDir;
			mkdirSync(dir, { recursive: true });
			appendFileSync(joinPath(dir, 'human_rated.jsonl'), JSON.stringify(record) + '\n', 'utf8');
			if (typeof id === 'string' && this.stateFor(id).lastInjection !== undefined) {
				this.stateFor(id).lastInjection.rated = verdict !== 'skip';
			}
			return { ok: true, path: joinPath(dir, 'human_rated.jsonl'), record };
		}
	/**
	* Pick the embedding transport. `auto` prefers the in-process ONNX model and falls
	* back to the local HTTP server, so behaviour can never get worse than before.
	* @param {any} config - the resolved plugin config.
	* @returns {Function} a router transport (same contract as httpTransport).
	*/
	buildTransport(config) {
	  const mode = String(config.routerTransport ?? 'auto');
	  if (mode === 'http') return httpTransport;
	  const onnx = createOnnxTransport({ onnxDir: config.routerOnnxDir, onnxModel: config.routerOnnxModel });
	  if (mode === 'onnx') return onnx;
	  return async (request) => {
	    try { return await onnx(request); } catch { return httpTransport(request); }
	  };
	}

	_router() {
		if (this._routerInstance !== undefined) return this._routerInstance;
		if (!this.config.router) { this._routerInstance = null; return null; }
		const router = createRouter(this.config, { transport: this.buildTransport(this.config) });
		this._routerInstance = router;
		if (this.config.routerWarmup) {
			void router.warmup();
			if (this.config.routerKeepAliveMs > 0) {
				const timer = setInterval(() => { void router.warmup(); }, this.config.routerKeepAliveMs);
				timer.unref?.();
				this._routerTimer = timer;
			}
		}
		return router;
	}

	/**
	* The recall line for this step, when the router finds something.
	*
	* Deliberately ONE async call (~5 ms) rather than a cached guess: a note that
	* arrives a turn late is worse than no note. Any failure returns undefined —
	* recall must never break the turn.
	* @param {any} payload - the pre-step payload.
	* @returns {Promise<{text: string, dates: string[]}|undefined>} the note.
	*/
	async routerFor(payload) {
		if (!this.config.enabled || !this.config.router || !this.config.routerInject) return undefined;
		const session = payload?.agent?.session;
		if (session === undefined || !this.includeSession(session)) return undefined;
		const router = this._router();
		if (router === null) return undefined;
		// Tell the router which session is asking, so it skips that session's recent turns.
		// Skip the part of this session that is still verbatim in the model's context:
		// everything after the last compaction. Before it, only summaries remain — that is
		// where recall is genuinely useful. Fall back to a 12-hour window when unknown.
		const cutoff = this.compactionCutoff(session) ?? (Date.now() - this.config.routerExcludeSameSessionMs);
		try { router.setSession?.(session?.id, cutoff); } catch { }
		// Do not recall what the human just said: those exact words are already in front of
		// the model. Content-based, because the real context window is not knowable here.
		try { router.setRecentTexts?.(recentUserTexts(payload?.messages, 20)); } catch { }
			// The authoritative "which session is the human looking at" signal: the step that
			// just carried a human message. Subagents also step, but they carry no user
			// message, so this cannot be stolen by background work.
			this._lastSession = payload?.agent?.session?.id ?? this._lastSession;
				const query = lastUserText(payload?.messages);
				this._lastQuery = query;
		// No human message in this step (subagent / tool-only step): nothing to recall, nothing to
		// log. This MUST come before the context-only guard — that guard read an undefined query as
		// an "empty message", decided it was context-only, and wrote 4 junk rows into
		// skipped.jsonl within 15 seconds (measured 2026-10-03).
		if (query === undefined) return undefined;
		// Two questions, two answers (2026-10-03): a message with NO topic at all is skipped whole;
		// one that HAS a topic but is not a memory question (present state / action request) still
		// gets a note for the agent, yet must not pop a card asking the human to judge it.
		const cardEligible = !isNotMemoryQuestion(String(query));
		// Two ways to earn a whole skip: no topic at all, or an evaluation of the mechanism itself.
		const systemFeedback = isSystemFeedback(query);
		if (this.config.routerSkipContextOnly !== false && (systemFeedback || isContextOnlyQuery(query))) {
			// Log every skip: the filter must stay auditable rather than silently guessing.
			try {
				mkdirSync(this.config.routerDataDir, { recursive: true });
				appendFileSync(joinPath(this.config.routerDataDir, 'skipped.jsonl'), JSON.stringify({
					at: new Date().toISOString(),
					session: session?.id ?? null,
					query: scrubText(String(query)).text.slice(0, 200),
					reason: systemFeedback ? 'system-feedback' : 'context-only'
				}) + '\n', 'utf8');
			} catch { }
			return undefined;
		}
		if (query === undefined) return undefined;
		const result = await router.route(query);
		this.stats.routed += 1;
		// Borderline near-miss: record it silently (no note, no card) so the human can label a
		// batch later. A re-ranker cannot be trained on positives alone (2026-10-01).
		if (result !== undefined && result.verdict !== 'related') {
		  const near = result.candidates?.[0];
		  if (near !== undefined && typeof near.cosine === 'number' && near.cosine >= 0.5) {
		    try {
		      mkdirSync(this.config.routerDataDir, { recursive: true });
		      appendFileSync(joinPath(this.config.routerDataDir, 'candidates.jsonl'), JSON.stringify({
		        at: new Date().toISOString(),
		        session: session?.id ?? null,
		        query: scrubText(String(query)).text.slice(0, 300),
		        bestCosine: near.cosine,
		        dates: (result.candidates ?? []).slice(0, 5).map((entry) => entry.date),
		        cosines: (result.candidates ?? []).slice(0, 5).map((entry) => entry.cosine),
		        days: (result.candidates ?? []).slice(0, 5).map((entry) => entry.days),
		        reason: result.reason
		      }) + '\n', 'utf8');
		    } catch { }
		  }
		}

if (result === undefined) return undefined;
const state = this.stateFor(session.id);
const signature = result.candidates.map((entry) => entry.date).join(',');

// Always record this turn's top candidates — even when nothing was injected — so the
// human can say WHICH of them (if any) was right. That is the only way to get
// candidate-level labels and negatives, without which a re-ranker cannot be trained.
const pickOptions = (result.candidates ?? []).slice(0, 12).map((entry) => ({
date: entry.date,
days: entry.days,
cosine: entry.cosine,
hits: (entry.hits ?? []).slice(0, 1).map((hit) => ({ time: hit.time ?? null, text: String(hit.text ?? '').slice(0, 100) }))
}));
// v27 (2026-10-10, 用户定)：**不再弹卡片**，改为「后台每次召回注入都留档」。
//   理由（用户实测 2026-10-10）：一次性给出多条候选后，AI 自己读概述判断的命中率明显更高，
//   卡片那套"人来判哪条对"的流程已经没有意义 —— 人审的是 AI 的读法，不是候选本身。
//   留档仍然要做（`injections.jsonl`），因为那是"哪一轮给过哪些候选"的唯一记录，
//   将来要离线评估「给得多是否真的更好」，靠的就是它。
//   卡片代码保留但关掉（offer: false），要恢复只需把这里改回 true。
state.lastCandidates = {
at: new Date().toISOString(),
query: scrubText(String(query)).text.slice(0, 200),
key: signature,
injected: result.verdict === 'related',
cardEligible: cardEligible,
topCosine: pickOptions[0]?.cosine ?? 0,
offer: false,
showOptions: false,
options: pickOptions,
rated: true
};
if (result.verdict !== 'related') return undefined;
		const turn = payload?.turn;
		if (state.routerSignature === signature && typeof turn === 'number' && typeof state.routerTurn === 'number' && turn - state.routerTurn < this.config.routerMinGapTurns) return undefined;
			state.routerSignature = signature;

			// Record what was just injected for this session: the UI asks the HUMAN to rate
			// it (that rating is the only ground truth; the agent's own verdict is not).
			state.lastInjection = {
				dates: result.candidates.map((entry) => entry.date),
				cosines: result.candidates.map((entry) => entry.cosine),
				// Evidence for the human's judgement: which turn matched, when, and its words.
				// A bare "2026-09-30 (cos 0.65)" is not enough to decide anything (asked 2026-09-30).
				evidence: result.candidates.slice(0, 2).map((entry) => ({
				  date: entry.date,
				  days: entry.days,
				  cosine: entry.cosine,
				  hits: (entry.hits ?? []).slice(0, 2).map((hit) => ({
				    time: hit.time ?? null,
				    cosine: hit.cosine,
				    text: String(hit.text ?? '').slice(0, 120)
				  }))
				})),
				at: new Date().toISOString(),
				turn: typeof turn === 'number' ? turn : null,
				rated: state.lastInjection?.key === signature ? state.lastInjection.rated : false,
				key: signature,
				// The question this injection answered, kept WITH the injection so the rating row
				// carries it (only 7 of the first 18 human labels had a query — measured 2026-10-01).
				query: String(this._lastQuery ?? '').slice(0, 200)
			};
		state.routerTurn = turn;
		this.stats.routerInjected += 1;
		// v27：把这一次注入原样留档（用户要求「后台每次召回注入都留档就行」）。
		// 卡片关掉之后，这是「哪一轮给过哪些候选」的唯一记录 ——
		// 将来离线评估「给得多是否真的更好」靠的就是它。
		// 只追加、失败不影响本轮（召回绝不能因为写日志失败而中断）。
		try {
			const dir = this.config.routerDataDir;
			mkdirSync(dir, { recursive: true });
			appendFileSync(joinPath(dir, 'injections.jsonl'), JSON.stringify({
				at: new Date().toISOString(),
				session: session?.id ?? null,
				turn: typeof turn === 'number' ? turn : null,
				query: scrubText(String(query)).text.slice(0, 300),
				count: result.candidates.length,
				dates: result.candidates.map((entry) => entry.date),
				cosines: result.candidates.map((entry) => entry.cosine),
				topCosine: result.candidates[0]?.cosine ?? null,
				verdict: result.verdict,
				reason: result.reason ?? null
			}) + '\n', 'utf8');
		} catch { }
		return { text: renderRouterNote(result), dates: result.candidates.map((entry) => entry.date) };
	}

	/**
	* Tool: route an arbitrary message through the local model.
	* @param {{query?: string}} request - the request.
	* @returns {Promise<any>} the result, or an error.
	*/
	async routeQuery(request) {
		const router = this._router();
		if (router === null) return { ok: false, error: 'recall is disabled (config.router=false)' };
		const query = typeof request?.query === 'string' ? request.query.trim() : '';
		if (query.length === 0) return { ok: false, error: 'query must not be empty' };
		const result = await router.route(query);
		if (result === undefined) return { ok: false, error: router.lastError ?? 'route failed' };
		this.stats.routed += 1;
		return { ok: true, result };
	}

	/**
	* Tool: record the agent's own judgement.
	*
	* Runtime signal and TRAINING DATA — but NOT ground truth: only the human's own
	* rating is. Scrubbed before it lands, because the tree must not hold secrets.
	* @param {{query?: string, dates?: string[], verdict?: string, note?: string}} request - the judgement.
	* @returns {Promise<any>} where it was written.
	*/
	async recordRouterFeedback(request) {
		const verdict = String(request?.verdict ?? '');
		if (!['relevant', 'partly', 'not_relevant', 'unknown'].includes(verdict)) {
			return { ok: false, error: 'verdict must be one of relevant | partly | not_relevant | unknown' };
		}
		const dir = this.config.routerDataDir;
		const record = {
			at: new Date().toISOString(),
			verdict,
			dates: Array.isArray(request?.dates) ? request.dates.map(String).slice(0, 8) : [],
			query: scrubText(String(request?.query ?? '')).text.slice(0, 400),
			note: request?.note === undefined ? undefined : scrubText(String(request.note)).text.slice(0, 400)
		};
		mkdirSync(dir, { recursive: true });
		appendFileSync(joinPath(dir, 'agent_judged.jsonl'), JSON.stringify(record) + '\n', 'utf8');
		this.stats.routerFeedback += 1;
		return { ok: true, path: joinPath(dir, 'agent_judged.jsonl'), record };
	}

	/**
	* Tool: turn automatic summarisation on or off. Runtime only — a restart returns
	* to whatever the config says (autoSummary, default true).
	* @param {boolean} [on] - the wanted state; omit to toggle.
	* @returns {any} the new state.
	*/
		setAutoSummary(on, sessionId) {
			const id = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : this._lastSession;
			const current = this.autoFor(id);
			const next = on === undefined ? !current : on === true;
			if (typeof id === 'string' && id.length > 0) {
				this._sessionAuto()[id] = next;
				this._persistSessionAuto();
			} else {
				// No session known (early boot / no step yet): fall back to the global switch.
				this.config.autoSummary = next;
			}
			return {
				autoSummary: next,
				session: id ?? null,
				scope: typeof id === 'string' && id.length > 0 ? 'session' : 'global',
				gated: ['compaction snapshot', 'pressure snapshot', 'turn-count snapshot'],
				stillOn: ['turn log (机械流水，零模型调用)', 'memory_snapshot (手动)'],
				note: 'per session; persisted, and the configured value stays the default'
			};
		}
	// ── triggers ───────────────────────────────────────────────────────────

	/**
	 * Observe one step boundary: pressure and compaction triggers.
	 *
	 * Synchronous by design — the hook must not delay the request it precedes.
	 * @param {{agent?: any, signal?: AbortSignal}} payload - the event payload.
	 * @returns {void}
	 */
	onPreStep(payload) {
		if (!this.config.enabled) return;
		const session = payload?.agent?.session;
		if (!this.includeSession(session)) return;
		const state = this.stateFor(session.id);
			// Remember which session is active: the UI switch is per-session and needs to
			// know which one the page is showing (the step that just ran is that session).
			this._lastSession = session.id;
			if (this.autoFor(session) && this.config.compactionTrigger) this.#watchCompaction(session, state);
		const measurement = this.measure(session);
		if (measurement === undefined) return;
		state.contextTokens = measurement.tokens;
		const resolved = thresholdFor(this.config, measurement);
		state.threshold = resolved.threshold;
		state.thresholdSource = resolved.source;
		state.contextWindow = resolved.contextWindow;
		if (measurement.tokens >= resolved.threshold) {
			// Pressure is an EVENT, not a state. A snapshot does not reduce the
			// context, so "occupancy is above the line" stays true forever once it
			// is crossed — and the trigger fired on every step, held back only by
			// the cooldown. Observed live on 2026-09-13: 22 snapshots in 25 minutes,
			// each costing two model calls.
			//
			// The guard is growth SINCE the last snapshot. A session that crossed
			// the line and then stopped growing has already been recorded; recording
			// it again buys nothing and costs two calls plus another index row.
			const anchor = state.pressureAnchorTokens;
			const growth = this.config.snapshotGrowthTokens;
			if (anchor !== undefined && measurement.tokens < anchor + growth) {
				state.pressureSkipped += 1;
				return;
			}
				if (this.autoFor(session)) this.schedule(session, 'pressure');
		}
	}

	/**
	 * Detect a compaction boundary.
	 *
	 * Two independent signals, because the primary one is the durable fact:
	 *
	 *  1. **`compaction/start` in the session log.** The harness's compaction
	 *     backend appends this event BEFORE it summarizes and before it replaces
	 *     the surface, and it is a plain durable event — so it names the exact
	 *     moment without depending on any private field. Scanned incrementally
	 *     (`eventAt` over the new tail only), so this stays O(new events).
	 *
	 *  2. **`surface.replaceGeneration`.** Belt and braces: it changes after the
	 *     replacement, so it also catches a compaction performed by something
	 *     other than the built-in backend (or a surface rewritten by hand).
	 *
	 * Detection being a step "late" costs nothing, because a snapshot reads the
	 * append-only log and compaction only rewrites the derived surface.
	 * @param {any} session - the session.
	 * @param {any} state - the session state.
	 * @returns {void}
	 */
	#watchCompaction(session, state) {
		const seq = typeof session?.seq === 'number' ? session.seq : undefined;
		if (typeof session?.eventAt === 'function' && typeof seq === 'number') {
			// Start near the tail the first time: a compaction that predates this
			// plugin's interest is not a boundary we need to react to.
			const from = typeof state.eventScanFrom === 'number' ? state.eventScanFrom : Math.max(0, seq - 1000);
			let found;
			const upper = Math.min(seq, from + 20_000);
			for (let index = from; index < upper; index += 1) {
				let event;
				try {
					event = session.eventAt(index);
				} catch {
					break;
				}
				if (event?.type !== 'compaction/start') continue;
				if (typeof event.seq === 'number' && event.seq === state.lastCompactionSeq) continue;
				found = event.seq ?? index;
			}
			state.eventScanFrom = upper;
			if (found !== undefined) {
				state.lastCompactionSeq = found;
				this.stats.compactionsSeen += 1;
				this.schedule(session, 'compaction');
			}
		}
		const generation = session?.surface?.replaceGeneration;
		if (typeof generation !== 'number') return;
		if (state.replaceGeneration !== undefined && generation !== state.replaceGeneration) {
			this.schedule(session, 'compaction');
		}
		state.replaceGeneration = generation;
	}

	/**
	 * Decide whether this step deserves a cross-session-reference reminder.
	 *
	 * Costs one substring scan: no model call, no file read. The reminder is a
	 * nudge, not automation — it points at the cheap read path and explicitly
	 * leaves the judgement to the model, because a reminder that cannot be
	 * ignored becomes noise on every borderline match.
	 * @param {{agent?: any, messages?: any[], turn?: number}} payload - the pre-step payload.
	 * @returns {{text: string, signal: string}|undefined} the reminder, when one is due.
	 */
	reminderFor(payload) {
		if (!this.config.enabled || !this.config.reminderOn) return undefined;
		const session = payload?.agent?.session;
		if (session === undefined || !this.includeSession(session)) return undefined;
		const turn = payload?.turn;
		if (typeof turn !== 'number') return undefined;
		const state = this.stateFor(session.id);
		// One reminder per step *and* a quiet gap afterwards: a single turn has
		// many steps, and the same phrase tends to repeat across a follow-up.
		if (state.lastReminderTurn !== undefined && turn - state.lastReminderTurn < this.config.reminderMinGapTurns) {
			return undefined;
		}
		const signal = detectSignal(this.#humanText(payload?.messages));
		if (signal === undefined) return undefined;
		state.lastReminderTurn = turn;
		this.stats.reminders += 1;
		return { text: reminderText(signal, this.config.root), signal };
	}

	/**
	 * The text of the most recent message the human actually typed.
	 *
	 * `source.kind === 'user'` is the harness's own discriminator for human
	 * input (`dsh-repeat-tool-reminder` branches on exactly this), so context
	 * injected by plugins can never be mistaken for a request.
	 * @param {any[]|undefined} messages - this step's claimed user messages.
	 * @returns {string} the text, or an empty string.
	 */
	#humanText(messages) {
		if (!Array.isArray(messages)) return '';
		for (let index = messages.length - 1; index >= 0; index -= 1) {
			const message = messages[index];
			if (message?.source?.kind !== 'user') continue;
			return messageText(message);
		}
		return '';
	}

	/**
	 * Copy every image this turn produced into the day's `media/` directory.
	 *
	 * The archive is deliberately the tree's OWN copy. The harness attachment
	 * store is content-addressed and already durable, but it belongs to the app,
	 * and the point of remembering is to outlive the app. Files deduplicate by
	 * sha256 prefix across the day, so one image mentioned by three turns costs
	 * one file and three index rows.
	 *
	 * Failures are absorbed: an image that cannot be copied must never cost the
	 * turn its mechanical log line, which is already committed by the time this
	 * runs.
	 * @param {{session: any, turn: number, records: any[], dayFile: string, parts: any}} input - the turn's material.
	 * @returns {Promise<{copied: number, present: number, entries: number}|undefined>} the outcome, or undefined when nothing applied.
	 */
	async #archiveTurnMedia({ session, turn, records, dayFile, parts }) {
		const attachments = this.ctx.get('attachments');
		if (attachments === undefined || typeof attachments.imageHostPath !== 'function') return undefined;
		const images = [];
		for (const record of records ?? []) {
			for (const attachment of imagesIn(record)) images.push(attachment);
		}
		if (images.length === 0) return undefined;
		const token = sessionToken(session.id);
		let copied = 0;
		let present = 0;
		for (const attachment of images) {
			let sourcePath;
			try {
				sourcePath = await attachments.imageHostPath(attachment);
			} catch {
				sourcePath = undefined;
			}
			if (sourcePath === undefined) continue;
			const outcome = await archiveImage({
				root: this.config.root,
				dateText: parts.dateText,
				stamp: parts.stamp,
				turn,
				sessionToken: token,
				attachment,
				sourcePath
			});
			if (outcome.status === 'copied') copied += 1;
			if (outcome.status === 'present') present += 1;
		}
		const entries = await this.#refreshMediaRegion({ dayFile, parts });
		if (copied > 0) this.stats.mediaArchived += copied;
		return { copied, present, entries };
	}

	/**
	 * Recompute the day file's MEDIA region from the directory.
	 *
	 * Derived, never stored: the table can be rebuilt at any time, so a lost or
	 * hand-mangled row heals on the next write instead of drifting away from the
	 * files it claims to describe.
	 * @param {{dayFile: string, parts: any}} input - the day file and this write's stamp.
	 * @returns {Promise<number>} how many entries the archive now holds.
	 */
	async #refreshMediaRegion({ dayFile, parts }) {
		const entries = await listMedia(mediaDir(this.config.root, parts.dateText));
		await this.mutex.run(dayFile, async () => {
			const text = await readIfExists(dayFile);
			if (text === undefined) return;
			const next = replaceRegion(text, MEDIA_REGION, renderMedia(entries));
			if (next === text) return;
			await atomicWrite(dayFile, setFrontMatter(next, { updated: parts.stamp }));
		});
		return entries.length;
	}

	/**
	 * Start a snapshot unless one is running or the cooldown has not elapsed.
	 *
	 * `manual` and `compaction` bypass the cooldown: they are explicit or hard
	 * boundaries, and the incremental detection above already guarantees one
	 * schedule per real event, so there is nothing to storm-proof.
	 * @param {any} session - the session.
	 * @param {'pressure'|'compaction'|'turns'|'manual'} trigger - the reason.
	 * @returns {{started: boolean, reason?: string}} the decision.
	 */
	schedule(session, trigger) {
		const state = this.stateFor(session.id);
		if (state.inFlight) return { started: false, reason: 'a snapshot is already running for this session' };
		if (trigger !== 'manual' && trigger !== 'compaction') {
			const elapsed = Date.now() - state.lastSnapshotAt;
			if (elapsed < this.config.minSnapshotIntervalMs) {
				return { started: false, reason: `cooldown (${Math.round((this.config.minSnapshotIntervalMs - elapsed) / 1000)}s left)` };
			}
		}
		state.inFlight = true;
		state.lastTrigger = trigger;
		void this.defer(async () => {
			try {
				await this.snapshot({ session, trigger });
			} finally {
				state.inFlight = false;
				state.phase = undefined;
				state.lastSnapshotAt = Date.now();
			}
		});
		return { started: true };
	}

	/**
	 * Record one turn's mechanical line, and consider a turn-cadence snapshot.
	 *
	 * Awaited by the loop, so it stays cheap: one lazy node ensure, one read,
	 * one atomic write. No model call ever happens here.
	 * @param {{agent?: any, turn?: number, signal?: AbortSignal}} payload - the event payload.
	 * @returns {Promise<{logged: boolean, reason?: string}>} the outcome.
	 */
	async onTurnStopping(payload) {
		const session = payload?.agent?.session;
		const turn = payload?.turn;
		if (!this.config.enabled || !this.config.turnLog) return { logged: false, reason: 'turn logging is disabled' };
		if (!this.includeSession(session) || typeof turn !== 'number') return { logged: false, reason: 'session is not recorded' };
		try {
			const state = this.stateFor(session.id);
				// Remember which session is active: the UI switch is per-session and needs to
				// know which one the page is showing (the step that just ran is that session).
				this._lastSession = session.id;
				if (this.autoFor(session) && this.config.compactionTrigger) this.#watchCompaction(session, state);
			const measurement = this.measure(session);
			const delta = measurement !== undefined && state.contextTokens !== undefined
				? measurement.tokens - state.contextTokens
				: undefined;
			if (measurement !== undefined) state.contextTokens = measurement.tokens;
			// `new Date(Date.now())`, not `new Date()`: same wall clock, but read
			// through the one clock a caller can stub. See the note on the identical
			// line in `snapshot()`.
			const parts = localParts(new Date(Date.now()), this.config.timezone);
			if (!isRecordableDate(parts.dateText)) return { logged: false, reason: 'before the tree start date' };
			const layout = await ensureNode({ root: this.config.root, dateText: parts.dateText, stamp: parts.stamp, mutex: this.mutex });
			const events = sessionEvents(session);
			const slice = turnSlice(events, turn);
			const token = sessionToken(session.id);
			const row = turnRow({
				clock: parts.stamp.slice(11, 19),
				turn,
				sessionToken: token,
				delta,
				files: slice.files,
				headline: slice.headline
			});
			const outcome = await appendTurnRow({
				dayFile: layout.layout.dayFile,
				row,
				marker: turnMarker(turn, token),
				mutex: this.mutex,
				stamp: parts.stamp
			});
			if (outcome === 'appended') {
				state.turnsLogged += 1;
				this.stats.turnsLogged += 1;
			}
			if (this.config.mediaArchive) {
				// Never let an image problem cost the turn its log line: the row is
				// already committed above, and this runs after it on purpose.
				await this.#archiveTurnMedia({
					session,
					turn,
					records: slice.records,
					dayFile: layout.layout.dayFile,
					parts
				}).catch((error) => this.note(error, 'media archive'));
			}
				if (this.autoFor(payload?.agent?.session) && this.config.snapshotOnTurns > 0 && turn > 0 && turn % this.config.snapshotOnTurns === 0) {
				this.schedule(session, 'turns');
			}
			return { logged: outcome === 'appended', reason: outcome === 'missing' ? 'the day file disappeared' : undefined };
		} catch (error) {
			this.note(error, 'turn log');
			return { logged: false, reason: String(error) };
		}
	}

	// ── the snapshot pipeline ──────────────────────────────────────────────

	/**
	 * Write one snapshot and refresh every level of the tree.
	 * @param {{session: any, trigger: 'pressure'|'compaction'|'manual'|'turns', signal?: AbortSignal}} input - the request.
	 * @returns {Promise<any>} a diagnostic report.
	 */
	/**
	 * Replay historical session logs into the tree.
	 *
	 * The tree only knows what happened while it was running, so a fresh install
	 * starts empty even on a machine with months of conversation on disk. This
	 * walks DSH's own session logs and feeds them through the SAME snapshot
	 * pipeline a live turn uses — nothing about the resulting files differs, so a
	 * reader cannot tell an imported day from a recorded one.
	 *
	 * Two properties of the existing pipeline make that reuse possible instead of
	 * a second writer:
	 *  · `writeSnapshot` splits its input by the day each TURN started, using the
	 *    events' own timestamps — so historical events land in historical day
	 *    directories with no special case.
	 *  · A synthetic session with no `requestHeader()` makes `routeOf` return
	 *    `undefined`, and `snapshot()` then writes the snapshot and returns
	 *    BEFORE any model call. That is "snapshot only" mode; supplying a route
	 *    turns the identical call into a full summarization.
	 *
	 * Idempotent: the watermark is per session id, so a second run finds every
	 * range already covered and writes nothing.
	 *
	 * Defaults are conservative on purpose — `dryRun: true` reports the plan and
	 * writes nothing, `summarize: false` spends no model calls. The caller opts in
	 * to both the write and the expense.
	 *
	 * @param {{since?: string, until?: string, limit?: number, dryRun?: boolean, summarize?: boolean, sessionsDir?: string, currentSession?: any}} [request] - the request.
	 * @returns {Promise<any>} the report.
	 */
	async importHistory(request = {}) {
		const dryRun = request.dryRun !== false;
		const summarize = request.summarize === true;
		const dateRe = /^\d{4}-\d{2}-\d{2}$/;
		const since = typeof request.since === 'string' && dateRe.test(request.since) ? request.since : null;
		const until = typeof request.until === 'string' && dateRe.test(request.until) ? request.until : null;
		const limit = Number.isFinite(request.limit) ? Math.max(0, Math.trunc(request.limit)) : Number.POSITIVE_INFINITY;
		const sessionsDir = typeof request.sessionsDir === 'string' && request.sessionsDir.length > 0
			? request.sessionsDir
			: joinPath(this.config.dshHome, 'sessions');
		if (!existsSync(sessionsDir)) return { ok: false, error: `session log directory not found: ${sessionsDir}` };

		const timezone = this.config.timezone;
		const dayOf = (ms) => localParts(new Date(ms), timezone).dateText;

		const logs = discoverSessionLogs(sessionsDir);
		const plan = [];
		for (const log of logs) {
			const parsed = readSessionLog(log.file);
			if (parsed === undefined) continue;
			const days = daysOfTurns(parsed.events, dayOf).filter((day) => isRecordableDate(day));
			if (days.length === 0) continue;
			const first = days[0];
			const last = days[days.length - 1];
			if (since !== null && last < since) continue;
			if (until !== null && first > until) continue;
			plan.push({
				id: log.id ?? parsed.id ?? 'unknown',
				file: log.file,
				cwd: parsed.cwd,
				days,
				events: parsed.events,
				// `toSeq` has to clear the log's highest seq: the watermark walk
				// compares against this session's own numbering.
				seq: maxSeq(parsed.events) + 1
			});
		}
		plan.sort((left, right) => String(left.days[0]).localeCompare(String(right.days[0])));
		const chosen = Number.isFinite(limit) ? plan.slice(0, limit) : plan;

		const overview = {
			sessionsDir,
			mode: summarize ? 'snapshot + summary' : 'snapshot only',
			dryRun,
			discovered: logs.length,
			importable: plan.length,
			selected: chosen.length,
			span: chosen.length === 0 ? null : `${chosen[0].days[0]} → ${chosen[chosen.length - 1].days[chosen[chosen.length - 1].days.length - 1]}`,
			sessions: chosen.map((session) => ({
				id: session.id,
				dayCount: session.days.length,
				from: session.days[0],
				to: session.days[session.days.length - 1],
				events: session.events.length,
				cwd: session.cwd ?? null
			}))
		};
		if (dryRun) return { ok: true, ...overview, note: 'dry run — nothing written; call again with dryRun:false to import' };

		// Summarization needs a REAL provider/model: a fabricated route would be
		// handed to the llm service and fail. The caller passes the session it is
		// running in, and that route is reused for every imported snapshot.
		const route = summarize ? this.routeOf(request.currentSession) : undefined;
		if (summarize && route === undefined) {
			return { ok: false, error: 'summarize needs currentSession with a resolvable provider/model route', ...overview };
		}

		const stamp = localParts(new Date(Date.now()), timezone).stamp;
		const results = [];
		for (const session of chosen) {
			try {
				// Every day this session touches needs its node chain BEFORE the
				// pipeline appends to it: `snapshot()` only ensures the CURRENT day,
				// and an import's days are all in the past.
				for (const day of session.days) {
					await ensureNode({ root: this.config.root, dateText: day, stamp, mutex: this.mutex });
				}
				const synthetic = {
					id: session.id,
					seq: session.seq,
					header: { cwd: session.cwd ?? process.cwd() },
					snapshotEvents: () => session.events
				};
				if (route !== undefined) synthetic.requestHeader = () => ({ config: route });
				const report = await this.snapshot({ session: synthetic, trigger: 'import' });
				// In snapshot-only mode `snapshot()` returns before the roll-up
				// refresh, so the day's snapshot INDEX still reads "no snapshots yet"
				// — the file would exist but be undiscoverable from the day it
				// belongs to, which is the same as not having imported it. Refresh
				// each touched day explicitly.
				if (report?.status === 'written') {
					for (const day of session.days) {
						await recomputeRollups({ root: this.config.root, dateText: day, stamp, mutex: this.mutex });
					}
				}
				results.push({ id: session.id, status: report?.status ?? 'unknown', covered: report?.covered ?? null, days: session.days.length });
			} catch (error) {
				// One unreadable log must not abort the rest: a partial import is
				// still worth having, and the failure is reported per session.
				results.push({ id: session.id, status: 'failed', error: String(error?.message ?? error) });
			}
		}
		return {
			ok: true,
			...overview,
			dryRun: false,
			written: results.filter((entry) => entry.status === 'written').length,
			empty: results.filter((entry) => entry.status === 'empty').length,
			failed: results.filter((entry) => entry.status === 'failed').length,
			results
		};
	}

	async snapshot({ session, trigger, signal }) {
		if (!SNAPSHOT_TRIGGERS.includes(trigger)) throw new TypeError(`memory-tree: unknown trigger ${JSON.stringify(trigger)}`);
		const root = this.config.root;
		const state = this.stateFor(session.id);
		// `new Date(Date.now())` rather than `new Date()`: identical wall-clock
		// reading, but it goes through the one clock a caller can stub. The test
		// suite freezes `Date.now` to land the pipeline on a known date, and with
		// plain `new Date()` that freeze did nothing — harmless for as long as the
		// real date happened to match the fixture, and fatal the moment the real
		// date rolled over, because the tests then wrote to one day and read
		// another. A clock a test cannot control is a clock that hides bugs until
		// midnight.
		const parts = localParts(new Date(Date.now()), this.config.timezone);
		if (!isRecordableDate(parts.dateText)) return { status: 'skipped', reason: 'before the tree start date' };
		await ensureNode({ root, dateText: parts.dateText, stamp: parts.stamp, mutex: this.mutex });
		const events = sessionEvents(session);
		const measurement = this.measure(session);
		const route = this.routeOf(session);
		// Reset the pressure anchor. Whatever trigger brought us here, the context
		// as of this snapshot is now recorded, so pressure must wait for real
		// growth before firing again — otherwise the next step sees the same
		// over-threshold reading and snapshots again immediately.
		if (measurement !== undefined) state.pressureAnchorTokens = measurement.tokens;
		state.phase = 'slice';
		const written = await writeSnapshot({
			root,
			dateText: parts.dateText,
			time: { hour: parts.hour, minute: parts.minute, second: parts.second },
			stamp: parts.stamp,
			trigger,
			session: { id: session.id, seq: typeof session.seq === 'number' ? session.seq : events.length },
			cwd: session.header?.cwd ?? process.cwd(),
			route: route ?? { provider: 'unknown', model: 'unknown' },
			events,
			contextTokens: measurement?.tokens ?? 0,
			maxBytes: this.config.maxSliceBytes,
			// A turn belongs to the day the HUMAN sent its message, so the day of a
			// record is decided by the events, not by when the snapshot happens to
			// run. A timestamp that cannot be trusted falls back to today rather than
			// inventing a directory (an epoch of 0 would otherwise create a 1970
			// node and pollute the tree forever).
			dayOf: (epochMs) => {
				if (!Number.isFinite(epochMs) || epochMs <= 0) return parts.dateText;
				const text = localParts(new Date(epochMs), this.config.timezone).dateText;
				return isRecordableDate(text) ? text : parts.dateText;
			},
			mutex: this.mutex
		});
		if (written.status === 'empty') {
			this.stats.emptySnapshots += 1;
			return { status: 'empty', reason: 'no new events since the last snapshot' };
		}
		// A range that crossed midnight produced one file per day. Each of those
		// days needs its node chain, and every day but the last one needs to SAY
		// that it is unfinished — otherwise a reader of the 13th finds a record
		// that stops at 23:59 with no indication that the work continued.
		const segments = written.segments ?? [written];
		// Everything below — the day summary, the model calls, the roll-ups — belongs
		// to the day the NEWEST content landed in, which is not necessarily today:
		// when a range is split across midnight, the newest segment may be the one
		// filed under today and may equally be the one filed under yesterday (a
		// snapshot taken at 00:05 covering only pre-midnight turns). Appending the
		// entries to `parts.dateText` instead would put the 14th's work into the
		// 13th's day file on exactly the boundary this whole split exists to handle.
		const primaryDate = segments[segments.length - 1].dateText;
		const layout = nodePaths(root, primaryDate);
		if (segments.length > 1) {
			for (const segment of segments) {
				await ensureNode({ root, dateText: segment.dateText, stamp: parts.stamp, mutex: this.mutex });
			}
			for (let index = 0; index < segments.length - 1; index += 1) {
				const segment = segments[index];
				const next = segments[index + 1];
				try {
					await appendDaySummary({
						dayFile: nodePaths(root, segment.dateText).dayFile,
						entries: [
							`⚠️ **本日在这里中断，任务未完成**：会话跨过午夜仍在继续，本段只覆盖到 #${segment.toSeq}，`
							+ `接续内容记在 **${next.dateText}**（从 #${next.fromSeq} 开始）。`
						],
						clock: clockOfEpoch(segment.endTime),
						stamp: parts.stamp,
						maxChars: this.config.dayEntryChars
					});
				} catch (error) {
					this.note(error, 'cross-midnight note');
				}
			}
		}
		this.stats.snapshots += 1;
		const report = {
			status: 'written',
			file: written.file,
			path: written.path,
			bytes: written.bytes,
			covered: written.covered,
			range: `#${written.fromSeq}–#${written.toSeq}`,
			truncated: written.truncated,
			...(segments.length > 1 ? { segments: segments.map((segment) => ({ date: segment.dateText, file: segment.file, range: `#${segment.fromSeq}–#${segment.toSeq}` })) } : {}),
			trigger
		};
		if (route === undefined) {
			report.summary = { ok: false, error: 'no provider/model route is known for this session yet' };
			return report;
		}
		// Call 1: what is NEW in this slice. Its answer is a delta that gets
		// appended to the day's event list and can never remove an entry — which
		// is the whole reason the region is a log rather than one prose blob.
		state.phase = 'day';
		const clock = `${pad(parts.hour)}:${pad(parts.minute)}`;
		const dayBefore = await readIfExists(layout.dayFile);
		const regionBefore = dayBefore === undefined ? '' : regionText(dayBefore, DAY_SUMMARY_REGION);
		const dayResult = await summarizeDay({
			llm: this.llm(),
			route,
			sessionId: session.id,
			signal,
			maxTokens: this.config.maxTokens,
			timeoutMs: this.config.timeoutMs,
			plugin: 'dsh-memory-tree',
			dateText: parts.dateText,
			trigger,
			slice: windowSlice(written.slice, this.config.maxInputChars),
			truncated: written.truncated,
			recent: recentEntries(regionBefore, this.config.dayEntryRecent),
			turnLog: await this.#turnLogTail(layout.dayFile)
		});
		this.stats.dayCalls += 1;
		let newest = undefined;
		if (!dayResult.ok) {
			this.stats.callFailures += 1;
			this.note(dayResult.error ?? 'unknown error', 'day entry call');
			report.summary = { ok: false, error: dayResult.error };
			// Say so IN SEQUENCE. With an append-only log there is no previous text
			// to protect, so the honest record of a failed call is a gap at the
			// point in time where the gap happened — appended, like everything else.
			// Writing nothing is what let a whole session of max-tokens failures
			// look like a day that simply had less in it.
			try {
				await appendDaySummary({
					dayFile: layout.dayFile,
					entries: [`⚠️ 本次快照（${trigger}）的事件条目生成失败：\`${dayResult.error ?? 'unknown error'}\`。逐字原文已落盘，见快照索引。`],
					clock,
					stamp: parts.stamp,
					maxChars: this.config.dayEntryChars
				});
			} catch (error) {
				// Reporting a failure must not itself become the failure that stops
				// the snapshot: the verbatim slice is already durable at this point.
				this.note(error, 'day entry failure notice');
			}
		} else if (dayResult.entries.length > 0) {
			const appended = await appendDaySummary({
				dayFile: layout.dayFile,
				entries: dayResult.entries.slice(0, this.config.dayEntryMax),
				clock,
				stamp: parts.stamp,
				maxChars: this.config.dayEntryChars
			});
			newest = appended.added.length === 0 ? undefined : appended.added[appended.added.length - 1].text;
			report.summary = {
				ok: true,
				...(dayResult.gist === undefined ? {} : { gist: dayResult.gist }),
				added: appended.added.length,
				total: appended.total,
				migrated: appended.migrated,
				// Echo what was actually recorded. The caller of `memory_snapshot` is
				// an agent deciding whether its own work got captured; a pair of
				// counts tells it nothing about that.
				entries: appended.added.map((entry) => `${entry.clock} ${entry.text}`),
				...(appended.added.length === dayResult.entries.length ? {} : { dropped: dayResult.entries.length - appended.added.length })
			};
			if (appended.added.length === 0) report.summary.duplicates = dayResult.entries.length;
		} else {
			// No entries, but the slice still gets its own index line: "nothing worth
			// an event" and "nothing happened" are different, and the index row is
			// what a reader navigates by.
			report.summary = {
				ok: true,
				...(dayResult.gist === undefined ? {} : { gist: dayResult.gist }),
				added: 0,
				nothing: dayResult.nothing === true
			};
		}
		// Call 2: the day's own line, plus month, year, and long-term gists.
		//
		// The day's line belongs HERE and not in call 1. It replaces a single index
		// line, which is only safe because what it summarises is the permanent list
		// one level down — so it can be recomputed from the WHOLE day every time
		// instead of being carried forward from the model's last answer. Carrying
		// it forward is what collapsed the month, the year and `longterm.md` onto
		// the newest event: four levels, each one a lossy rewrite of the one below.
		if (this.config.rollup) {
			state.phase = 'upper';
			const dayAfter = await readIfExists(layout.dayFile);
			report.upper = await this.#refreshUpperLevels({
				root,
				layout,
				parts,
				route,
				session,
				signal,
				daySummary: dayAfter === undefined ? '' : regionText(dayAfter, DAY_SUMMARY_REGION)
			});
		}
		// The snapshot's own header line, which becomes its row in the day's index.
		// It must describe THIS slice: the index is how a day is navigated, and
		// stamping the day's whole-day line into each new row made the index repeat
		// one sentence instead of indexing anything. `newest` is the fallback for a
		// call that produced entries but no one-liner; a failed call leaves the
		// placeholder in place, exactly as before.
		const gist = dayResult.gist ?? newest;
		if (gist !== undefined) await stampSnapshotSummary(written.path, truncate(gist, 160));
		// Earlier segments answered no summary call — the model was given the newest
		// slice, which is the one whose content "now" is about. Leaving them on the
		// placeholder would put `（摘要生成中）` in the index forever, so they get a
		// pointer instead: honest about having no summary of their own, and still
		// useful to whoever is reading that day's index.
		for (const segment of segments.slice(0, -1)) {
			await stampSnapshotSummary(segment.path, `跨午夜片段：本段属于 ${segment.dateText}，摘要归入 ${segments[segments.length - 1].dateText} 的记录`);
		}
		// Every day the range touched has a new index row, so every one of them needs
		// its roll-ups recomputed — including the earlier day, whose snapshots and
		// counts just changed.
		const rollupDays = segments.length > 1 ? [...new Set(segments.map((segment) => segment.dateText))] : [primaryDate];
		if (!this.config.rollup && newest !== undefined) {
			// With the roll-up call switched off there is no whole-day line to be had,
			// so the day's index row degrades to its newest entry. Stated in the
			// README: `rollup: false` costs every level above the day.
			await writeNodeSummary(layout.dayFile, truncate(newest, 160), parts.stamp);
		}
		state.phase = 'rollup';
		report.rollups = [];
		for (const dateText of rollupDays) {
			const rollups = await recomputeRollups({ root, dateText, stamp: parts.stamp, mutex: this.mutex });
			report.rollups.push(...rollups.updated);
			this.stats.rollups += rollups.updated.length;
		}
		return report;
	}

	/**
	 * Read the tail of a day's mechanical log, for the summary prompt.
	 * @param {string} dayFile - the day file.
	 * @returns {Promise<string|undefined>} the last few rows.
	 */
	async #turnLogTail(dayFile) {
		const text = await readIfExists(dayFile);
		if (text === undefined) return undefined;
		const body = regionText(text, TURNLOG_REGION);
		if (body.length === 0) return undefined;
		return body.split('\n').slice(-12).join('\n');
	}

	/**
	 * Refresh the day, month, year, and long-term gists with one model call.
	 * @param {{root: string, layout: any, parts: any, route: {provider: string, model: string}, session: any, signal?: AbortSignal, daySummary: string}} input - request.
	 * @returns {Promise<any>} a diagnostic record.
	 */
	async #refreshUpperLevels({ root, layout, parts, route, session, signal, daySummary }) {
		const { year, month, day } = layout.date;
		const monthRows = await collectMonthRows(root, year, month);
		const yearRows = await collectYearRows(root, year);
		const longtermRows = await collectLongtermRows(root);
		const label = (rows, key, suffix) => rows
			.filter((row) => row.summary !== PLACEHOLDER)
			.map((row) => `${row[key]}${suffix}: ${row.summary}`);
		const previous = {
			day: await readNodeSummary(layout.dayFile),
			month: await readNodeSummary(layout.monthFile),
			year: await readNodeSummary(layout.yearFile),
			longterm: await readNodeSummary(layout.longterm)
		};
		const result = await summarizeUpper({
			llm: this.llm(),
			route,
			sessionId: session.id,
			signal,
			maxTokens: this.config.maxTokens,
			timeoutMs: this.config.timeoutMs,
			plugin: 'dsh-memory-tree',
			monthLabel: `${year}-${month}`,
			yearLabel: year,
			// The day's own line is recomputed from the WHOLE day every time. Its
			// input is the permanent entry log, so this is a compression of the day
			// and not a rewrite of the previous answer — which is what keeps the
			// month, year and long-term rows describing a unit rather than its tail.
			daySummary,
			// Today is excluded here because its full entry list is supplied above;
			// passing both would show the same day twice, once stale.
			monthGists: label(monthRows.filter((row) => row.day !== day), 'day', '日'),
			yearGists: label(yearRows, 'month', '月'),
			allYears: label(longtermRows, 'year', '年'),
			previous: {
				day: previous.day === PLACEHOLDER ? undefined : previous.day,
				month: previous.month === PLACEHOLDER ? undefined : previous.month,
				year: previous.year === PLACEHOLDER ? undefined : previous.year,
				longterm: previous.longterm === PLACEHOLDER ? undefined : previous.longterm
			}
		});
		this.stats.upperCalls += 1;
		if (!result.ok) {
			this.stats.callFailures += 1;
			this.note(result.error ?? 'unknown error', 'roll-up call');
			return { ok: false, error: result.error };
		}
		if (result.day !== undefined) await writeNodeSummary(layout.dayFile, result.day, parts.stamp);
		if (result.month !== undefined) await writeNodeSummary(layout.monthFile, result.month, parts.stamp);
		if (result.year !== undefined) await writeNodeSummary(layout.yearFile, result.year, parts.stamp);
		if (result.longterm !== undefined) await writeNodeSummary(layout.longterm, result.longterm, parts.stamp);
		return { ok: true, day: result.day, month: result.month, year: result.year, longterm: result.longterm };
	}

	// ── reads (used by the tools) ──────────────────────────────────────────

	/**
	 * Resolve and read one tree node for the drill-down tool.
	 * @param {{level: string, date?: string, file?: string, maxChars?: number}} request - the read request.
	 * @returns {Promise<{ok: boolean, path?: string, text?: string, truncated?: boolean, next?: string[], error?: string}>} the node.
	 */
	async read(request) {
		const level = String(request?.level ?? '');
		const maxChars = Math.min(Number(request?.maxChars) > 0 ? Number(request.maxChars) : this.config.readMaxChars, 400_000);
		// Both branches must produce the SAME keys: `levelPath` returns
		// `dateText`, so a snapshot target built with `date` made every
		// drill-down hint read `undefined` (the bug that printed
		// "date=undefined" in the tool's next-step line).
		let target;
		if (level === 'snapshot') {
			const dateText = String(request?.date ?? '');
			const file = String(request?.file ?? '');
			if (!SNAPSHOT_RE.test(file) || file.includes('/') || file.includes('\\')) {
				return { ok: false, error: `"${file}" is not a snapshot file name (expected e.g. 2026-09-13T043012-pressure-deadbeef.md)` };
			}
			try {
				const layout = nodePaths(this.config.root, dateText);
				target = { path: joinPath(layout.dayDir, file), level, dateText };
			} catch (error) {
				return { ok: false, error: String(error.message ?? error) };
			}
		} else {
			try {
				target = levelPath(this.config.root, level, request?.date === undefined ? undefined : String(request.date));
			} catch (error) {
				return { ok: false, error: String(error.message ?? error) };
			}
		}
		const text = await readIfExists(target.path);
		if (text === undefined) {
			return { ok: false, path: target.path, error: `no such node yet (the tree creates a level only once it has content): ${target.path}` };
		}
		const clipped = text.length > maxChars;
		return {
			ok: true,
			path: target.path,
			level: target.level,
			date: target.dateText,
			text: clipped ? `${text.slice(0, maxChars)}\n\n…（已截断，完整文件 ${text.length} 字符）` : text,
			truncated: clipped,
			next: this.#nextHints(target)
		};
	}

	/**
	 * Suggest the next drill-down step after reading a node.
	 * @param {{level: string, dateText?: string, path: string}} target - the node that was read.
	 * @returns {string[]} hint lines.
	 */
	#nextHints(target) {
		const root = this.config.root.replace(/[\\/]+$/, '');
		// Built with `joinPath`, so the hint names the path this tree ACTUALLY
		// has. A hint written with a literal backslash reads as an instruction —
		// and on a POSIX root it would point at a file that does not exist.
		const year = target.dateText?.slice(0, 4);
		const month = target.dateText?.slice(5, 7);
		switch (target.level) {
			case 'index':
				return [`next: read longterm.md → ${joinPath(root, 'longterm.md')}`];
			case 'longterm':
				return [`next: pick a year, then read ${joinPath(root, '<年>', '<年>.md')}`];
			case 'year':
				return [`next: pick a month, then read ${joinPath(root, year, '<月>', `${year}-<月>.md`)}`];
			case 'month':
				return [`next: pick a day, then read ${joinPath(root, year, month, '<日>', `${year}-${month}-<日>.md`)}`];
			case 'day':
				return [`next: read one snapshot with level=snapshot, date=${target.dateText}, file=<the name from the index>`];
			case 'snapshot':
				return [];
			default:
				return [];
		}
	}

	/**
	 * Search index and roll-up lines for a keyword.
	 * @param {{query: string, includeSnapshots?: boolean, limit?: number}} request - the search request.
	 * @returns {Promise<{ok: boolean, matches: Array<{file: string, line: number, text: string}>, scanned: number, error?: string}>} the matches.
	 */
	async search(request) {
		const query = String(request?.query ?? '').trim();
		if (query.length === 0) return { ok: false, matches: [], scanned: 0, error: 'query must not be empty' };
		const needle = query.toLowerCase();
		const limit = Number(request?.limit) > 0 ? Math.min(Number(request.limit), 200) : 40;
		const includeSnapshots = request?.includeSnapshots === true;
		const files = await this.#treeFiles(includeSnapshots);
		const matches = [];
		let scanned = 0;
		for (const file of files) {
			const text = await readIfExists(file);
			if (text === undefined) continue;
			scanned += 1;
			const lines = text.split('\n');
			for (let index = 0; index < lines.length; index += 1) {
				if (!lines[index].toLowerCase().includes(needle)) continue;
				matches.push({
					file: file.slice(this.config.root.replace(/[\\/]+$/, '').length + 1),
					line: index + 1,
					text: lines[index].trim().slice(0, 400)
				});
				if (matches.length >= limit) return { ok: true, matches, scanned, truncated: true };
			}
		}
		return { ok: true, matches, scanned };
	}

	/**
	 * List the tree's text files, newest-agnostic and excluding snapshots by default.
	 * @param {boolean} includeSnapshots - whether to include snapshot bodies.
	 * @returns {Promise<string[]>} absolute file paths.
	 */
	async #treeFiles(includeSnapshots) {
		const root = this.config.root.replace(/[\\/]+$/, '');
		const output = [];
		for (const name of ['index.md', 'longterm.md']) {
			output.push(joinPath(root, name));
		}
		for (const year of await this.#subdirs(root)) {
			output.push(joinPath(root, year, `${year}.md`));
			for (const month of await this.#subdirs(joinPath(root, year))) {
				output.push(joinPath(root, year, month, `${year}-${month}.md`));
				for (const day of await this.#subdirs(joinPath(root, year, month))) {
					const dayDir = joinPath(root, year, month, day);
					output.push(joinPath(dayDir, `${year}-${month}-${day}.md`));
					if (includeSnapshots) {
						output.push(...(await listSnapshots(dayDir)).map((snapshot) => joinPath(dayDir, snapshot.file)));
					}
				}
			}
		}
		return output;
	}

	/**
	 * List numeric subdirectories of one tree directory.
	 * @param {string} dir - the directory.
	 * @returns {Promise<string[]>} sorted directory names.
	 */
	async #subdirs(dir) {
		return (await listDir(dir)).filter((entry) => entry.isDirectory && /^\d{2,4}$/.test(entry.name)).map((entry) => entry.name);
	}

	/**
	 * Verify the plugin's model call path end to end.
	 *
	 * What this actually proves is TRANSPORT: the route resolves, the service
	 * streams, and the chunk protocol is what the assembler expects. Whether the
	 * answer is complete depends on the model's own token budget — on the first
	 * live run a 32-token budget was entirely consumed by *reasoning* (this route
	 * is a reasoning model), so no text block ever arrived. The report therefore
	 * separates the two: `transport` is the verdict, `text`/`finish` are evidence.
	 * @param {{session: any, signal?: AbortSignal}} input - the probe request.
	 * @returns {Promise<any>} the probe report.
	 */
	async probe({ session, signal }) {
		const route = this.routeOf(session);
		this.stats.probes += 1;
		if (route === undefined) return { ok: false, transport: 'no-route', error: 'no provider/model route is known for this session yet' };
		const result = await runCall({
			llm: this.llm(),
			route,
			// A reasoning model needs room to think before it answers; too small a
			// budget yields reasoning chunks and a `max-tokens` finish.
			system: '你是一个连通性探测端点。直接输出用户要求的那两个字，不要思考、不要解释。',
			user: '只回复两个字：正常',
			maxTokens: 512,
			sessionId: session.id,
			signal,
			timeoutMs: 60_000,
			plugin: 'dsh-memory-tree'
		});
		const transport = result.chunks > 0 && result.failure === undefined ? 'ok' : 'failed';
		return {
			ok: transport === 'ok',
			transport,
			route,
			text: result.text,
			producedText: result.text.length > 0,
			chunks: result.chunks,
			observedChunkTypes: result.observed,
			finish: result.finish,
			failure: result.failure,
			error: result.error
		};
	}
}
