/**
 * Cross-session-reference detection, and the reminder injected when one fires.
 *
 * Why a message injection and not a `systemPrompt.variable()` provider:
 * `AgentLoop.preStep()` assembles the system prompt BEFORE dispatching
 * `agent/pre-step` — verified against `@deepseek-ai/dsh-agent-loop`, where
 * `systemPrompt.assemble(assembleContextFor(...))` runs first and only then
 * `dispatch.waterfall('agent/pre-step', {...})`. A variable provider therefore
 * observes the PREVIOUS step's state, so a reminder written there lands one
 * step too late — exactly when the human has just referred back to earlier work
 * and needs the pointer *now*.
 *
 * The injection shape is copied from `@deepseek-ai/dsh-time-context`, which
 * appends to `decision.messages` in this same hook. Nothing is imported: this
 * plugin declares no runtime dependencies, so the message is built by hand from
 * the shape `createUserMessage` really produces, read from
 * `@deepseek-ai/dsh-llm/lib/types/message.js`:
 *
 *     createUserMessage(input) = freezeMessage({ ...input, role: 'user' })
 *     createMessage(input)     = freezeMessage({ ...input, id: brandString(randomUUID()) })
 *     freezeMessage(message)   = deepFreeze(structuredClone(message))
 *
 * `source.kind` is the plugin's **producer-owned** kind, never `'user'`: DSH and
 * this plugin both use that tag to tell injected context apart from what the
 * human actually typed.
 *
 * DSH 0.1.7 persists sessions as **format v4**, whose admission rule (read from
 * `@deepseek-ai/dsh-session-persistence-jsonl/lib/worker.cjs`) rejects the
 * retired v3 wrapper outright:
 *
 *     if (… || value.kind.length === 0 || value.kind === 'plugin') throw …
 *     "format v4 message requires a producer-owned source kind"
 *
 * so a bare `kind: 'plugin'` + `plugin:` field makes the WHOLE TURN fail to
 * persist (observed 2026-09-28: every reminder-carrying turn died with that
 * error). v4 wants `plugin:<package name>`, which is exactly what its own
 * v3→v4 migration (`producerKind()`) rewrites the legacy wrapper into.
 * @module dsh-memory-tree/reminder
 */
import { randomUUID } from 'node:crypto'

/** Matches the plugin's registered `name`, so injected messages are traceable. */
const PLUGIN = 'dsh-memory-tree'

/**
 * The producer-owned `source.kind` this plugin must declare on v4 sessions.
 * The legacy wrapper (`kind: 'plugin'` + `plugin: <name>`) is refused by the v4
 * admission check, so it is only ever *read*, never written.
 */
const PLUGIN_KIND = `plugin:${PLUGIN}`

/** The retired v3 wrapper kind, still accepted when reading older logs. */
const LEGACY_PLUGIN_KIND = 'plugin'

/**
 * Phrases that signal the human is reaching back to earlier work.
 *
 * Deliberately conservative. A miss costs a missed hint, but a false positive
 * spends context and nags on every unrelated turn — and "之前" alone is far too
 * common to be a signal ("运行之前的命令"), so only the *cross-session* forms
 * are listed.
 */
export const SIGNALS = [
	// Explicit references to earlier sessions or earlier work.
	'上次', '上回', '上一轮', '上轮', '前几轮', '前几天', '早先', '先前',
	'之前我们', '我们之前', '我们上次', '我们不是', '我们讨论过', '我们说过', '我们决定过',
	// Explicit requests to recall.
	'还记得', '记不记得', '记得我们', '当时的结论', '当时我们',
	// Resuming a historical thread.
	'接着上次', '继续上次', '说到哪', '进行到哪', '继续之前',
	// English equivalents.
	'last time', 'earlier we', 'previously', 'we discussed', 'we agreed', 'you remember'
]

/**
 * Find the first signal phrase in one piece of text.
 * @param {string} text - the human's message text.
 * @returns {string|undefined} the phrase that fired, if any.
 */
export function detectSignal(text) {
	if (typeof text !== 'string' || text.length === 0) return undefined
	const haystack = text.toLowerCase()
	for (const signal of SIGNALS) {
		if (haystack.includes(signal.toLowerCase())) return signal
	}
	return undefined
}

/**
 * The reminder shown to the model when a cross-session reference fires.
 *
 * It names the phrase that fired so the model can judge for itself, states the
 * cheap way to read the tree, and explicitly licenses ignoring the note — a
 * reminder that cannot be dismissed becomes noise on every borderline match.
 * @param {string} signal - the phrase that fired.
 * @param {string} root - the memory tree root.
 * @returns {string} the reminder text.
 */
export function reminderText(signal, root) {
	const clean = String(root ?? '').replace(/[\\/]+$/, '')
	return [
		`[记忆提醒] 本轮消息命中了跨会话引用的信号「${signal}」，但**是否需要历史信息由你判断**。`,
		`如果你需要当前上下文里没有的东西——某个决定为什么这么定、某个文件为什么这么写、以前踩过什么坑——先查再答，不要凭印象：`,
		`\`memory_search\` 按关键词定位到日期，再用 \`memory_read\` 只钻到需要的那一级（树在 \`${clean}\`）。`,
		`如果这轮其实不需要历史信息，忽略本提醒，照常作答即可。`
	].join('\n')
}

/**
 * Build the user-role message that carries a reminder.
 *
 * Shape mirrors `createUserMessage` exactly (see the module note); frozen like
 * the real thing so downstream code that assumes immutability stays correct.
 * @param {string} text - the reminder text.
 * @returns {any} a message ready to append to `decision.messages`.
 */
export function reminderMessage(text) {
	return Object.freeze({
		id: randomUUID(),
		role: 'user',
		content: Object.freeze([Object.freeze({ type: 'text', text })]),
		source: Object.freeze({
			kind: PLUGIN_KIND,
			form: 'snapshot',
			sections: Object.freeze([Object.freeze({ name: PLUGIN, text })])
		})
	})
}

/**
 * Whether a message was injected by this plugin rather than typed by a human.
 *
 * Accepts both the current producer-owned kind and the retired v3 wrapper, so
 * reminders already written into older logs stay recognised.
 * @param {any} message - a candidate message.
 * @returns {boolean} true when this plugin produced it.
 */
export function isOurReminder(message) {
	const kind = message?.source?.kind
	if (kind === PLUGIN_KIND) return true
	return kind === LEGACY_PLUGIN_KIND && message?.source?.plugin === PLUGIN
}
