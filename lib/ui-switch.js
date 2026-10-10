/* dsh-memory-client rev: 26 */
/* dsh-memory-tree 的界面开关（内联注入，桌面端唯一通道）。v12
 *
 * v12 的核心变化：**任何一步出错都不许拖垮轮询** ✗。
 *   起因（2026-10-01）：v11 上线后卡片一直不弹，而 `clientProbe` 也是空的 ⇒ 说明页面
 *   **根本没在发轮询** ⇒ 极可能一开头就抛错、被最外层 try 吞掉 ✗。
 *   现在：① 每个 tick、每次绘制各自 try/catch；② 出错把**错误原文**放进 `?probe=` 上报 ✓
 *   （下次"卡片不弹"能一眼看出原因，而不是靠猜 ✗）；③ 心跳计数也上报 ✓。
 *
 * 其余约束沿用（都是被现实打回来的）：
 *  1. 固定位置（预设 chip / "轨迹"行只在部分视图存在 ✗）；
 *  2. 节点挂 body + 每 3 秒自愈 ✓；真 <button> + no-drag + pointer-events:auto ✓；
 *  3. 失败显示状态码 ✓；版本号竞争 ✓；会话走查询串/请求体 ✓（自定义头会被 CORS 丢掉 ✗）；
 *  4. 引擎状态显示 ✓（"引擎离线"）——静默失效的教训 ✓；
 *  5. 卡片 = 候选级判定（top-3 +【都不正确】+【本轮无关联】+【跳过】）✓，**没有时限**，直到你回答 ✓。
 *
 * v24 的变化（2026-10-09，用户提的）：**多一个明确的"本轮无关联记忆"选项**。
 *   为什么需要它 —— 判别标签的根本缺陷（实测 246 轮后确认）：
 *     `picks.jsonl` 只记了"点了哪张卡"，没记"这一轮到底有没有正确答案"。
 *     于是「都不正确」把两种情况混成一类：
 *       (a) 确实没有相关记忆        ⇒ 这次注入本就是多余的
 *       (b) 有，但没弹出来          ⇒ 是召回漏了
 *     这两类分不开，任何排序改进都会被噪音淹没 —— 前面十条改动全撞墙的根因就在这里。
 *   ⇒ 现在多一个按钮，把 (a) 显式标出来：
 *       · 都不正确   choice='none' batch='all'      这些候选不对（也许另有一天对）
 *       · 本轮无关联 choice='none' batch='noanswer' 这轮根本不该有记忆（确定性的负样本）
 *       · 下一批     choice='none' batch=<数字>     翻页（不算判定）
 *   复用 choice='none' 是为了不改后端的校验分支；语义靠 batch 区分，
 *   与「下一批」用数字、 「都不正确」用 'all' 是同一套约定。
 *
 * v25 的修正（2026-10-09，用户看截图指出的矛盾）：
 *   「已注入的关联 —— 哪条对？」卡片上同时挂着【本轮无关联】，逻辑自相矛盾 ✗。
 *   规则：**只要卡片给出了候选（有 options），就不显示【本轮无关联】**；
 *   无候选的卡片（"没有关联记忆"那种）才显示它。⇒ 两种卡片互斥。
 */
