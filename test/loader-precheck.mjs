/**
 * Pre-flight check: will the DSH loader accept dsh-memory-tree as installed in
 * the desktop profile?
 *
 * Verifies the things that can fail before the host ever boots:
 *   1. the bundle patch parses and carries an insert row with the right name,
 *   2. the plugin module resolves through the profile's symlink and exports the
 *      Cordis plugin contract (name / inject / apply),
 *   3. every module the entry point imports resolves from the plugin's REAL
 *      path — the trap a `link:` install sets, because a naive resolution walks
 *      the profile's node_modules instead of the linked package.
 *   4. the configured tree root is reachable and writable.
 */
import { readFileSync, readdirSync, accessSync, constants } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, join as joinPath } from 'node:path'

// Resolved from THIS file, so the check works wherever the package is unpacked:
// a hard-coded absolute path would only ever pass on the machine it was written on.
const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE = dirname(HERE)
// The profile is where the plugin is INSTALLED. Override with DSH_PROFILE_DIR when
// checking a different profile; the default is the desktop profile under ~/.dsh.
const PROFILE = process.env.DSH_PROFILE_DIR
  || joinPath(process.env.USERPROFILE || process.env.HOME || '.', '.dsh', 'profiles', 'desktop')
const require_ = createRequire(`${PROFILE}/index.js`)
const YAML = require_('yaml')

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

// 1. bundle patch
const patchPath = `${PACKAGE}/cordis.patch.yml`
const patch = YAML.parse(readFileSync(patchPath, 'utf8'))
const insert = Array.isArray(patch) ? patch.find((entry) => Array.isArray(entry.insert))?.insert : undefined
check('bundle patch parses to an array', Array.isArray(patch))
check('patch has an insert list', Array.isArray(insert))
const row = insert?.find((entry) => entry.id === 'memory-tree')
check('patch inserts the memory-tree row', row !== undefined)
check('row name matches the package', row?.name === 'dsh-memory-tree', String(row?.name))
// `root` may legitimately be UNSET: lib/paths.js then falls back to the platform
// default (<homedir>/DSHMemory). A hard-coded root in a shipped patch would only
// ever suit the machine it was written on, so unset is the PREFERRED shape here.
const rowRoot = row?.config?.root
check('row root is a string or unset', rowRoot === undefined || typeof rowRoot === 'string', String(rowRoot))

// 2. module contract, loaded exactly the way the loader will resolve it
const entry = `${PROFILE}/node_modules/dsh-memory-tree/lib/index.js`
let module_
try {
  module_ = await import(pathToFileURL(entry).href)
  check('module resolves through the profile symlink', true)
} catch (error) {
  check('module resolves through the profile symlink', false, String(error))
}
check('module exports name', module_?.name === 'dsh-memory-tree', String(module_?.name))
check('module exports inject', Array.isArray(module_?.inject) && module_.inject.includes('tools'), JSON.stringify(module_?.inject))
check('module exports apply', typeof module_?.apply === 'function')

// 3. every module the entry point imports, resolved from the REAL path
const realLibDir = `${PACKAGE}/lib/`
const source = readFileSync(`${realLibDir}index.js`, 'utf8')
const relativeImports = [...source.matchAll(/from '(\.\/[^']+)'/g)].map((match) => match[1])
check('entry point imports its siblings', relativeImports.length > 0, relativeImports.join(', '))
// Load every sibling, not just the ones the entry point names directly: a
// syntax error in a transitively imported module would otherwise only surface
// when the host boots.
const allModules = readdirSync(realLibDir).filter((name) => name.endsWith('.js'))
for (const name of allModules) {
  try {
    await import(pathToFileURL(`${realLibDir}${name}`).href)
    check(`resolves lib/${name}`, true)
  } catch (error) {
    check(`resolves lib/${name}`, false, String(error))
  }
}
let packageJson
try {
  packageJson = JSON.parse(readFileSync(`${PACKAGE}/package.json`, 'utf8'))
  check('package.json parses', true)
} catch (error) {
  check('package.json parses', false, String(error))
}
// Runtime dependencies must be OPTIONAL: a linked package still has to LOAD when a
// dependency was never installed. So any declared dependency may only be reached
// through a DYNAMIC import (it then degrades at call time instead of failing the boot).
// The embedding runtime @huggingface/transformers is exactly that: when it is missing,
// the router falls back to the local HTTP server. Recall never goes silent, and it never
// takes the whole plugin down with it (2026-10-01 — this check used to demand zero deps).

const runtimeDeps = Object.keys(packageJson?.dependencies ?? {})
const eager = allModules.filter((name) => {
  let text = ''
  try { text = readFileSync(`${realLibDir}${name}`, 'utf8') } catch { return false }
  return runtimeDeps.some((dep) => {
    const escaped = dep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        // `import(` is a DYNAMIC import (fine); `import ` + a quoted dep is eager (not fine).
        return new RegExp(`(^|[^\\w.$])import\\s+(?!\\()[^\\n]*['\"]${escaped}['\"]`).test(text)
  })
})
check('runtime dependencies are only reached via dynamic import', eager.length === 0, eager.join(', ') || `none eagerly imported (${runtimeDeps.length} optional)`)
const notInstalled = runtimeDeps.filter((dep) => {
	try { readFileSync(`${PACKAGE}/node_modules/${dep}/package.json`, 'utf8'); return false } catch { return true }
})
// A fresh checkout has no node_modules yet, and that is not a defect of the package.
// Say which it is, so a green run never hides a genuinely broken install.
if (notInstalled.length === 0) {
	check('declared dependencies are installed', true, 'all present')
} else if (process.env.DSH_ALLOW_MISSING_DEPS === '1') {
	check('declared dependencies are installed', true, `skipped (DSH_ALLOW_MISSING_DEPS=1): ${notInstalled.join(', ')}`)
} else {
	check('declared dependencies are installed', false, `${notInstalled.join(', ')} — run the install, or set DSH_ALLOW_MISSING_DEPS=1 to check a fresh checkout`)
}
check('package declares the bundle patch', packageJson?.dsh?.bundle?.patch === './cordis.patch.yml', String(packageJson?.dsh?.bundle?.patch))

// 4. tree root reachability (the plugin creates the rest lazily)
const root = row?.config?.root
if (typeof root === 'string') {
  try {
    accessSync(root, constants.F_OK | constants.W_OK)
    check('tree root exists and is writable', true, root)
  } catch (error) {
    check('tree root exists and is writable', false, `${root} — ${String(error)}`)
  }
}

const failed = results.filter((item) => !item.ok)
console.log(`\n${results.length - failed.length}/${results.length} pre-flight checks passed`)
process.exit(failed.length > 0 ? 1 : 0)
