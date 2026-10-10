/**
 * router.mjs — the recall router's own suite: pure, offline, no DSH and no network.
 *
 * The router is the one piece of P0 that runs on EVERY step, so its failure modes
 * matter more than its happy path. Three of them are asserted here by construction:
 *   · a transport that throws must NOT propagate (recall may never break a turn);
 *   · stored vectors are the model's raw, un-normalised output — a regression test
 *     fixes that, because forgetting it silently scales every score;
 *   · the date decay must actually reorder equal-cosine candidates.
 */
import { eq, ok, report, test } from './harness.mjs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRouter, httpTransport } from '../lib/router.js';

const NOW = Date.parse('2026-09-30T12:00:00+08:00');
const config = {
	routerBaseUrl: 'http://127.0.0.1:1234',
	routerModel: 'test-model',
	routerTopK: 3,
	routerMinCos: 0.6,
	routerMaxDays: 7,
	routerLambda: 0.1,
	routerMaxChars: 500,
	routerTimeoutMs: 1000
};

/** A transport that answers with a scripted vector, or throws. */
const fakeTransport = (vector) => async () => ({ data: [{ embedding: vector }] });
const failingTransport = (message) => async () => { throw new Error(message); };

/** 3-dim index: same direction (cosine 1) on two days, plus an unrelated one. */
const index = {
	dates: ['2026-09-29', '2026-09-20', '2026-08-01'],
	vectors: [[3, 4, 0], [3, 4, 0], [0, 0, 10]],   // deliberately NOT unit length
	texts: ['recent same-topic turn', 'older same-topic turn', 'unrelated']
};

await test('route(): a matching query is related, and cosine is scale-invariant', async () => {
	const router = createRouter(config, { transport: fakeTransport([6, 8, 0]), index, now: () => NOW });
	const result = await router.route('something about the recent topic');
	ok(result !== undefined, 'a result came back');
	eq(result.verdict, 'related', 'cosine 1.0 clears the threshold');
	eq(result.candidates[0].date, '2026-09-29', 'the newest equal-cosine day wins the decay tie-break');
	// Raw vectors are 5 long and 3 long; if the loader forgot to normalise, the
	// cosine would come out as 30/… instead of 1 and this would not be 1 exactly.
	eq(result.candidates[0].cosine, 1, 'cosine is 1 despite the raw magnitudes');
});

await test('route(): below the threshold is a clean "none"', async () => {
	// 0.28-ish cosine against everything: no day clears 0.6.
	const router = createRouter(config, { transport: fakeTransport([1, 0, 28]), index, now: () => NOW });
	const result = await router.route('a message about nothing in the corpus');
	eq(result.verdict, 'none', 'nothing cleared the cosine threshold');
	eq(result.candidates.length, 3, 'the top-K is still reported as candidates');
	includes_(result.reason, '0.6', 'the reason names the threshold it failed');
});

await test('route(): date decay reorders two candidates with the same cosine', async () => {
	const router = createRouter({ ...config, routerMinCos: 0.1 }, { transport: fakeTransport([3, 4, 0]), index, now: () => NOW });
	const result = await router.route('same topic, two days');
	const dates = result.candidates.map((entry) => entry.date);
	eq(dates[0], '2026-09-29', 'the nearer day is first');
	eq(dates[1], '2026-09-20', 'the farther day is second');
});

await test('route(): top-K caps how many days come back', async () => {
	const router = createRouter({ ...config, routerTopK: 1, routerMinCos: 0.1 }, { transport: fakeTransport([3, 4, 0]), index, now: () => NOW });
	const result = await router.route('one day only please');
	eq(result.candidates.length, 1, 'routerTopK=1 yields exactly one candidate');
});

await test('route(): a broken transport returns undefined instead of throwing', async () => {
	const router = createRouter(config, { transport: failingTransport('connection refused'), index, now: () => NOW });
	const result = await router.route('anything');
	eq(result, undefined, 'the failure is swallowed');
	includes_(router.lastError, 'connection refused', 'and it is recorded for memory_status');
});

await test('route(): a transport that answers with junk is also swallowed', async () => {
	const router = createRouter(config, { transport: async () => ({ data: [] }), index, now: () => NOW });
	eq(await router.route('anything'), undefined);
	includes_(router.lastError, 'no vector', 'the reason names what was missing');
});

await test('warmup(): reports readiness, and never throws', async () => {
	const good = createRouter(config, { transport: fakeTransport([1, 0, 0]), index, now: () => NOW });
	eq(await good.warmup(), true, 'a working transport warms up');
	eq(good.warm, true);
	const bad = createRouter(config, { transport: failingTransport('no server'), index, now: () => NOW });
	eq(await bad.warmup(), false, 'a broken one reports false rather than throwing');
	eq(bad.warm, false);
});

await test('route(): the DISK path reads the Float32 blob correctly', async () => {
	// Why this test exists: every other test injects its index, so the disk reader
	// went uncovered — and it read the .bin as utf8, which mangles every byte above
	// 0x7f and made the whole corpus score ~0.07 instead of ~0.8. Caught by a smoke
	// run against the real engine, not by this suite. Now it is covered.
	const dir = await mkdtemp(join(tmpdir(), 'memtree-router-'));
	try {
		const dim = 3;
		const raw = [[6, 8, 0], [0, 0, 10]];
		const buffer = Buffer.alloc(raw.length * dim * 4);
		raw.forEach((vector, i) => vector.forEach((value, j) => buffer.writeFloatLE(value, (i * dim + j) * 4)));
		await writeFile(join(dir, 'idx.bin'), buffer);
		await writeFile(join(dir, 'idx_meta.json'), JSON.stringify({ model: 'test', dim, count: raw.length, dates: ['2026-09-29', '2026-08-01'] }), 'utf8');
		const router = createRouter({ ...config, routerIndex: join(dir, 'idx').replace(/\\/g, '/') }, { transport: fakeTransport([6, 8, 0]), now: () => NOW });
		const result = await router.route('disk path');
		ok(result !== undefined, 'the disk index loaded: ' + String(router.lastError ?? ''));
		eq(result.candidates[0].date, '2026-09-29');
		eq(result.candidates[0].cosine, 1, 'a raw 3-float blob round-trips through the reader');
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

await test('httpTransport is exported (the default path is wired, not stubbed)', () => {
	eq(typeof httpTransport, 'function');
});

await test('route(): a candidate day carries the corpus snippet count it matched', async () => {
	const router = createRouter({ ...config, routerMinCos: 0.1 }, { transport: fakeTransport([3, 4, 0]), index, now: () => NOW });
	const result = await router.route('snippets');
	eq(result.candidates[0].hits.length, 1, 'one hit on the newest day');
	includes_(result.candidates[0].hits[0].text, 'recent same-topic turn', 'the snippet text rides along when a corpus is configured');
});

/** Tiny local helper so the assertion reads the same way the other suites read. */
function includes_(text, needle, label) {
	ok(String(text ?? '').includes(needle), (label ?? 'includes') + ' — got: ' + String(text ?? '').slice(0, 120));
}

await report('router');