(function () {
	'use strict';
	var VERSION = 26;
	// Generation guard: when a newer copy takes over via hot-reload, every older instance must go
	// dormant — otherwise its timers keep re-mounting a stale pill ON TOP of the new one
	// (measured 2026-10-01: v16 did take over, but the v15 pill was re-appended over it, so the
	// human still saw "v15").
	var HAS_WINDOW = (typeof window !== 'undefined');
	var GEN = 1;
	if (HAS_WINDOW) {
		try {
			GEN = (window.__dshMemorySwitchGen || 0) + 1;
			window.__dshMemorySwitchGen = GEN;
		} catch (err) { }
	}
	var lastError = '';
	var ticks = 0;
	try {
		if ((window.__dshMemorySwitchVersion || 0) >= VERSION) return;
		window.__dshMemorySwitchVersion = VERSION;
	} catch (err) { return; }

	var STATE_URL = '/dsh-memory/state';
	var TOGGLE_URL = '/dsh-memory/auto';
	var POLL_MS = 15000;
	var last = null;
	var busy = false;
	var answeredKey = null;
	var page = 0;            // which batch of 3 is on screen (ranking supervision)
	var pageKey = null;      // the candidate set this page belongs to
	var host = null;
	var card = null;
	var pill = null;
	var dot = null;
	var label = null;
	var meta = null;
	var cardTitle = null;
	var cardButtons = null;

	function note(where, error) {
		lastError = where + ': ' + String(error && error.message ? error.message : error).slice(0, 180);
	}

	/** Everything that touches the DOM runs through here: a failure must never stop the poll. */
	function guard(where, fn) {
		try { return fn(); } catch (error) { note(where, error); return undefined; }
	}

	function mount() {
		if (HAS_WINDOW && GEN !== window.__dshMemorySwitchGen) return;   // superseded by a newer copy
		guard('mount', function () {
			if (host && !host.isConnected) document.body.appendChild(host);
			if (card && !card.isConnected) document.body.appendChild(card);
		});
	}

	guard('bootstrap', function () {
		var stale = document.querySelectorAll('[data-dsh-memory-switch]');
		for (var s = 0; s < stale.length; s += 1) { if (stale[s].parentNode) stale[s].parentNode.removeChild(stale[s]); }

		var BASE = 'display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 8px;' +
			'border-radius:11px;font-size:11px;line-height:20px;cursor:pointer;user-select:none;' +
			'border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.06);color:#cfd6e4;' +
			'white-space:nowrap;font-family:inherit;' +
			'-webkit-app-region:no-drag;app-region:no-drag;pointer-events:auto;';

		host = document.createElement('div');
		host.setAttribute('data-dsh-memory-switch', 'pill');
		host.setAttribute('style',
			'position:fixed;z-index:2147483000;pointer-events:auto;-webkit-app-region:no-drag;app-region:no-drag;' +
			'display:inline-flex;align-items:center;top:38px;right:18px;');

		pill = document.createElement('button');
		pill.type = 'button';
		pill.setAttribute('style', BASE);
		pill.title = '点击切换"自动总结归纳"（每个会话独立）';
		dot = document.createElement('span');
		dot.setAttribute('style', 'width:7px;height:7px;border-radius:50%;background:#8b93a5;flex:0 0 auto;display:inline-block;');
		label = document.createElement('span');
		label.setAttribute('style', 'flex:0 0 auto;');
		label.textContent = '记忆总结';
		meta = document.createElement('span');
		meta.setAttribute('style', 'flex:0 0 auto;opacity:.7;');
		meta.textContent = '…';
		pill.appendChild(dot); pill.appendChild(label); pill.appendChild(meta);
		host.appendChild(pill);

		card = document.createElement('div');
		card.setAttribute('data-dsh-memory-switch', 'card');
		card.setAttribute('style',
			'position:fixed;z-index:2147483001;left:50%;transform:translateX(-50%);top:38px;display:none;' +
			'flex-direction:column;gap:6px;padding:9px 12px;border-radius:10px;font-size:12px;font-family:inherit;' +
			'max-width:min(860px,86vw);background:rgba(20,24,36,.96);color:#dbe2ee;border:1px solid rgba(255,255,255,.22);' +
			'box-shadow:0 6px 24px rgba(0,0,0,.45);-webkit-app-region:no-drag;app-region:no-drag;pointer-events:auto;');
		cardTitle = document.createElement('div');
		cardTitle.setAttribute('style', 'opacity:.85;');
		card.appendChild(cardTitle);
		cardButtons = document.createElement('div');
		cardButtons.setAttribute('style', 'display:flex;gap:6px;flex-wrap:wrap;align-items:center;');
		card.appendChild(cardButtons);

		pill.addEventListener('click', function (event) {
			try { event.preventDefault(); event.stopPropagation(); } catch (err) { }
			guard('toggle', toggle);
		});
		pill.addEventListener('mousedown', function (event) { try { event.stopPropagation(); } catch (err) { } });

		mount();
	});

	function sessionHint() {
		try {
			var href = String(window.location.href || '');
			var byId = href.match(/session[-/]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
			if (byId) return byId[1];
			var byQuery = href.match(/[?&#]session=([^&#]+)/i);
			if (byQuery) return decodeURIComponent(byQuery[1]);
		} catch (err) { }
		return '';
	}

	function probeText() {
		var parts = ['v' + VERSION, 't' + ticks];
		if (lastError) parts.push('ERR=' + lastError);
		try { parts.push('href=' + String(window.location.href || '').slice(0, 160)); } catch (err) { }
		return parts.join(';').slice(0, 300);
	}

	function stateUrl() {
		var parts = [];
		try {
			var session = sessionHint();
			if (session) parts.push('session=' + encodeURIComponent(session));
			parts.push('probe=' + encodeURIComponent(probeText()));
		} catch (err) { }
		return parts.length > 0 ? (STATE_URL + '?' + parts.join('&')) : STATE_URL;
	}

	function headers(extra) {
		var out = extra || {};
		try {
			var session = sessionHint();
			if (session) out['x-dsh-session'] = session;
			out['x-dsh-probe'] = probeText();
		} catch (err) { }
		return out;
	}

	function button(text, title, handler) {
		var b = document.createElement('button');
		b.type = 'button';
		b.textContent = text;
		if (title) b.title = title;
		b.setAttribute('style', 'cursor:pointer;font:inherit;padding:3px 10px;border-radius:7px;' +
			'border:1px solid rgba(255,255,255,.25);background:rgba(255,255,255,.08);color:#e8eefc;' +
			'-webkit-app-region:no-drag;pointer-events:auto;max-width:360px;text-align:left;line-height:1.35;white-space:pre-line;');
		b.addEventListener('click', function (event) {
			try { event.preventDefault(); event.stopPropagation(); } catch (err) { }
			guard('button', handler);
		});
		return b;
	}

	function paint(state) {
		mount();
		if (!state) { if (meta) meta.textContent = '不可用 · v26'; return; }
		var on = state.autoSummary === true;
		if (dot) dot.style.background = on ? '#4ade80' : '#f87171';
		if (label) label.textContent = on ? '自动总结 开' : '自动总结 关';
		var engine = state.routerError ? ' · 引擎离线' : '';
		if (meta) meta.textContent = '召回 ' + (state.routed || 0) + ' · 注入 ' + (state.routerInjected || 0) + engine + ' · v26';
		if (pill) pill.title = '点击切换（会话 ' + (state.session || state.clientSession || '未知') + '；嵌入=' + (state.routerTransport || '?') + '）' +
			(lastError ? '；错误：' + lastError : '');
		showPick(state);
	}

	function showPick(state) {
		guard('showPick', function () {
			var set = state && state.lastCandidates;
			var key = String((set && (set.key || set.at)) || '');
			// The host decides whether this turn deserves a CARD at all. A message that has a topic
			// but is not a memory question (present state / action request — "帮我把…打开下") still
			// gets a note for the agent, yet must never ask the human to judge it (2026-10-03).
			if (set && set.cardEligible === false) { if (card) card.style.display = 'none'; return; }
			// If the human is paging THIS card, our own local state outranks the host's `rated`
			// flag. The host used to mark a batch rejection as final (fixed, but only after a
			// restart), which made the freshly-paged card vanish on the next 15s poll (2026-10-02).
			var paging = key === pageKey && page > 0;
			if (!card || !set || set.offer !== true || (set.rated === true && !paging)) { if (card) card.style.display = 'none'; return; }
			if (key === answeredKey) { card.style.display = 'none'; return; }
			if (key !== pageKey) { pageKey = key; page = 0; }
			var options = Array.isArray(set.options) ? set.options : [];
			// v26 (2026-10-09, 用户定)：**每轮都弹卡**，够格的给候选、不够格的让你直接判这一轮。
			//   有候选  → 候选卡片就是"哪条对"，所以「本轮无关联」不出现（会和卡片自己的问题矛盾）；
			//  无候选  → 不显示候选，只问这一轮本身：有关联（没找到）／根本没关联／跳过。
			// 阈值那道坎从"弹不弹"挪到了"给不给候选"，判定数据因此每轮都能收到。
			// `showOptions` 由后端给（topCosine >= routerPickFloor）；缺省回落到"有候选就显示"，
			// 这样旧后端配新前端也不会哑掉。
			var showOpts = set.showOptions === undefined ? options.length > 0 : set.showOptions === true;
			var hasOptions = showOpts && options.length > 0;
			var from = page * 3;
			if (from >= options.length) { from = 0; page = 0; }
			var slice = hasOptions ? options.slice(from, from + 3) : [];
			card.setAttribute('data-key', key);
			cardTitle.textContent = hasOptions
				? (set.injected ? '已注入的关联' : '这次没注入，但有几条接近的') + ' —— 哪条对？' +
					(options.length > 3 ? '（第 ' + (from + 1) + '–' + (from + slice.length) + ' 名，共 ' + options.length + ' 条）' : '')
				: '这轮没找到够格的关联 —— 你怎么判？';
			while (cardButtons.firstChild) cardButtons.removeChild(cardButtons.firstChild);
			for (var i = 0; i < slice.length; i += 1) {
				(function (option, offset) {
					var when = '';
					try {
						when = option.hits && option.hits[0] && option.hits[0].time
							? new Date(option.hits[0].time).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(5, 16) : '';
					} catch (err) { when = ''; }
					var words = option.hits && option.hits[0] ? String(option.hits[0].text || '').trim() : '';
					var text = (when || String(option.date || '?')) + ' · ' + option.cosine +
						(words ? '\n「' + words.slice(0, 60) + (words.length > 60 ? '…' : '') + '」' : '');
					cardButtons.appendChild(button(text, words ? '「' + words + '」' : '', function () { pick(String(option.date), key, options, set.query, from + offset, null); }));
				})(slice[i], i);
			}
			if (options.length > from + slice.length) {
				cardButtons.appendChild(button('下一批 ▸', '这几条都不是 —— 看第 ' + (from + 4) + ' 名起（会记下"前 ' + (from + slice.length) + ' 名都不对"）', function () {
					// Report the batch rejection, then advance — WITHOUT marking the card answered,
					// so the next page actually renders (2026-10-02 fix).
					report('none', key, options, set.query, null, from);
					page = (from + 3) / 3;
					showPick(state);
				}));
			}
			// 【都不正确】两种卡片都在：有候选时是"这些候选不对"，没候选时是
			// "我认为这轮应该有关联，只是你没找到" —— 后者正是最有价值的漏报样本。
			cardButtons.appendChild(button('都不正确',
				hasOptions
					? '这些候选不是我想的那个记忆（但也许另有一天是对的）' + (options.length > 3 ? '（全部 ' + options.length + ' 条）' : '')
					: '我判断这一轮确实有关联记忆，只是没被找到',
				function () { pick('none', key, options, set.query, null, 'all'); }));
			// 【本轮无关联】只在没有候选时出现 —— 有候选的卡片上它是自相矛盾的
			// （卡片问"哪条对"，按钮说"本来就没有"）。实测 2026-10-09 用户指着截图指出。
			if (!hasOptions) {
				cardButtons.appendChild(button('本轮无关联', '这一轮本来就不该召回记忆（比如在问当下的事、只是聊两句）—— 确定没有相关的过去记忆', function () { pick('none', key, options, set.query, null, 'noanswer'); }));
			}
			cardButtons.appendChild(button('跳过', '这次不判定（不写训练数据）', function () { pick('skip', key, options, set.query, null, null); }));
			card.style.display = 'flex';
		});
	}

	/** Post one recorded judgement. Deliberately separate from pick(): "下一批" must be able to
	 * report a batch rejection WITHOUT marking the card answered — doing that hid the card and the
	 * next page never came back (the human hit exactly this, 2026-10-02). */
	function report(choice, key, options, query, rank, batch) {
		return fetch(TOGGLE_URL, {
			method: 'POST', credentials: 'same-origin',
			headers: headers({ 'content-type': 'application/json' }),
			body: JSON.stringify({ pick: { choice: choice, key: key, options: options, query: query, rank: rank, batch: batch }, session: sessionHint() || undefined })
		}).then(function (r) {
			if (!r.ok) { if (label) label.textContent = '记录被拒 ' + r.status; }
		}).catch(function (error) { note('report', error); if (label) label.textContent = '记录失败'; });
	}

	function pick(choice, key, options, query, rank, batch) {
		answeredKey = key;
		if (card) card.style.display = 'none';
		report(choice, key, options, query, rank, batch);
	}

	function getState() {
		return fetch(stateUrl(), { credentials: 'same-origin', headers: headers() })
			.then(function (r) { return r.ok ? r.json() : null; })
			.catch(function (error) { note('getState', error); return null; });
	}

	function toggle() {
		if (busy) return;
		busy = true;
		var want = !(last && last.autoSummary === true);
		if (dot) dot.style.background = '#facc15';
		if (label) label.textContent = want ? '自动总结 开…' : '自动总结 关…';
		fetch(TOGGLE_URL, {
			method: 'POST', credentials: 'same-origin',
			headers: headers({ 'content-type': 'application/json' }),
			body: JSON.stringify({ on: want, session: sessionHint() || undefined })
		}).then(function (r) {
			if (!r.ok) { busy = false; if (dot) dot.style.background = '#f87171'; if (label) label.textContent = '切换被拒 ' + r.status; return null; }
			return r.json();
		}).then(function (s) { if (s) { last = s; paint(s); } else if (busy) { paint(last); } })
			.catch(function (error) { note('toggle', error); busy = false; if (label) label.textContent = '切换失败'; if (dot) dot.style.background = '#f87171'; })
			.then(function () { busy = false; });
	}

	function tick() {
		if (HAS_WINDOW && GEN !== window.__dshMemorySwitchGen) return;   // superseded: stop polling
		ticks += 1;
		getState().then(function (state) { last = state; guard('paint', function () { paint(state); }); })
			.catch(function (error) { note('tick', error); });
	}

	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { guard('tick', tick); });
	else guard('tick', tick);
	setInterval(function () { guard('tick', tick); }, POLL_MS);
	setInterval(function () { guard('mount', mount); }, 3000);
	// Janitor: a copy that is no longer the newest must not leave visual debris behind. Older
	// instances (written before the generation guard existed) keep re-mounting their own node,
	// but their mount() only appends **when it is not connected** — so HIDE instead of REMOVE:
	// keeping the stale node connected stops the re-append entirely, and the 1-second
	// remove/re-add tug-of-war (visible flicker, measured 2026-10-01) goes away for good.
	setInterval(function () {
		if (!HAS_WINDOW || GEN !== window.__dshMemorySwitchGen) return;
		guard('janitor', function () {
			var nodes = document.querySelectorAll('[data-dsh-memory-switch="pill"], [data-dsh-memory-switch="card"]');
			for (var i = 0; i < nodes.length; i += 1) {
				var node = nodes[i];
				if (node === host || node === card) continue;
				if (node.style && node.style.display !== 'none') node.style.display = 'none';
			}
		});
	}, 1000);
}());
