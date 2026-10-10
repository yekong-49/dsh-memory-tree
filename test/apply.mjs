/**
 * Plugin-contract tests: call `apply()` itself, against a fake context.
 *
 * This is the pre-restart safety net. A throw anywhere inside `apply` would
 * fail the host's boot, and a mistake in the `agent/pre-step` waterfall return
 * would break the agent loop — neither is reachable from the other suites, so
 * both are exercised here exactly as the loader would.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { eq, excludes, includes, ok, report, test } from './harness.mjs';
import { apply, inject, internals, name, VERSION } from '../lib/index.js';
import { localParts, nodePaths } from '../lib/paths.js';
import { regionText } from '../lib/sentinel.js';
import { TURNLOG_REGION } from '../lib/templates.js';

console.log('# plugin contract (apply)');

/**
 * Today's LOCAL date, which is the day the plugin writes to.
 *
 * Deliberately not `toISOString().slice(0,10)`: that is the UTC date, and near
 * midnight in +08:00 the two differ — which is the whole reason the plugin
 * computes local calendar fields.
 * @returns {string} `yyyy-mm-dd`.
 */
function localToday() {
	return localParts(new Date(), 'Asia/Shanghai').dateText;
}

/**
 * Build a context that records everything `apply` registers.
 * @param {{projectedTokens?: number}} [options] - service behaviour.
 * @returns {any} the fake context plus its records.
 */
function fakeContext(options = {}) {
	const records = {
		listeners: [],
		tools: [],
		sections: [],
		effects: [],
		logs: [],
		disposed: []
	};
	const ctx = {
		records,
		on(event, handler, options) {
			records.listeners.push({ event, handler, options });
			return () => records.disposed.push(event);
		},
		tools: {
			register(definition) {
				records.tools.push(definition);
				return () => {};
			}
		},
		systemPrompt: {
			getSectionOrder(key) {
				return key === 'TOOL_CORDIS' ? 2500 : undefined;
			},
			section(definition) {
				records.sections.push(definition);
			}
		},
		effect(factory, label) {
			records.effects.push({ label, disposer: factory() });
			return () => {};
		},
		logger: {
			info: (message) => records.logs.push(String(message)),
			warn: (message) => records.logs.push(String(message))
		},
		get(service) {
			if (service === 'llm') {
				return {
					stream(options) {
						// Two contracts, two answers: the slice call returns the slice's
						// own one-liner plus a DELTA list of day entries; the roll-up
						// call returns the day/month/year/long-term lines.
						const isUpper = typeof options.system === 'string' && options.system.includes('## 长期');
						const body = isUpper
							? '## 当日\n测试用摘要\n\n## 月\n九月：测试月\n\n## 年\n2026：测试年\n\n## 长期\n测试长期走向\n'
							: '## 一句话\n测试用摘要\n\n## 事件\n- 测试用摘要\n';
						return (async function* generate() {
							yield { type: 'block-start', index: 0, blockType: 'text' };
							yield { type: 'text-delta', index: 0, text: body };
							yield { type: 'end-of-stream-marker' };
							yield { type: 'finish', reason: { kind: 'stop' } };
						})();
					}
				};
			}
			if (service === 'tokenMeter') {
				// The real shape: `totalTokens`, not `projectedTokens`.
				const totalTokens = options.projectedTokens ?? 1000;
				return {
					measure: () => ({
						logRevision: 1,
						baseline: { kind: 'usage', tokens: totalTokens },
						surfaceDeltaTokens: 0,
						totalTokens,
						surfaceTokens: 0,
						nodes: []
					})
				};
			}
			return undefined;
		}
	};
	return ctx;
}

/**
 * Build a session whose events carry one completed turn.
 * @returns {any} the session.
 */
function fakeSession() {
	const events = [
		{ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
		{ type: 'user/message', seq: 1, time: 1, data: { role: 'user', content: '需求', source: { kind: 'user' } } },
		{ type: 'tool/call', seq: 2, time: 1, data: { turn: 1, step: 1, name: 'write', arguments: '{"file_path":"C:\\\\a\\\\applied.js"}' } },
		{ type: 'assistant/message', seq: 3, time: 1, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '结论：apply 跑通了' }] }, usage: { inputTokens: 10, outputTokens: 2 } } },
		{ type: 'turn/end', seq: 4, time: 1, data: { turn: 1, reason: { kind: 'completed' } } }
	];
	return {
		id: 'session-deadbeef-0000-0000-0000-000000000000',
		seq: events.length,
		header: { cwd: 'C:\\plugin', delegationDepth: 0 },
		surface: { replaceGeneration: 0 },
		snapshotEvents: () => events,
		requestHeader: () => ({ config: { provider: 'deepseek', model: 'deepseek-v4-flash' } })
	};
}

