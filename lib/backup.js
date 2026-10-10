/**
 * The asset backup: a restorable copy of everything that makes this setup what
 * it is, kept INSIDE the memory tree.
 *
 * WHY IT LIVES IN THE PLUGIN and not in a standalone script: the first version
 * of this was a standalone generator script, which works right up until the human
 * switches workspaces — at which point the script is gone along with everything
 * else it was supposed to protect. The tree is the one path that survives a
 * workspace switch, so the code that fills it has to live somewhere that
 * survives one too.
 *
 * WHAT IT COPIES, and why each entry is load-bearing:
 *
 *   plugins\*        every `dsh-*` plugin's source — discovered, not listed; without
 *                    it there is nothing to install (it said "the two plugins" long
 *                    after there were five, which is why the count is now derived)
 *   persona\         the preset, so the next session still knows who it is
 *   skills\          on-demand instructions, including how to read this tree
 *   rules\           the global baseline AND the workspace one
 *   install-state\   "what was installed" — profile registration and settings
 *   scripts\         the helper scripts, so the workflow survives too
 *
 * The source and destination are DIFFERENT KINDS of thing, which is why the
 * manifest records both: restoring source without restoring registration gives
 * you files that do nothing.
 *
 * Copies are verified by SHA-256 after writing. That catches a copy that failed
 * (full disk, permissions, a silent truncation) — it does NOT catch a source
 * that was already wrong, since the destination is overwritten from it.
 * @module dsh-memory-tree/backup
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';

import { isScrubbablePath, scrubVerified } from './redact.js';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Directory inside the tree that holds the bundle. Its name is never numeric, so the tree skips it. */
export const BACKUP_DIR = '_bootstrap';

/**
 * Paths that must never enter the bundle.
 *
 * `_restore-test` / `_tmp*` are here because of a real accident (2026-09-15):
 * the restore script was exercised into a temporary directory *inside* the helper tree,
 * and the next bundle swallowed that copy of the workspace whole —
 * the helper tree jumped from 432 files to 976 (5 MB). A backup that copies a
 * copy of itself is not a backup; the lesson is that **test scratch space must be
 * named something the generator skips**, not merely deleted afterwards (deleting
 * is a step someone will forget).
 */
const EXCLUDE = /[\\/](node_modules|\.git)([\\/]|$)|[\\/]shot-test[^\\/]*\.png$|[\\/]_backup-[^\\/]*$|[\\/](_restore-test|_tmp)[^\\/]*$/i;

/**
 * Where the DSH state directory is, unless configured otherwise.
 * @returns {string} the absolute path.
 */
export function defaultDshHome() {
	return join(homedir(), '.dsh');
}

/**
 * Build the list of assets to back up.
 *
 * Every entry carries a note, because the manifest is read by someone deciding
 * whether a restore is complete — a bare path list cannot answer that.
 * @param {{ dshHome: string, workspace?: string }} input - the two roots everything is derived from.
 * @returns {Array<{ from: string, to: string, kind: 'dir'|'file', note: string }>} the plan.
 */
