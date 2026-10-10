/**
 * dsh-memory-tree — cross-session memory as a lazily grown, time-layered tree.
 *
 * Structure and rules: `<MEMORY_ROOT>\index.md` (the normative spec).
 *
 * What this plugin does:
 *   * records ONE mechanical line per turn (no model call) into the day file,
 *   * writes a verbatim snapshot when context pressure passes a threshold, when
 *     a compaction starts, on demand, or every N turns,
 *   * refreshes all four summary levels from that snapshot with two model
 *     calls, and recomputes every roll-up table from the filesystem,
 *   * exposes five-level drill-down tools so a future session can walk
 *     long-term → year → month → day → one snapshot cheaply.
 *
 * What it never does: rewrite `index.md`, touch text outside a sentinel
 * region, delete anything, or create a directory that has no content.
 */

import { MemoryService, resolveConfig, thresholdFor, DEFAULT_CONFIG } from './service.js';
import { treeOverview } from './tree.js';
import { joinPath, localParts } from './paths.js';
import { reminderMessage } from './reminder.js';
import { planAssets, writeBackup } from './backup.js';

export const name = 'dsh-memory-tree';

export const inject = ['tools', 'systemPrompt'];

/** Version reported by `memory_status`. */
export const VERSION = '0.1.0';

/** Wrap a multi-line string into a single tool-result text block. */
function text(value) {
	return [{ type: 'text', text: String(value) }];
}

/** Shared tool output contract. */
const OUTPUT = {
	schema: {
		type: 'object',
		additionalProperties: false,
		properties: { text: { type: 'string' } },
		required: ['text']
	},
	render: (_args, value) => text(value.text)
};

/**
 * Append this step's cross-session reminder, when one is due.
 *
 * Runs after `next()` so it sees the final decision, and returns that decision
 * by reference when there is nothing to add — so the "returns the upstream
 * decision unchanged" contract still holds exactly.
 * @param {any} service - the memory service.
 * @param {any} payload - the pre-step payload.
 * @param {any} decision - the final pre-step decision.
 * @returns {any} the decision, possibly carrying one more message.
 */
async function withReminder(service, payload, decision) {
	if (decision?.kind !== 'enter' || !Array.isArray(decision.messages)) return decision;
	if (payload?.signal?.aborted) return decision;
	const extra = [];
	const reminder = service.reminderFor(payload);
	if (reminder !== undefined) extra.push(reminderMessage(reminder.text));
	// The recall note goes through the same door as the reminder: one message
	// appended before the step. It is async (~5 ms) on purpose — a note that
	// arrives a turn late is worse than no note.
	const recall = await service.routerFor(payload);
	if (recall !== undefined) extra.push(reminderMessage(recall.text));
	if (extra.length === 0) return decision;
	return { ...decision, messages: [...decision.messages, ...extra] };
}

/**
 * The system-prompt note that makes the tree discoverable without a briefing.
 *
 * Kept to a few lines on purpose: the tree's own `index.md` carries the full
 * protocol, and this note's only job is to say where it is and that drilling
 * down level by level is the cheap way to read it.
 *
 * It carries the *judgement* — which signals mean "go read the tree" — because
 * that is knowledge about the memory system and belongs beside it. The persona
 * only carries the *attitude* of using it. Being a system-prompt section this
 * note survives context compaction; the cross-session reminder is the other
 * half, injected per step by `withReminder` and deliberately transient.
 * @param {typeof DEFAULT_CONFIG} config - resolved configuration.
 * @returns {string} the note text.
 */