await test('the module exports the Cordis plugin contract', () => {
	eq(name, 'dsh-memory-tree');
	ok(Array.isArray(inject) && inject.includes('tools') && inject.includes('systemPrompt'), `inject=${JSON.stringify(inject)}`);
	eq(typeof apply, 'function');
	eq(typeof internals.systemPromptNote, 'function');
	ok(/^\d+\.\d+\.\d+$/.test(VERSION), VERSION);
});

await test('apply() registers its hooks, tools, and prompt section without throwing', async () => {
	const root = await mkdtemp(join(tmpdir(), 'memtree-apply-'));
	try {
		const ctx = fakeContext();
		apply(ctx, { root, router: false });
		eq(ctx.records.listeners.length, 3, 'three hooks (the third pushes the UI-switch injection row)');
		eq(ctx.records.listeners.map((entry) => entry.event).sort().join(','), 'agent/pre-step,agent/turn-stopping,webserver/index-inject');
		// `prepend: true` (the same registration `dsh-time-context` uses) makes the
		// reminder listener wrap the entire chain, so `next()` resolves to the FINAL
		// decision and an appended reminder cannot be dropped by a later listener
		// that rebuilds `messages`.
		eq(
			ctx.records.listeners.find((entry) => entry.event === 'agent/pre-step').options?.prepend,
			true,
			'the pre-step listener wraps the chain so it observes the final decision'
		);
		eq(ctx.records.tools.length, 9, 'nine tools (memory_import joined 2026-10-10 to replay historical session logs)');
		eq(ctx.records.tools.map((tool) => tool.name).sort().join(','), 'memory_auto,memory_backup,memory_import,memory_read,memory_route,memory_route_feedback,memory_search,memory_snapshot,memory_status');
		eq(ctx.records.sections.length, 1, 'one prompt section');
		eq(ctx.records.sections[0].name, 'tool:memory-tree');
		eq(Number.isFinite(ctx.records.sections[0].order), true, 'the section order is finite');
		includes(ctx.records.sections[0].text, root, 'the note names the configured root');
		eq(ctx.records.effects.length, 1, 'one lifetime effect is registered');
		ok(ctx.records.logs.some((line) => line.includes('memory-tree') && line.includes('ready')), 'it announces readiness');
		// Every tool declares the shared output contract the harness requires.
		for (const tool of ctx.records.tools) {
			ok(typeof tool.description === 'string' && tool.description.length > 40, `${tool.name} has a real description`);
			eq(tool.parameters.type, 'object', `${tool.name} takes an object`);
			eq(tool.parameters.additionalProperties, false, `${tool.name} is closed`);
			eq(typeof tool.output.render, 'function', `${tool.name} renders`);
			eq(tool.output.schema.required.includes('text'), true, `${tool.name} returns text`);
			eq(typeof tool.execute, 'function', `${tool.name} executes`);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

await test('the pre-step listener returns the upstream decision unchanged', async () => {
	const root = await mkdtemp(join(tmpdir(), 'memtree-apply-'));
	try {
		const ctx = fakeContext();
		apply(ctx, { root, router: false });
		const preStep = ctx.records.listeners.find((entry) => entry.event === 'agent/pre-step').handler;
		const decision = { kind: 'enter', messages: ['m1'] };
		let called = 0;
		const returned = await preStep({ agent: { session: fakeSession() }, messages: [], turn: 1, step: 1 }, async () => {
			called += 1;
			return decision;
		});
		eq(called, 1, 'the listener delegates to next()');
		eq(returned, decision, 'and returns exactly what next() produced');
		// A broken session must not throw out of the hook either.
		const broken = await preStep({ agent: undefined }, async () => decision);
		eq(broken, decision, 'a missing agent is survivable');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

await test('a cross-session phrase appends exactly one reminder message', async () => {
	const root = await mkdtemp(join(tmpdir(), 'memtree-apply-'));
	try {
		const ctx = fakeContext();
		apply(ctx, { root, router: false });
		const preStep = ctx.records.listeners.find((entry) => entry.event === 'agent/pre-step').handler;
		const human = (text) => ({ id: 'm1', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } });

		const messages = [human('上次那个 measure 的 bug 是怎么修的？')];
		const decision = { kind: 'enter', messages };
		const returned = await preStep({ agent: { session: fakeSession() }, messages, turn: 4, step: 1 }, async () => decision);

		ok(returned !== decision, 'a reminder produces a NEW decision object');
		eq(returned.messages.length, 2, 'exactly one message was appended');
		eq(decision.messages.length, 1, 'the upstream decision was not mutated');
		const injected = returned.messages[1];
		eq(injected.role, 'user', 'the reminder rides a user-role message');
		eq(injected.source.kind, 'plugin:dsh-memory-tree', 'producer-owned kind, so it is never mistaken for human input');
		ok(injected.source.kind !== 'plugin', 'not the retired v3 wrapper that fails format-v4 admission');
		includes(injected.content[0].text, 'memory_search', 'it names the cheap read path');
		includes(injected.content[0].text, '上次', 'it names the phrase that fired');

		// An ordinary turn is left completely alone — the same object comes back.
		const plain = [human('把 service.js 的缩进改一下')];
		const plainDecision = { kind: 'enter', messages: plain };
		eq(
			await preStep({ agent: { session: fakeSession() }, messages: plain, turn: 5, step: 1 }, async () => plainDecision),
			plainDecision,
			'no signal means the upstream decision is returned by reference'
		);

		// A rejected step is passed through untouched, reminder or not.
		const rejected = { kind: 'reject' };
		eq(
			await preStep({ agent: { session: fakeSession() }, messages, turn: 6, step: 1 }, async () => rejected),
			rejected,
			'a reject decision is never touched'
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

await test('the turn-stopping listener logs a row and never throws', async () => {
	const root = await mkdtemp(join(tmpdir(), 'memtree-apply-'));
	try {
		const ctx = fakeContext();
		apply(ctx, { root, router: false });
		const turnStopping = ctx.records.listeners.find((entry) => entry.event === 'agent/turn-stopping').handler;
		await turnStopping({ agent: { session: fakeSession() }, turn: 1 });
		const dayText = await readFile(nodePaths(root, localToday()).dayFile, 'utf8').catch(() => undefined);
		ok(dayText !== undefined, 'the day file was created');
		includes(regionText(dayText, TURNLOG_REGION), '| T1·deadbeef |', 'the row names the turn and session');
		includes(dayText, '结论：apply 跑通了', 'the row carries the turn headline');
		// Hostile payloads must be absorbed.
		await turnStopping({ agent: { session: {} }, turn: 1 });
		await turnStopping({});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

await test('memory_read and memory_status execute end to end through the tools', async () => {
	const root = await mkdtemp(join(tmpdir(), 'memtree-apply-'));
	try {
		const ctx = fakeContext();
		apply(ctx, { root, router: false });
		const session = fakeSession();
		const exec = { agent: { session }, signal: undefined };
		const byName = new Map(ctx.records.tools.map((tool) => [tool.name, tool]));

		// A missing node is a clean message, not a throw.
		const missing = await byName.get('memory_read').execute({ level: 'index' }, exec);
		includes(missing.text, 'memory_read failed');

		// Snapshot through the tool, then read every level back.
		const snapshot = await byName.get('memory_snapshot').execute({ reason: 'apply test' }, exec);
		includes(snapshot.text, '"status": "written"');
		includes(snapshot.text, '测试用摘要');

		const today = localToday();
		const dateText = today;
		const day = await byName.get('memory_read').execute({ level: 'day', date: dateText }, exec);
		includes(day.text, '快照索引');
		includes(day.text, 'next: read one snapshot', 'the tool tells the agent where to go next');

		const search = await byName.get('memory_search').execute({ query: '测试用摘要' }, exec);
		includes(search.text, 'match(es)');

		const status = await byName.get('memory_status').execute({}, exec);
		// The status payload is JSON, so the root appears with escaped backslashes.
		includes(status.text, JSON.stringify(root).slice(1, -1), 'status reports the configured root');
		includes(status.text, '"snapshots": 1');
		excludes(status.text, '"probe"', 'the probe section is absent unless requested');

		const probe = await byName.get('memory_status').execute({ probe: true }, exec);
		includes(probe.text, '"observedChunkTypes"');
		includes(probe.text, 'end-of-stream-marker', 'the probe reports the real chunk types it saw');

		// A hostile snapshot file name is refused by the tool layer too.
		const evil = await byName.get('memory_read').execute({ level: 'snapshot', date: dateText, file: '../../index.md' }, exec);
		includes(evil.text, 'not a snapshot file name');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

await test('the lifetime effect drains background work', async () => {
	const root = await mkdtemp(join(tmpdir(), 'memtree-apply-'));
	try {
		const ctx = fakeContext({ projectedTokens: 700_000 });
		apply(ctx, { root, router: false });
		const preStep = ctx.records.listeners.find((entry) => entry.event === 'agent/pre-step').handler;
		// Schedule a snapshot, then dispose immediately: the disposer must wait.
		await preStep({ agent: { session: fakeSession() }, messages: [], turn: 1, step: 1 }, async () => ({ kind: 'enter', messages: [] }));
		await ctx.records.effects[0].disposer();
		// The detached snapshot completed before drain() resolved.
		const text = await readFile(nodePaths(root, localToday()).dayFile, 'utf8').catch(() => '');
		includes(text, 'BEGIN MACHINE ROLLUP', 'the day file exists after the drain');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

report();