export function planAssets({ dshHome, workspace }) {
	const plan = [];
	const dsh = (name) => join(dshHome, name);

	if (workspace !== undefined) {
		// Rules live at the workspace root under fixed names. Listed by NAME rather
		// than discovered, because a glob that matches nothing looks identical to a
		// workspace that has no rules — and a backup that silently covers less than
		// it claims is the one failure nobody notices until a restore.
		for (const name of ['AGENTS.md', 'PITFALLS.md']) {
			plan.push({
				from: join(workspace, name),
				to: `rules/${name}`,
				kind: 'file',
				note: '工作区规则 / 坑清单（不存在则跳过）'
			});
		}

		let entries = [];
		try {
			entries = readdirSync(workspace, { withFileTypes: true });
		} catch {
			entries = [];
		}
		entries = entries.sort((left, right) => left.name.localeCompare(right.name));

		for (const entry of entries) {
			// Discovered, never listed. A hand-kept list silently stops covering the
			// workspace the moment a new plugin or document appears, and a missing
			// asset is the one thing a restore cannot recover from.
			if (entry.isDirectory()) {
				// A `docs/` directory is copied FILE BY FILE, never as a directory
				// entry: copyAsset's dir path removes the target before copying, so a
				// directory copy would also delete anything else mapped into the same
				// folder — and whether it did would depend only on plan order.
				// This branch must come FIRST among the directory cases, because the
				// generic `continue` below would otherwise swallow it (that exact
				// ordering bug made docs/ silently unbacked-up until a test caught it).
				if (entry.name === 'docs') {
					let docsEntries = [];
					try {
						docsEntries = readdirSync(join(workspace, 'docs'), { withFileTypes: true });
					} catch {
						docsEntries = [];
					}
					for (const doc of docsEntries.sort((left, right) => left.name.localeCompare(right.name))) {
						if (!doc.isFile()) continue;
						plan.push({
							from: join(workspace, 'docs', doc.name),
							to: `docs/${doc.name}`,
							kind: 'file',
							note: 'docs/ 下的文档（自动发现）'
						});
					}
					continue;
				}
				// Convention: `dsh-*` are plugin sources, `_*` are helper/scratch
				// directories (scripts, probes, experiments). The underscore
				// convention is what keeps this generic: a deployment can name its
				// scratch space whatever it likes as long as the directory says it is
				// not part of the deliverable.
				if (entry.name.startsWith('dsh-')) {
					plan.push({
						from: join(workspace, entry.name),
						to: `plugins/${entry.name}`,
						kind: 'dir',
						note: '插件源码（按 `dsh-*` 目录自动发现）'
					});
					continue;
				}
				if (entry.name.startsWith('_')) {
					plan.push({
						from: join(workspace, entry.name),
						to: `scripts/${entry.name}`,
						kind: 'dir',
						note: '辅助目录（下划线约定：脚本 / 探测 / 实验）'
					});
					continue;
				}
				continue;
			}
			// Root-level Markdown are design documents (AGENTS.md / PITFALLS.md were
			// already mapped into rules/ above).
			if (entry.name.endsWith('.md') && entry.name !== 'AGENTS.md' && entry.name !== 'PITFALLS.md') {
				plan.push({
					from: join(workspace, entry.name),
					to: `docs/${entry.name}`,
					kind: 'file',
					note: '工作区根级文档'
				});
			}
		}
	}

	plan.push(
		{ from: dsh('skills'), to: 'skills', kind: 'dir', note: '技能（按需加载；含 memory-protocol）' },
		{ from: dsh('AGENTS.md'), to: 'rules/AGENTS.global.md', kind: 'file', note: '全局铁律（跨工作区生效）' },
		{ from: join(dshHome, '.agent-presets'), to: 'persona', kind: 'dir', note: 'agent 预设（人设正文就在里面）' },
		{ from: dsh('settings.yaml'), to: 'install-state/settings.yaml', kind: 'file', note: '全局设置（agent-presets.default 与默认模型）' },
		{ from: join(dshHome, 'profiles', 'desktop', 'package.json'), to: 'install-state/profile-package.json', kind: 'file', note: '插件注册：dependencies + dsh.profile.bundles' },
		{ from: join(dshHome, 'profiles', 'desktop', 'cordis.patch.yml'), to: 'install-state/profile-cordis.patch.yml', kind: 'file', note: 'profile 自己的 patch 层' },
		{ from: join(dshHome, 'profiles', 'desktop', 'cordis.yml'), to: 'install-state/profile-cordis.yml', kind: 'file', note: 'profile 组合根' }
	);

	return plan;
}

/** Two-digit pad. */
const pad = (n) => String(n).padStart(2, '0');

/**
 * Local timestamp in the shape the rest of the tree uses.
 * @param {Date} [when] - the moment.
 * @returns {string} `2026-09-13 06:48:18`.
 */