/**
* The inline client switch: a top-bar pill plus two loopback-only routes.
*
* Why a function rather than inline code in apply(): the profile may have no
* `webServer` at all (a non-web profile), and `ctx.inject(['webServer'])` with a
* service nobody provides fails the WHOLE plugin tree (PITFALLS #33), so this
* reaches for it defensively and quietly does nothing when it is absent.
*
* The desktop shell collects `webserver/index-inject` rows ONCE at boot and they
* must be INLINE scripts: a `<script src=...>` that fails to load rejects the
* entire page boot (that is why dsh-whale-widget inlines its loader row).
* @param {any} ctx - the plugin context.
* @param {any} service - the memory service.
* @returns {void}
*/
function attachMemorySwitch(ctx, getService) {
  
/**
* A tiny poller appended after the boot-time inline client. Every minute it pulls a fresh
* copy from the plugin route and takes it over when the rev is higher — so editing
* ui-switch.js takes effect within a minute, with no restart. Deliberately NOT a script
* src: a failing src can reject the whole desktop boot (known issue), while a failed fetch
* here leaves the running copy untouched.
* @returns {string} code to append.
*/
function clientLoader() {
  const lines = [
    '',
    '/* client hot-reload: fail-safe — a failure here leaves the copy above running */',
    '(function(){',
    '  try {',
    '    var own = (document.currentScript && document.currentScript.textContent || "").match(/rev: (\\d+)/);',
    '    var rev = own ? Number(own[1]) : 0;',
    '    var poll = function(){',
    '      fetch("/dsh-memory/client.js", { cache: "no-store" }).then(function(r){ return r.ok ? r.text() : ""; }).then(function(code){',
    '        var found = code.match(/rev: (\\d+)/);',
    '        if (!found || Number(found[1]) <= rev) return;',
    '        rev = Number(found[1]);',
    '        window.__dshMemorySwitchVersion = 0;',
    '        var el = document.createElement("script");',
    '        el.setAttribute("data-dsh-memory-switch", "hot");',
    '        el.textContent = code;',
    '        document.body.appendChild(el);',
    '      }).catch(function(){});',
    '    };',
    '    setTimeout(poll, 5000);',
    '    setInterval(poll, 60000);',
    '  } catch (e) {}',
    '})();',
    ''
  ];
  return lines.join('\n');
}

const marker = '[memory-tree] switch';
  try {
    const fs = (typeof process.getBuiltinModule === 'function' ? process.getBuiltinModule('node:fs') : undefined);

    // (a) The injection row FIRST: the desktop shell collects this table ONCE
    // during boot, so the listener has to exist as early as the plugin loads.
    // The script text is read lazily, so a missing file cannot break the row.
    if (typeof ctx.on === 'function') {
      ctx.on('webserver/index-inject', (table) => {
        try {
          if (fs === undefined) throw new Error('no node:fs');
          const script = fs.readFileSync(new URL('./ui-switch.js', import.meta.url), 'utf8');
          // Client hot-reload: append a tiny poller that pulls a fresh copy from the plugin route
          // and takes over when its rev is higher, so editing ui-switch.js needs no restart.
          // Source-side fail-safe: never let the add-on take the widget down with it. A loader
          // that does not even parse is dropped here (measured 2026-10-01: a literal "\n" in
          // the generated text made the whole inline script invalid, and the pill vanished).
          const extra = clientLoader();
          let safe = '';
          try { if (extra) { new Function(extra); safe = extra; } } catch { safe = ''; }
          table.push({ kind: 'script', placement: 'body', text: script + safe });
          try { ctx.logger?.info?.(marker + ': injected the inline switch row (' + script.length + ' B)'); } catch { }
        } catch (error) {
          try { ctx.logger?.warn?.(marker + ': inject row failed: ' + String(error?.message ?? error)); } catch { }
        }
      });
    }

    // (b) The routes. `webServer` is NOT on the root context at apply() time —
    // measured: taking it with ctx.get() returned undefined and the routes were
    // silently never registered (404), while dsh-whale-widget's route answered on
    // the same server. So wait for the service the same way that plugin does.
    // NOTE: Cordis's scoped `ctx.inject(deps, cb)` simply never runs when a
    // dependency never appears; it is NOT the plugin-level `inject:` declaration
    // that fails the whole plugin tree (PITFALLS #33).
    if (typeof ctx.inject !== 'function') return;
    ctx.inject(['webServer'], (scope) => {
      try {
        const web = scope?.webServer ?? (typeof scope?.get === 'function' ? scope.get('webServer') : undefined);
        if (web === undefined || typeof web.register !== 'function') {
          try { ctx.logger?.warn?.(marker + ': webServer has no register() — the UI switch has no backend'); } catch { }
          return;
        }
        const service = () => getService();
				// The page cannot send custom headers (CORS preflight drops them — measured 2026-10-01),
				// so the session rides in the QUERY STRING and the request body instead.
				const queryOf = (req, key) => {
				  try {
				    const m = String(req?.url ?? '').match(new RegExp('[?&]' + key + '=([^&#]+)'));
				    return m ? decodeURIComponent(m[1]) : null;
				  } catch { return null; }
				};
				const sessionOf = (req, svc, bodySession) => {
				  if (typeof bodySession === 'string' && bodySession.length > 0) return bodySession;
				  const fromQuery = queryOf(req, 'session');
				  if (typeof fromQuery === 'string' && fromQuery.length > 0) return fromQuery;
				  return svc.pickSession(req);
				};
				const state = (req) => {
          const svc = service();
          return {
															autoSummary: svc.autoFor(sessionOf(req, svc)),
lastInjection: svc.injectionFor(sessionOf(req, svc)),
															lastCandidates: svc.stateFor(sessionOf(req, svc) ?? '').lastCandidates ?? null,
										// Echoed back so the host side can SEE what the page thinks it is: this is
										// how a UI problem gets diagnosed without another guess (and without the
										// desktop shell's missing logs).
										clientProbe: (req && req.headers && req.headers['x-dsh-probe']) || null,
															clientSession: (req && req.headers && req.headers['x-dsh-session']) || null,
															// The Host the page actually uses. This exists because a write was being
															// rejected with 403 (loopback-only) while the pill looked "unclickable" —
															// seeing the real Host turns that guess into a fact.
															reqHost: (req && req.headers && req.headers.host) || null,
															reqOrigin: (req && req.headers && req.headers.origin) || null,
															reqOrigin: (req && req.headers && req.headers.origin) || null,
															// Raw request facts, so the next UI question is answered by evidence, not by guessing.
															reqUrl: (req && req.url) || null,
															session: sessionOf(req, svc) ?? null,
															queryProbe: queryOf(req, 'probe'),
            includeSubagents: svc.config.includeSubagents === true,
            router: svc.config.router === true,
            routerTransport: svc.config.routerTransport ?? 'auto',
            routerError: svc.routerError(),
            routerFlowError: svc._routerFlowError ?? null,
            routerWarm: svc.routerWarm === true,
            routed: svc.stats.routed,
            routerInjected: svc.stats.routerInjected,
            routerFeedback: svc.stats.routerFeedback,
            snapshots: svc.stats.snapshots,
            now: new Date().toISOString()
          };
        };
        const json = (res, code, body) => {
          try {
            res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
            res.end(JSON.stringify(body));
          } catch { }
        };
        // Writes are loopback-only: a switch that changes behaviour should not
        // depend on another layer's fence being present.
        const loopback = (req) => {
          try {
            const host = String((req && req.headers && req.headers.host) || '').toLowerCase();
            return host === '' || host.startsWith('127.0.0.1') || host.startsWith('localhost') || host.startsWith('[::1]');
          } catch { return false; }
        };

        // `state(req)` matters: this is what makes the pill per-session. Passing no
        // request made the route ignore the page's `x-dsh-session` header and fall
        // back to "last active session" — which a background subagent can steal
        // (reported 2026-09-30: "也不是每个会话独立").
        web.register({ kind: 'exact', path: '/dsh-memory/state', handler: (req, res) => json(res, 200, state(req)) });
                // Served fresh from disk on every request: the client poller picks up edits here.
                web.register({ kind: 'exact', path: '/dsh-memory/client.js', handler: (req, res) => {
                  if (!loopback(req)) return json(res, 403, { error: 'loopback only' });
                  // Prove the in-page poller is alive — and settle whether a route BODY is live in
                  // this deployment (registration is not: it needs a restart, measured 2026-10-01).
                  try {
                    const dir = getService()?.config?.routerDataDir;
                    if (dir) fs.appendFileSync(String(dir).replace(/[\/\\]+$/, '') + '/client-fetch.jsonl', JSON.stringify({ at: new Date().toISOString(), ua: String(req.headers['user-agent'] ?? '').slice(0, 50) }) + '\n', 'utf8');
                  } catch { }
                  try {
                    const code = fs.readFileSync(new URL('./ui-switch.js', import.meta.url), 'utf8');
                    res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(code) });
                    res.end(code);
                  } catch (error) { json(res, 500, { error: String(error?.message ?? error) }); }
                } });

        web.register({
          kind: 'exact',
          path: '/dsh-memory/auto',
          handler: (req, res) => {
            try {
              const method = String((req && req.method) || 'GET').toUpperCase();
              if (method !== 'POST') return json(res, 200, state(req));
              if (!loopback(req)) return json(res, 403, { error: 'loopback only' });
              let body = '';
              req.on('data', (chunk) => { body += chunk; if (body.length > 4096) req.destroy(); });
              req.on('end', () => {
								let parsed; try { parsed = body.length > 0 ? JSON.parse(body) : {}; } catch { parsed = {}; }
								let wanted = parsed.on;
								if (parsed.pick !== undefined) {
								  const picked = service().recordPick(parsed.pick, sessionOf(req, service(), parsed.session));
								  return json(res, picked.ok ? 200 : 400, picked.ok ? Object.assign(state(req), { picked: picked.record }) : picked);
								}
if (parsed.rate !== undefined) {
									const rated = service().rateHuman(parsed.rate, sessionOf(req, service(), parsed.session));
									try { ctx.logger?.info?.(marker + ': human rating -> ' + (rated.ok ? rated.record.verdict : rated.error)); } catch { }
									return json(res, rated.ok ? 200 : 400, rated.ok ? Object.assign(state(req), { rated: rated.record }) : rated);
								}
												try { service().setAutoSummary(wanted === undefined ? undefined : wanted === true, sessionOf(req, service(), parsed.session)); } catch (error) { return json(res, 500, { error: String(error?.message ?? error) }); }
                try { ctx.logger?.info?.(marker + ': autoSummary -> ' + service().config.autoSummary); } catch { }
							json(res, 200, state(req))
              });
            } catch (error) { json(res, 500, { error: String(error?.message ?? error) }); }
          }
        });

        try { ctx.logger?.info?.(marker + ': routes /dsh-memory/state + /dsh-memory/auto registered'); } catch { }
      } catch (error) {
        try { ctx.logger?.warn?.(marker + ': route registration failed: ' + String(error?.message ?? error)); } catch { }
      }
    });
  } catch (error) {
    try { ctx.logger?.warn?.(marker + ' disabled: ' + String(error?.message ?? error)); } catch { }
  }
}
function systemPromptNote(config) {
	const root = config.root.replace(/[\\/]+$/, '');
	// Every path here is built with `joinPath` so the note names the paths this
	// tree actually has. On a POSIX root a literal backslash would describe a
	// layout that does not exist — and this text is read as an instruction.
	return [
		`跨会话持久记忆是一棵时间分层树，位于 \`${root}\`（当前会话记忆插件的根）。`,
		`**敏感信息：写入那一刻就删除或屏蔽**（2026-09-15 用户定）：不要把公网/内网 IP、openid/peerId/AppID、key/密码/token 的值写进树里——能删就删，删不掉就用 [REDACTED] 屏蔽；树是只追加的，写进去就删不掉。不要动快照名里的会话短 token 与 YAML 头的 session/fromSeq/toSeq；保留 127.0.0.1/0.0.0.0。`,
		`**要回忆过去、或刚开始一个新会话时**：先读 \`${joinPath(root, 'index.md')}\`（结构与读取协议），再逐级下钻，不要一次读完：`,
		`\`index.md\` → \`longterm.md\` → \`${joinPath('<年>', '<年>.md')}\` → \`${joinPath('<年>', '<月>', '<年>-<月>.md')}\` → \`${joinPath('<年>', '<月>', '<日>', '<年>-<月>-<日>.md')}\` → 单个快照文件。`,
		`用 \`memory_read\` 工具按 level 读取（index/longterm/year/month/day/snapshot），用 \`memory_search\` 先按关键词搜索引行定位。`,
		`**该主动去读的信号**：用户的话里出现「以前 / 上次 / 之前 / 继续 / 我们不是…」这类**跨会话引用**；任务涉及某个你并不记得的具体事实（某个决定为什么这么定、某个文件为什么这么写）；你正要做一件**以前踩过坑**的事；用户问「我们之前是怎么处理的」；**接手一个已经存在的项目或文件**；或者你刚经历压缩、觉得「刚才还在的东西想不起来了」。`,
		`**不必读**：全新的、与历史无关的任务；答案就在当前上下文里；只需要工作区事实（工作区的 \`AGENTS.md\` 已自动注入）。`,
		`**省着读**：先用 \`memory_search\` 关键词定位到日期，再用 \`memory_read\` **只钻到需要的那一级**——不要直接跳到 day/snapshot。`,
		`**静默读**（2026-10-10 用户定）：读记忆是你的**内部动作**。不要播报「我先去翻一下以前的记录」「让我查查历史」「稍等我回忆一下」这类过场——直接读了、直接用结论回答，让人感觉你的记忆是连贯的、本来就记得。只在确实查不到时才说"我没找到相关记录"。`,
		`每轮的工作会被自动记成一行机械流水；上下文压力大时会自动落快照，所以**不需要你手动保存记忆**。`
	].join('\n');
}

