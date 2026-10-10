/**
 * A minimal test harness: no dependencies, no framework.
 *
 * The rule this project learned the hard way is "no conclusion without a
 * run", so the checks below are written to FAIL LOUDLY on the specific bugs
 * that matter here — silent no-ops, lost hand-written text, duplicated
 * accounting, and a roll-up that is not idempotent.
 */

let passed = 0;
let failed = 0;
const failures = [];

/**
 * Register and run one test.
 * @param {string} name - the test name.
 * @param {() => any} body - the test body (sync or async).
 * @returns {Promise<void>} resolves when the test finishes.
 */
export async function test(name, body) {
	try {
		await body();
		passed += 1;
		console.log(`  ok   ${name}`);
	} catch (error) {
		failed += 1;
		failures.push({ name, error });
		console.log(`  FAIL ${name}\n       ${error?.message ?? error}`);
	}
}

/**
 * Assert a condition.
 * @param {unknown} condition - the condition.
 * @param {string} message - failure message.
 * @returns {void}
 */
export function ok(condition, message) {
	if (!condition) throw new Error(message ?? 'expected a truthy value');
}

/**
 * Assert strict equality.
 * @param {unknown} actual - the value.
 * @param {unknown} expected - the expected value.
 * @param {string} [message] - failure context.
 * @returns {void}
 */
export function eq(actual, expected, message) {
	if (!Object.is(actual, expected)) {
		throw new Error(`${message === undefined ? 'values differ' : message}\n       expected: ${JSON.stringify(expected)}\n       actual:   ${JSON.stringify(actual)}`);
	}
}

/**
 * Assert that a substring is present.
 * @param {string} haystack - the text.
 * @param {string} needle - the substring.
 * @param {string} [message] - failure context.
 * @returns {void}
 */
export function includes(haystack, needle, message) {
	if (!String(haystack).includes(needle)) {
		throw new Error(`${message ?? 'substring missing'}: ${JSON.stringify(needle)}\n       in: ${JSON.stringify(String(haystack).slice(0, 400))}`);
	}
}

/**
 * Assert that a substring is absent.
 * @param {string} haystack - the text.
 * @param {string} needle - the substring.
 * @param {string} [message] - failure context.
 * @returns {void}
 */
export function excludes(haystack, needle, message) {
	if (String(haystack).includes(needle)) {
		throw new Error(`${message ?? 'substring should be absent'}: ${JSON.stringify(needle)}`);
	}
}

/**
 * Assert that a call throws.
 * @param {() => any} body - the call.
 * @param {RegExp} [pattern] - expected message pattern.
 * @param {string} [message] - failure context.
 * @returns {Promise<void>} resolves when the throw was observed.
 */
export async function throws(body, pattern, message) {
	try {
		await body();
	} catch (error) {
		if (pattern !== undefined && !pattern.test(String(error?.message ?? error))) {
			throw new Error(`${message ?? 'wrong error'}: expected ${pattern}, got ${error?.message ?? error}`);
		}
		return;
	}
	throw new Error(`${message ?? 'expected a throw, but the call succeeded'}`);
}

/** Print the summary and set the process exit code. */
export function report() {
	console.log(`\n${passed} passed, ${failed} failed`);
	if (failed > 0) {
		for (const failure of failures) console.log(`\n--- ${failure.name}\n${failure.error?.stack ?? failure.error}`);
		process.exitCode = 1;
	}
}

/** @returns {number} the number of failures so far. */
export function failureCount() {
	return failed;
}