export function stampOf(when = new Date(Date.now())) {
	return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`
		+ ` ${pad(when.getHours())}:${pad(when.getMinutes())}:${pad(when.getSeconds())}`;
}

/**
 * SHA-256 every file under a directory, keyed by relative path.
 *
 * The same exclusion rule is applied here and in `cpSync`'s filter so the two
 * fingerprints are like for like; comparing a filtered source against an
 * unfiltered destination would report every excluded file as missing.
 * @param {string} dir - the directory.
 * @returns {Map<string, string>} relative path -> digest.
 */
function fingerprintDir(dir) {
	const map = new Map();
	const walk = (current, prefix) => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const path = join(current, entry.name);
			if (EXCLUDE.test(path)) continue;
			const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
			if (entry.isDirectory()) walk(path, rel);
			else map.set(rel, digestOf(path));
		}
	};
	walk(dir, '');
	return map;
}

/**
 * SHA-256 one file.
 * @param {string} path - the file.
 * @returns {string} the hex digest.
 */
function digestOf(path) {
	return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Count files and bytes under a directory, honouring the exclusion rule.
 * @param {string} dir - the directory.
 * @returns {{files: number, bytes: number}} the measurement.
 */
function measure(dir) {
	let files = 0;
	let bytes = 0;
	const walk = (current) => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const path = join(current, entry.name);
			if (EXCLUDE.test(path)) continue;
			if (entry.isDirectory()) walk(path);
			else {
				files += 1;
				bytes += statSync(path).size;
			}
		}
	};
	walk(dir);
	return { files, bytes };
}

/**
 * Scrub sensitive literals out of an already-copied asset.
 *
 * Runs strictly **after** the byte-for-byte verification, never instead of it:
 * the copy is still proven faithful, and the scrub is a separate, separately
 * proven step (`scrubVerified` checks the line count and the exact byte delta, so
 * a replacement that touched anything else fails loudly). Doing it the other way
 * around — scrubbing before the digest check, or scrubbing the source — would
 * either weaken the fidelity check or leave the tree exposed.
 *
 * Reasoning: this bundle lives *inside* `<MEMORY_ROOT>`, and the tree's rule is
 * that a sensitive value must never be written into it. The workspace keeps the
 * real values (scripts there need them to run at all), so the masking has to
 * happen here, on the way in.
 * @param {string} dir - a copied file or directory inside the bundle.
 * @returns {{files: number, hits: number}} how many files were masked, and how many literals.
 */
function scrubCopied(dir) {
	let files = 0;
	let hits = 0;
	const one = (path) => {
		if (!isScrubbablePath(path)) return;
		const text = readFileSync(path, 'utf8');
		const scrubbed = scrubVerified(text, path);
		if (scrubbed.counts.total === 0) return;
		writeFileSync(path, scrubbed.text, 'utf8');
		files += 1;
		hits += scrubbed.counts.total;
	};
	const walk = (current) => {
		const stats = statSync(current);
		if (stats.isFile()) return one(current);
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const path = join(current, entry.name);
			if (EXCLUDE.test(path)) continue;
			if (entry.isDirectory()) walk(path);
			else one(path);
		}
	};
	walk(dir);
	return { files, hits };
}

/**
 * Copy one asset into the bundle and verify it landed byte for byte.
 * @param {{ from: string, to: string, kind: 'dir'|'file' }} asset - the plan entry.
 * @param {string} root - the bundle root.
 * @returns {{ status: 'copied'|'skipped', files: number, bytes: number, scrubbed?: number, scrubFiles?: number, reason?: string }} the outcome.
 */
function copyAsset(asset, root) {
	if (!existsSync(asset.from)) return { status: 'skipped', files: 0, bytes: 0, reason: 'source is absent' };
	const target = join(root, ...asset.to.split('/'));
	mkdirSync(join(target, '..'), { recursive: true });
	if (asset.kind === 'file') {
		const expected = digestOf(asset.from);
		rmSync(target, { force: true });
		cpSync(asset.from, target);
		if (digestOf(target) !== expected) throw new Error(`copy verification failed for ${asset.to}`);
		const scrub = scrubCopied(target);
		return { status: 'copied', files: 1, bytes: statSync(target).size, scrubbed: scrub.hits, scrubFiles: scrub.files };
	}
	const expected = fingerprintDir(asset.from);
	rmSync(target, { recursive: true, force: true });
	mkdirSync(target, { recursive: true });
	cpSync(asset.from, target, { recursive: true, filter: (src) => !EXCLUDE.test(src) });
	const actual = fingerprintDir(target);
	const problems = [];
	for (const [rel, hash] of expected) {
		if (!actual.has(rel)) problems.push(`missing: ${rel}`);
		else if (actual.get(rel) !== hash) problems.push(`differs: ${rel}`);
	}
	if (problems.length > 0) throw new Error(`copy verification failed for ${asset.to}: ${problems.slice(0, 5).join('; ')}`);
	const scrub = scrubCopied(target);
	const { files, bytes } = measure(target);
	return { status: 'copied', files, bytes, scrubbed: scrub.hits, scrubFiles: scrub.files };
}

/**
 * Write the whole bundle, and the two documents a restorer needs.
 *
 * Rewrites `README.md` and `MANIFEST.md` every time: they describe the CURRENT
 * contents, so hand-maintaining them would guarantee they drift.
 * @param {{ root: string, assets: ReturnType<typeof planAssets>, stamp?: string, onAsset?: (entry: any) => void }} input - the request.
 * @returns {{ written: string, stamp: string, entries: any[], files: number, bytes: number }} the report.
 */
export function writeBackup({ root, assets, stamp = stampOf(), onAsset }) {
	const bundle = join(root, BACKUP_DIR);
	mkdirSync(bundle, { recursive: true });
	const entries = [];
	for (const asset of assets) {
		const outcome = copyAsset(asset, bundle);
		const entry = { ...asset, ...outcome };
		entries.push(entry);
		onAsset?.(entry);
	}
	const copied = entries.filter((entry) => entry.status === 'copied');
	const files = copied.reduce((sum, entry) => sum + entry.files, 0);
	const bytes = copied.reduce((sum, entry) => sum + entry.bytes, 0);
	const scrubbed = copied.reduce((sum, entry) => sum + (entry.scrubbed ?? 0), 0);
	const scrubbedAssets = entries.filter((entry) => (entry.scrubbed ?? 0) > 0);

	const rows = entries.map((entry) => {
		const state = entry.status === 'copied'
			? `${entry.files} | ${(entry.bytes / 1024).toFixed(1)}`
			: `— | —`;
		const masked = entry.scrubbed === undefined || entry.scrubbed === 0 ? '' : ` · 已脱敏 ${entry.scrubbed} 处`;
		return `| \`${entry.to}\` | \`${entry.from}\` | ${state} | ${entry.note}${masked}${entry.reason === undefined ? '' : ` (${entry.reason})`} |`;
	});

	const manifest = [
		'# 资产清单',
		'',
		`_生成于 ${stamp}_`,
		'',
		'**源和目标是两种不同的东西**：只恢复源码而不恢复注册（`install-state\\`），会得到一堆「装了但没生效」的文件。',
		'复制时排除 `node_modules`、`.git`、测试产物与 `_backup-*`。每个条目写入后都做了 SHA-256 校验。',
		'',
		'**校验之后还有一步脱敏**（见下）：文本资产里的敏感形态在副本里被遮蔽，所以带「已脱敏」标记的条目',
		'与源**不是逐字节相同**——差异只发生在被遮蔽的那几处，且由 `scrubVerified` 校验（行数不变、字节差 = 替换数）。',
		'先校验、后脱敏的顺序是有意的：先证明复制忠实，再单独证明遮蔽只动了该动的地方。',
		'',
		'| 包内路径 | 来源 | 文件 \\| KB | 说明 |',
		'|---|---|---|---|',
		...rows,
		'',
		`**合计 ${files} 个文件 / ${(bytes / 1024).toFixed(1)} KB。**`,
		'',
		`**已脱敏 ${scrubbed} 处，分布在 ${scrubbedAssets.length} 个条目里**（32 位 openid/peerId、公网 IPv4、\`sk-\` 密钥形态）。`,
		'遮蔽标记：`[REDACTED]` / `[REDACTED-IP]` / `[REDACTED-KEY]`。**真值不在本包里**——它们只在工作区原件里；',
		'恢复时凡是被遮蔽的字段（最要紧的是 bridge 的 `host`）都要重新填。',
		'',
		'## 没进包的东西（有意）',
		'',
		'| 没备份 | 为什么 |',
		'|---|---|',
		'| `node_modules` | 由 `dsh plugin add link:` 重建；符号链接本就不该复制 |',
		'| `%USERPROFILE%\\.dsh\\sessions\\` | 逐字会话日志，体积大；记忆树的快照已是它的语义化切片 |',
		'| `pnpm-lock.yaml` | pnpm 自己会重算 |',
		'| 敏感值本身（公网 IP / openid·peerId / `sk-` 密钥） | 树是只追加的，写进去就删不掉；副本在复制后遮蔽，真值留在工作区原件与凭据文件里 |',
		''
	].join('\n');

	// Derived, never hardcoded. The README used to say "两个插件" long after there
	// were five, and a restore document that miscounts what it is restoring is the
	// kind of wrong that costs an hour at exactly the worst moment.
	const pluginAssets = assets.filter((asset) => asset.to.startsWith('plugins/'));

	const readme = [
		'# 恢复说明（bootstrap bundle）',
		'',
		'> 这份包是**记忆树所在目录的副本**：插件源码、人设、技能、规则文件、辅助脚本与安装状态。',
		'> 如果 DSH 更新 / 重装 / 误操作导致它们丢失，用这份包恢复。',
		'',
		'## 它不会自己跑',
		'',
		'没有任何东西会替你执行这份包 —— 重装后的 DSH 不认识它，也不会去扫记忆树。',
		'两个前提：**DSH Desktop 已安装**、**机器上有 Node**。本包只含"你自己的东西"，',
		'不含 DSH 与 Node 本身。',
		'',
		'## 包里有什么',
		'',
		'| 包内路径 | 内容 | 恢复到哪 |',
		'|---|---|---|',
		`| \`plugins\\\` | ${pluginAssets.length} 个插件源码 | 工作区根下同名目录 |`,
		'| \`scripts\\\\\` | 辅助脚本目录（生成器 / 探测 / 实验） | 工作区根下同名目录 |',
		'| \`rules\\\` | 全局与工作区规则文件 | 各自原位 |',
		'| \`persona\\\` | agent 预设（人设正文在里面） | \`%USERPROFILE%\\.dsh\\.agent-presets\\\` |',
		'| \`skills\\\` | 技能 | \`%USERPROFILE%\\.dsh\\skills\\\` |',
		'| \`docs\\\` | 工作区文档 | 工作区根下 |',
		'| \`install-state\\\` | **「装成什么样」**：profile 的 package / cordis、全局设置 | 参考与校验，**别整份覆盖** |',
		'',
		'完整清单见同目录的 \`MANIFEST.md\`（含有带「已脱敏」标记的条目）。',
		'',
		'## 恢复步骤',
		'',
		'### 0. 前提',
		'',
		'- Node 可用；DSH Desktop 已安装',
		'- \`dsh\` CLI 可用（DSH Desktop 自带，通常在应用目录的 host-commands 下）',
		'- **恢复目标可能在会话工作区之外**：\`write\` / \`edit\` 工具会被文件沙箱拒绝，',
		'  所以恢复命令要用 **shell** 跑。**被沙箱拒绝不是 bug，是工具选错了，别绕。**',
		'',
		'### 1. 复制文件回去',
		'',
		'把 \`plugins\\\` / \`scripts\\\` / \`docs\\\` 覆盖到工作区根下同名目录，',
		'\`rules\\\` 里的规则文件各自放回原位，\`persona\\\` 与 \`skills\\\` 放回 DSH 状态目录。',
		'',
		'> **覆盖前先备份将被覆盖的东西**，不要直接盖。只备份会被覆盖的子项，',
		'> 移动目标目录本身会让恢复变成一个不可回滚的操作。',
		'',
		'### 2. 把插件注册回 profile',
		'',
		'**不要手工改 \`package.json\`。** 用 CLI —— 它一次处理三件事：写 \`dependencies\`、',
		'注册 \`dsh.profile.bundles\`、建 \`node_modules\` 符号链接。',
		'',
		'\`\`\`',
		'dsh plugin --profile <PROFILE> add link:<插件目录>',
		'\`\`\`',
		'',
		'**\`link:\` 依赖不进 lockfile**，所以本地插件不需要跑 install —— 跑了反而可能',
		'顺带升级别的包。装完**先自检，别急着重启**：',
		'',
		'\`\`\`',
		'node <插件目录>/test/loader-precheck.mjs',
		'\`\`\`',
		'',
		'> 自检里若出现「跳过 schema 校验」，**那不算通过** —— 它说明没找到 DSH 安装，',
		'> 因而一个工具 schema 都没验。先解决那件事再往下走。',
		'',
		'### 3. 恢复人设、技能与规则',
		'',
		'\`persona\\\` 放回 \`<DSH 状态目录>/\\.agent-presets/<预设名>/\`，\`skills\\\` 放回',
		'\`<DSH 状态目录>\\skills\\\`，规则文件各自回原位。然后确认设置里有默认预设项，',
		'否则人设不会生效 —— 但**别整份覆盖设置文件**：\`install-state\\\` 里那是旧快照，',
		'可能盖掉你后来的设置，照它对照补键即可。',
		'',
		'### 4. 自检 + 重启',
		'',
		'跑完每个插件自己的测试套件与载入期预检，全绿之后**重启 DSH Desktop**。',
		'\`lib/*.js\` 与配置**只在重启后生效** ——**客户端脚本是例外**，它靠页面的轮询热替换，',
		'这两件事别混。',
		'',
		'### 5. 重启后确认',
		'',
		'- 日志里应出现每个插件的 ready / installed 行',
		'- 让 agent 跑一次该插件自己的状态工具，看关键字段是否正常',
		'',
		'## 已知缺口（恢复后仍然缺的）',
		'',
		'- **不保证匹配新版 DSH**：插件依赖的宿主 API 若在新版里改了名或改了形状，会静默失效。',
		'  变了就**先去读源码核对字段名**，别凭记忆改。**「插件没坏」不等于「环境没坏」** ——',
		'  DSH 大更新之后，装在工作区之外的那几样要重新走一遍。',
		'- **会话日志不在包里**：逐字历史体积大，而记忆树的快照已是它的语义化切片。',
		'- **\`node_modules\` 不在包里**：由 link/install 重建；符号链接本就不该复制。',
		'- **第三方插件不在包里**：它们来自包管理器，不是本工作区的源码。照 \`install-state\\\` 对照重装。',
		'',
		'## 被遮蔽的值（**恢复时必读**）',
		'',
		'本包里的文本资产**在复制后**被遮蔽过：公网 IPv4、32 位 openid/peerId、\`sk-\` 密钥',
		'换成了 \`[REDACTED-IP]\` / \`[REDACTED]\` / \`[REDACTED-KEY]\`。',
		'（私有网段、\`127.0.0.1\`、\`0.0.0.0\` 刻意**保留**：它们有含义且从外面不可达。）',
		'',
		'**凡是被遮蔽的字段都要手工填回真值**，否则相关功能起得来但连不上。',
		'真值只在工作区原件与你的凭据里 —— 这是**有意**的取舍：宁可恢复时多填一个值，',
		'也不让一个密钥永久留在只追加的树里。',
		'',
		'**先校验、后遮蔽是有意的顺序**：先证明复制忠实，再单独证明遮蔽只动了该动的地方。',
		'所以带「已脱敏」标记的条目与源**不是逐字节相同**，差异只在被遮蔽的那几处。',
		'',
		'## 怎么刷新',
		'',
		'让 agent 调 **\`memory_backup\`** 工具。**什么时候刷新**：改完插件、改过人设、',
		'加了技能、改过规则文件之后 —— 它不会自己更新。',
		'',
		'---',
		'',
		`_生成于 ${stamp} · ${files} 个文件 · ${(bytes / 1024).toFixed(1)} KB · 已脱敏 ${scrubbed} 处_`,
		''
	].join('\n');

	writeFileSync(join(bundle, 'MANIFEST.md'), manifest, 'utf8');
	writeFileSync(join(bundle, 'README.md'), readme, 'utf8');

	return { written: bundle, stamp, entries, files, bytes, scrubbed };
}