/**
 * Install the memory tree.
 * @param {any} ctx - the plugin context.
 * @param {Record<string, unknown>|undefined} rawConfig - plugin configuration from `cordis.patch.yml`.
 * @returns {void}
 */
export function apply(ctx, rawConfig) {
	const config = resolveConfig(rawConfig);
	// Registered before the service exists on purpose (the injection row is collected at
	// boot); the getter is lazy, so nothing touches the service until a request arrives.
	attachMemorySwitch(ctx, () => service);
	const service = new MemoryService(ctx, config);
	
	const logger = ctx.logger;

	// ── hooks ────────────────────────────────────────────────────────────
	//
	// `agent/pre-step` is a waterfall: the listener MUST return the decision
	// `next()` produces, or the loop loses its own default and the step breaks.
	// The sampling below is synchronous and schedules detached work, so the
	// request it precedes is never delayed by it.
	//
	// `prepend: true` wraps the whole chain, so `next()` resolves to the FINAL
	// decision and the reminder is appended last — the ordering
	// `dsh-time-context` uses for its runtime context. The reminder has to ride
	// the messages rather than a `systemPrompt.variable()` provider: the loop
	// assembles the system prompt *before* dispatching this hook, so a variable
	// would only ever describe the previous step.
	ctx.on('agent/pre-step', async (payload, next) => {
		try {
			service.onPreStep(payload);
		} catch (error) {
			service.note(error, 'pre-step trigger');
		}
		const decision = await next();
		try {
			return await withReminder(service, payload, decision);
		} catch (error) {
			service.note(error, 'reminder injection');
			return decision;
		}
	}, { prepend: true });

	// `agent/turn-stopping` is serial and awaited by the loop: this writes one
	// appended line, and never calls a model.
	ctx.on('agent/turn-stopping', async (payload) => {
		try {
			await service.onTurnStopping(payload);
		} catch (error) {
			service.note(error, 'turn-stopping hook');
		}
	});

	// ── tools ────────────────────────────────────────────────────────────

	ctx.tools.register({
		name: 'memory_read',
		description: [
			'Read one level of the cross-session memory tree (drill down one step at a time).',
			'* level=index: the root entry with the structure and read protocol — start here for a new session or after compaction.',
			'* level=longterm: the highest summary, one line per year.',
			'* level=year|month|day: pass `date` (yyyy-mm-dd) to read that year/month/day node.',
			'* level=snapshot: pass `date` and the snapshot `file` name taken from that day\'s index.',
			'* Every response names the next drill-down step. Reading all levels is wasteful; the tree exists to be walked.',
		].join('\n'),
		parameters: {
			type: 'object',
			properties: {
				level: {
					type: 'string',
					enum: ['index', 'longterm', 'year', 'month', 'day', 'snapshot'],
					description: 'Which tree level to read.'
				},
				date: {
					type: 'string',
					description: 'Local date yyyy-mm-dd. Required for year, month, day, and snapshot.'
				},
				file: {
					type: 'string',
					description: 'Snapshot file name, e.g. 2026-09-13T043012-pressure-deadbeef.md. Required for level=snapshot.'
				},
				maxChars: {
					type: 'number',
					description: `Truncate the returned text at this many characters (default ${config.readMaxChars}).`
				}
			},
			required: ['level'],
			additionalProperties: false
		},
		output: OUTPUT,
		async execute(args) {
			const result = await service.read(args ?? {});
			if (!result.ok) return { text: `memory_read failed — ${result.error}${result.path === undefined ? '' : `\npath: ${result.path}`}` };
			const header = [
				`path: ${result.path}`,
				`level: ${result.level}${result.date === undefined ? '' : `  date: ${result.date}`}${result.truncated ? '  (truncated)' : ''}`,
				...(result.next ?? [])
			];
			return { text: `${header.join('\n')}\n\n${result.text}` };
		}
	});

	ctx.tools.register({
		name: 'memory_search',
		description: [
			'Search the memory tree\'s index and roll-up lines for a keyword (case-insensitive substring).',
			'* Cheap: scans the small index files, not the verbatim snapshots.',
			'* Use it when you know a name, path, or term but not the date — then drill down with memory_read.',
			'* Set includeSnapshots=true to also search snapshot bodies (much larger, use sparingly).',
		].join('\n'),
		parameters: {
			type: 'object',
			properties: {
				query: { type: 'string', description: 'Keyword or phrase to find.' },
				includeSnapshots: { type: 'boolean', description: 'Also search verbatim snapshot files.' },
				limit: { type: 'number', description: 'Maximum matches to return (default 40, cap 200).' }
			},
			required: ['query'],
			additionalProperties: false
		},
		output: OUTPUT,
		async execute(args) {
			const result = await service.search(args ?? {});
			if (!result.ok) return { text: `memory_search failed — ${result.error}` };
			if (result.matches.length === 0) {
				return { text: `no match for "${args?.query}" in ${result.scanned} index file(s) — the tree may simply not have recorded it${args?.includeSnapshots === true ? '' : '; try includeSnapshots=true'}` };
			}
			const lines = result.matches.map((match) => `${match.file}:${match.line}: ${match.text}`);
			return { text: `${result.matches.length}${result.truncated === true ? '+' : ''} match(es) for "${args?.query}" in ${result.scanned} file(s):\n\n${lines.join('\n')}` };
		}
	});

	ctx.tools.register({
		name: 'memory_route',
		description: [
			'Ask the local recall router which past memories a message might relate to.',
			'* Runs the local embedding model (bge-small-zh, 512-dim) over the message and scores it against the recorded corpus.',
			'* Returns candidate days with a cosine score, or verdict "none" when nothing clears the threshold.',
			'* Cheap (~5 ms) and safe to call; it never writes to the tree. Use it to check recall by hand instead of',
			'  waiting for the automatic note. Follow up with memory_read level=day date=<date>.',
		].join('\n'),
		parameters: {
			type: 'object',
			properties: {
				query: { type: 'string', description: 'The message to route (usually the human own wording).' }
			},
			required: ['query'],
			additionalProperties: false
		},
		output: OUTPUT,
		async execute(args) {
			const result = await service.routeQuery(args ?? {});
			if (!result.ok) return { text: 'memory_route failed — ' + result.error };
			const body = result.result;
			if (body.verdict !== 'related') return { text: 'verdict: none — ' + body.reason + '（' + body.costMs + ' ms）' };
			const lines = body.candidates.map((entry) => entry.date + '  ' + entry.days + 'd  cos ' + entry.cosine);
			return { text: 'verdict: related — ' + body.reason + '\n' + lines.join('\n') + '\nread one with: memory_read level=day date=<date>' };
		}
	});

	ctx.tools.register({
		name: 'memory_route_feedback',
		description: [
			'Record whether the memories the recall router suggested were actually relevant.',
			'* Writes one scrubbed JSONL row into the tree router/ directory. This is training data for a future re-ranker',
			'  and a runtime signal — it is NOT ground truth (only the human own rating is).',
			'* Call it when you actually looked at the suggested days and can say; skip it when unsure.',
		].join('\n'),
		parameters: {
			type: 'object',
			properties: {
				query: { type: 'string', description: 'The message that was routed.' },
				dates: { type: 'array', items: { type: 'string' }, description: 'The candidate days (yyyy-mm-dd) being judged.' },
				verdict: { type: 'string', enum: ['relevant', 'partly', 'not_relevant', 'unknown'], description: 'Your judgement.' },
				note: { type: 'string', description: 'Optional one-line reason.' }
			},
			required: ['verdict'],
			additionalProperties: false
		},
		output: OUTPUT,
		async execute(args) {
			const result = await service.recordRouterFeedback(args ?? {});
			if (!result.ok) return { text: 'memory_route_feedback failed — ' + result.error };
			return { text: 'recorded (' + result.record.verdict + ') → ' + result.path };
		}
	});

	ctx.tools.register({
		name: 'memory_auto',
		description: [
			'Turn the memory tree automatic summarisation on or off, at runtime.',
			'* off: no pressure / compaction / turn-count snapshots — i.e. no automatic model calls.',
			'  The mechanical turn log keeps recording (one line per turn, zero model calls) and memory_snapshot still works by hand.',
			'* on: the configured behaviour.',
			'* Runtime only; a restart returns to the configured default.',
		].join('\n'),
		parameters: {
			type: 'object',
			properties: {
				on: { type: 'boolean', description: 'Wanted state; omit to toggle.' }
			},
			additionalProperties: false
		},
		output: OUTPUT,
		async execute(args) {
			const state = service.setAutoSummary(args?.on);
			return { text: 'automatic summarisation: ' + (state.autoSummary ? 'ON' : 'OFF') + '\n  gated: ' + state.gated.join(', ') + '\n  still on: ' + state.stillOn.join(', ') + '\n  ' + state.note };
		}
	});
	ctx.tools.register({
		name: 'memory_snapshot',
		description: [
			'Take a memory snapshot now instead of waiting for the automatic trigger.',
			'* Writes the verbatim slice of this session since the last snapshot, then refreshes all four summary levels with two model calls.',
			'* Idempotent: if nothing new happened since the last snapshot, it reports "empty" and writes nothing.',
			'* Automatic triggers already fire on context pressure (default 500k tokens) and on compaction start, so you rarely need this.',
			'* Takes tens of seconds (two model calls). Use `reason` to note why.',
		].join('\n'),
		parameters: {
			type: 'object',
			properties: {
				reason: { type: 'string', description: 'Short note about why a snapshot is wanted now.' }
			},
			required: [],
			additionalProperties: false
		},
		output: OUTPUT,
		async execute(args, exec) {
			const session = exec?.agent?.session;
			if (session === undefined) return { text: 'memory_snapshot failed — no calling session is available' };
			const report = await service.snapshot({ session, trigger: 'manual', signal: exec?.signal });
			return { text: `memory_snapshot (${args?.reason ?? 'no reason given'})\n\n${JSON.stringify(report, null, 2)}` };
		}
	});

	ctx.tools.register({
		name: 'memory_import',
		description: [
			'Replay historical session logs into the tree, so a fresh install is not memoryless on a machine that has months of conversation on disk.',
			'* Source: the DSH session logs under `<dshHome>/sessions`. It writes through the SAME snapshot pipeline a live turn uses, so an imported day is indistinguishable from a recorded one.',
			'* Idempotent. The watermark is per session id, so a second run re-reports what is already covered and writes nothing.',
			'* **Two modes.** `summarize:false` (default) writes the verbatim snapshots and costs NO model calls — fast, but the day summary stays thin. `summarize:true` runs the full pipeline (two model calls per snapshot) and needs a live session to borrow a provider/model route from.',
			'* **Dry run by default.** The first call reports the plan and writes nothing; call again with `dryRun:false` to actually import.',
			'* Scope with `since` / `until` (yyyy-mm-dd) and `limit`. Large histories are better done in slices — each summarized session costs model calls.',
			'* Prefer `summarize:false` first: it gets the raw text in immediately, and a later `summarize:true` pass upgrades the summaries without duplicating anything.',
		].join('\n'),
		parameters: {
			type: 'object',
			properties: {
				since: { type: 'string', description: 'Only sessions whose activity reaches this date (yyyy-mm-dd) or later.' },
				until: { type: 'string', description: 'Only sessions whose activity starts at or before this date (yyyy-mm-dd).' },
				limit: { type: 'number', description: 'Import at most this many sessions (oldest first).' },
				dryRun: { type: 'boolean', description: 'Defaults to true. Set false to actually write.' },
				summarize: { type: 'boolean', description: 'Defaults to false. True runs the model summarization (costs calls) instead of snapshot-only.' },
				sessionsDir: { type: 'string', description: 'Override the session log directory (defaults to <dshHome>/sessions).' }
			},
			required: [],
			additionalProperties: false
		},
		output: OUTPUT,
		async execute(args, exec) {
			const request = { ...(args ?? {}), currentSession: exec?.agent?.session };
			const report = await service.importHistory(request);
			return { text: `memory_import\n\n${JSON.stringify(report, null, 2)}` };
		}
	});

	ctx.tools.register({
		name: 'memory_backup',
		description: [
			// Built from the configured root rather than a literal: this text is a
			// description the model reads, and on a POSIX root a backslash-shaped
			// path names a location that does not exist.
			`Refresh the disaster-recovery bundle at \`${joinPath(config.root, '_bootstrap')}\`: real copies of the plugins, persona, skills, AGENTS rules, helper scripts and install state.`,
			'* Call it after changing a plugin, the persona, a skill, or the AGENTS rules — the bundle does not update itself.',
			'* Only the tree survives a workspace switch, so this is the one copy that will still exist in a different folder. That is why the bundle lives there and why this runs from the plugin rather than a script in the workspace.',
			`* It also refreshes \`${joinPath(config.root, '_bootstrap', 'MANIFEST.md')}\` and \`README.md\`, which a restorer reads to learn what to put back and where.`,
			'* Excludes node_modules, .git, test artifacts and `_backup-*`. Every copied file is verified by SHA-256 after writing; a verification failure is reported rather than swallowed.',
			'* Text assets are then scrubbed of sensitive literals (public IPv4, 32-hex openid/peerId, `sk-` keys), because this bundle lives inside the tree and the tree must not hold them. Those copies therefore differ from the source only at the masked spans; a restorer must re-enter values like the bridge `host`. Binary assets are never touched.',
			'* Idempotent: run it as often as you like. Skipped sources are reported, not treated as errors.',
		].join('\n'),
		parameters: {
			type: 'object',
			properties: {
				workspace: {
					type: 'string',
					description: 'Workspace to back the plugins and scripts up from. Defaults to this session\'s working directory.'
				}
			},
			required: [],
			additionalProperties: false
		},
		output: OUTPUT,
		async execute(args, exec) {
			const workspace = typeof args.workspace === 'string' && args.workspace.length > 0
				? args.workspace
				: exec?.agent?.session?.header?.cwd;
			const assets = planAssets({ dshHome: config.dshHome, workspace });
			let report;
			try {
				report = writeBackup({ root: config.root, assets });
			} catch (error) {
				return { text: `memory_backup failed: ${String(error?.message ?? error)}` };
			}
			const skipped = report.entries.filter((entry) => entry.status === 'skipped');
			const lines = [
				`${report.written}`,
				`生成于 ${report.stamp}｜${report.files} 个文件 / ${(report.bytes / 1024).toFixed(1)} KB`,
				...(report.scrubbed > 0
					? [`已脱敏 ${report.scrubbed} 处敏感值（公网 IP / 32 位 openid·peerId / sk- 密钥）——副本与源在这些位置不同，恢复时需重填`]
					: []),
				`workspace: ${workspace ?? '（未提供，已跳过依赖工作区的条目）'}`,
				'dshHome: ' + config.dshHome,
				''
			];
			for (const entry of report.entries) {
				lines.push(entry.status === 'copied'
					? `  ✓ ${entry.to.padEnd(34)} ${String(entry.files).padStart(4)} files  ${(entry.bytes / 1024).toFixed(1).padStart(8)} KB  ${entry.note}`
					: `  – ${entry.to.padEnd(34)} ${'skipped'.padStart(4)}                        ${entry.note}（${entry.reason}）`);
			}
			if (skipped.length > 0) {
				lines.push('', `${skipped.length} 个条目因源不存在被跳过——如果那不是预期的，检查 workspace 与 dshHome 是否正确。`);
			}
			return { text: lines.join('\n') };
		}
	});

	ctx.tools.register({
		name: 'memory_status',
		description: [
			'Diagnostics for the memory tree: configuration, tree shape, this session\'s trigger state, and plugin counters.',
			'* Set probe=true to also make one real model call, verifying the route and the streaming protocol end to end.',
			'* Use it when memory looks wrong, or to confirm that automatic snapshots are armed.',
		].join('\n'),
		parameters: {
			type: 'object',
			properties: {
				probe: { type: 'boolean', description: 'Also run one live model round-trip to verify the call path.' }
			},
			required: [],
			additionalProperties: false
		},
		output: OUTPUT,
		async execute(args, exec) {
			const session = exec?.agent?.session;
			const overview = await treeOverview(config.root).catch((error) => ({ error: String(error) }));
			const state = session === undefined ? undefined : service.stateFor(session.id);
			const pressure = session === undefined ? undefined : service.measure(session);
			// Resolve the threshold from the CURRENT measurement so the answer is
			// informative even before the first step has been observed.
			const resolved = thresholdFor(config, pressure);
			const report = {
				version: VERSION,
				config,
				now: localParts(new Date(Date.now()), config.timezone).stamp,
				root: config.root,
				// Which services resolved. A missing tokenMeter would silently
				// disable the pressure trigger, so report it rather than let the
				// absence show up only as a missing measurement.
				services: {
					llm: service.llm() !== undefined,
					tokenMeter: service.tokenMeter() !== undefined
				},
				route: session === undefined ? undefined : service.routeOf(session),
				pressure,
				// The effective pressure trigger: `source: 'ratio'` means it scaled
				// against the routed model's own window, `'absolute'` means the
				// window is not known yet or the ratio fell below the floor.
				trigger: {
					threshold: resolved.threshold,
					source: resolved.source,
					contextWindow: resolved.contextWindow,
					ratio: config.snapshotTriggerRatio,
					floor: config.snapshotTriggerTokens,
					compactionBypassesCooldown: true
				},
				session: session === undefined
					? undefined
					: {
						id: session.id,
						recorded: service.includeSession(session),
						contextTokens: state?.contextTokens,
						lastSnapshotAt: state?.lastSnapshotAt === 0 ? 'never' : new Date(state?.lastSnapshotAt ?? 0).toISOString(),
						lastTrigger: state?.lastTrigger,
						inFlight: state?.inFlight,
						// Pressure is an event, not a state: the anchor records the
						// occupancy of the last snapshot, and the growth guard compares
						// against it. `pressureSkipped` makes the guard's work visible —
						// a guard nobody can see is a guard nobody can trust.
						pressureAnchorTokens: state?.pressureAnchorTokens,
						pressureSkipped: state?.pressureSkipped,
						// The stage of the pipeline that is running right now, so a
						// mid-flight reading is self-explanatory. Reported only while
						// a run is live; a settled run leaves no stale stage behind.
						phase: state?.inFlight === true ? state.phase : undefined,
						turnsLogged: state?.turnsLogged,
						// The compaction trigger compares this number across steps;
						// when the surface is absent the trigger can never fire, so
						// report the reading rather than let it fail silently.
						surfaceGeneration: session.surface?.replaceGeneration,
						delegationDepth: session.header?.delegationDepth
					},
				// A counter only advances when its stage *finishes*, so a run read
				// mid-flight shows zeros that look exactly like a dead feature.
				// Flag it instead of letting a busy snapshot look broken.
				stats: state?.inFlight === true
					? { ...service.stats, midFlight: `snapshot in progress (phase: ${state.phase ?? 'starting'}); these counters are not final` }
					: service.stats,
				lastError: service.lastError,
				tree: overview
			};
			if (args?.probe === true && session !== undefined) {
				report.probe = await service.probe({ session, signal: exec?.signal });
			}
			return { text: JSON.stringify(report, null, 2) };
		}
	});

	// ── prompt section ───────────────────────────────────────────────────

	// `order` must come from the harness's own placement table: an unknown key
	// yields undefined and `section()` rejects a non-finite order. Sitting one
	// step before the tool note keeps the two adjacent.
	try {
		const sectionOrder = (ctx.systemPrompt.getSectionOrder?.('TOOL_CORDIS') ?? 2500) - 1;
		ctx.systemPrompt.section({
			name: 'tool:memory-tree',
			order: sectionOrder,
			text: systemPromptNote(config)
		});
	} catch (error) {
		service.note(error, 'system prompt section');
	}

	// ── lifetime ─────────────────────────────────────────────────────────

	const shutdown = async () => {
		await service.drain();
	};
	if (typeof ctx.effect === 'function') ctx.effect(() => shutdown, 'memory-tree: drain background work');
	else ctx.on('dispose', shutdown);

	logger?.info?.(`memory-tree ${VERSION} ready — root=${config.root}, turnLog=${config.turnLog}, trigger=${config.snapshotTriggerTokens} tokens`);
}

/** Exported for tests. */
export const internals = { resolveConfig, DEFAULT_CONFIG, systemPromptNote };
