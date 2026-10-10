# 常见问题与解决办法

> 这份手册按**你会看到的原文报错**编排，不按概念编排 —— 出问题时你手上只有一行红字。
> 每一条都给了：**它长什么样** → **为什么会这样** → **怎么办**（命令可直接复制）。
>
> 最后更新：2026-10-11。
>
> **先做这一件事**，它能一次排除掉大半问题：
>
> ```powershell
> cd <插件目录>
> node test/loader-precheck.mjs
> ```
>
> 34 项全绿 = 插件本体、patch、依赖、根目录权限都没问题。红了就照它指的位置看下面。

---

## 目录

- [一、安装阶段](#一安装阶段)
- [二、重启后没反应](#二重启后没反应)
- [三、召回（嵌入模型）](#三召回嵌入模型)
- [四、建语料 build-corpus](#四建语料-build-corpusmjs)
- [五、运行期](#五运行期)
- [六、备份与灾难恢复](#六备份与灾难恢复)
- [七、卸载](#七卸载)
- [附录：三条「看起来像 A、其实是 B」](#附录三条看起来像-a其实是-b)

---

## 一、安装阶段

### 1.1 `'pnpm' 不是内部或外部命令`

```
dsh: initialized profile isotest at C:\Users\你\.dsh\profiles\isotest
Command failed with exit code 1: pnpm add "link:C:\插件\dsh-memory-tree"
'pnpm' 不是内部或外部命令，也不是可运行的程序
```

**这是最危险的一种失败**：profile 目录建出来了、`cordis.patch.yml` 也有了、"initialized" 那行照打 —— **看起来像成功**。但 `dependencies` 和 `dsh.profile.bundles` **都是空的**，插件永远不会被加载。

**为什么**：`dsh plugin add` **即使装的是本地 `link:` 目录也会调 pnpm**。`link:` 只意味着"不复制"，不意味着"不跑包管理器"。

**怎么办**：

```powershell
pnpm --version          # 没有就装
npm i -g pnpm
# 然后重来
dsh plugin --profile <PROFILE> add link:<插件目录>
```

**DSH Desktop 其实自带一份 pnpm**（`resources\runtime\pnpm\bin\pnpm.mjs`），但**没有加进 PATH**。想用它，自己做个 shim：

```bat
@echo off
"C:\Program Files\nodejs\node.exe" "E:\你的DSH安装目录\resources\runtime\pnpm\bin\pnpm.mjs" %*
```

存成 `pnpm.cmd`，把它所在目录加进 PATH。

**怎么确认装对了**（这一步别省）：

```powershell
type "$env:USERPROFILE\.dsh\profiles\<PROFILE>\package.json"
```

必须**同时**有两处：

```json
"dependencies": { "dsh-memory-tree": "link:C:/插件/dsh-memory-tree" },
"dsh": { "profile": { "bundles": [ ..., "dsh-memory-tree" ] } }
```

**只有一处 = 没装好。**

---

### 1.2 `profile "desktop" is managed exclusively by the Electron application`

**为什么**：新版本 DSH 把 `desktop` 这个 profile 名保护起来了，CLI 不许碰它。

**怎么办**：装 `desktop` 只能**手改 `package.json`**（照 1.1 那个形状，两处都写），然后**重启 DSH**。

想先验证包没问题，就**用别的名字**试（会自动初始化，全程不碰桌面版）：

```powershell
dsh plugin --profile isotest add link:<插件目录>
```

---

### 1.3 `Cannot find module '...\resources\app.asar\dsh\...\lib\bin.js'`

```
Error: Cannot find module 'E:\...\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js'
```

**为什么**：**DSH 升级换了布局**（打包的 `app.asar` → 解包的 `app\`），而 `dsh` 命令的 shim（`%APPDATA%\DSH Desktop\host-commands\desktop\bin\dsh.cmd`）里**写死了旧路径**。这个文件在安装目录**之外**，升级不会更新它。

**它平时不报错** —— 只有你真去敲 `dsh` 时才炸。所以可能已经坏很久了。

**怎么办**：把 shim 里的路径换成**现在存在的**那份：

```powershell
# 先找出真实路径
Get-ChildItem "E:\你的DSH安装目录" -Recurse -File -Filter 'bin.js' |
  Where-Object { $_.FullName -match '@deepseek-ai.dsh' } | Select-Object -First 3 FullName
```

然后编辑那个 `dsh.cmd`，把最后那行换成：

```bat
"<安装目录>\DeepSeek Harness.exe" --expose-internals "<上面找到的 bin.js 路径>" %*
```

**改前先复制一份备份。** 验证：`dsh --version` 能打出版本号就对了 —— 打不出则是路径还是错的（报的是 `Cannot find module`，不是别的）。

---

### 1.4 `loader-precheck` 报 FAIL

**它每条都叫得出名字**，对着下表看（一共 34 项）：

| FAIL 的那条 | 什么意思 | 怎么办 |
|---|---|---|
| `bundle patch parses to an array` | `cordis.patch.yml` 不是合法 YAML | 用 YAML 校验器看一遍。**最常见的原因：YAML 里写了一个函数调用**（例如 `root: homedir()/DSHMemory`）—— YAML 里那不是"值"，是普通文本，会被当成路径字符串。改成真正的路径 |
| `patch inserts the memory-tree row` / `row name matches the package` | patch 里那一行的 `name` 和包名对不上 | 检查 `cordis.patch.yml` 的 `- id: … / name: dsh-memory-tree` |
| `module resolves through the profile symlink` | 插件没被 profile 链接进去 | 重做安装（见 1.1 / 1.2），然后**重启** |
| `module exports inject` | 入口没导出 `inject` | 包不完整，重新解压一份 |
| `resolves lib/xxx.js` | 某处 `import` 写错，或者文件缺了 | 包不完整，重新解压一份 |
| `declared dependencies are installed` | **没装依赖** | 在插件目录跑 `npm install`（或 `pnpm install`）。**只想检查其它项**可以设 \`DSH_ALLOW_MISSING_DEPS=1\` |
| `package declares the bundle patch` | `package.json` 里没声明 patch | 包不完整，重新解压一份 |
| `runtime dependencies are only reached via dynamic import` | 有人把可选依赖改成了顶层 import | 那是 bug。可选依赖必须是**动态** import，否则缺它会让整个插件载入失败 |
| 整个文件报 `Cannot find package` | 同「declared dependencies」那条 | 同上 |

> 在**全新 checkout、还没装依赖**时，用 \`$env:DSH_ALLOW_MISSING_DEPS='1'\` 跑，它会跳过依赖那一项、其它照检。

> 在**全新 checkout、还没装依赖**时，可以设 `DSH_ALLOW_MISSING_DEPS=1` 跳过依赖那几项，其它照检。

---

## 二、重启后没反应

### 2.1 插件注册了，但像没装一样

**判据**：问 agent 跑 `memory_status`，返回"工具不存在"。

**为什么**：**宿主侧代码和配置只在启动时读一次。** 注册了但没重启 = 没装。

**怎么办**：**重启 DSH Desktop。**

> ⚠️ 唯一的例外是**客户端脚本**（界面那个小胶囊）：它靠页面每 60 秒轮询热替换，改它不用重启。
> **这两件事别混** —— 改 `lib\*.js` 或配置**一律要重启**。

---

### 2.2 重启后 DSH 直接起不来 / 弹「应用无法启动或已意外停止」

**为什么**：插件在载入期抛错了。最常见的是**声明了没人提供的服务**：

```js
export const inject = ['tools', 'systemPrompt', '某个不存在的服务'];
```

`inject` 里写一个没人提供的名字 **不是降级，是整棵插件树载入失败**。

**怎么办**：

1. 看崩溃日志：`%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*-web-boot.log`
2. 用「禁用第三方插件」的恢复入口启动
3. 修掉那个 `inject`，或者把插件从 `dsh.profile.bundles` 里摘掉

> ⚠️ **"端口活着"判不出这类故障** —— 宿主进程会照常起来并应答，崩的是渲染进程里的 web boot。
> 真判据是**有没有新的那个崩溃日志**。

---

## 三、召回（嵌入模型）

> 召回是**可选**的。没配好，树照常记录和读取，只是**不会给提示**。
> 所以这一节的所有问题，症状都是"一切正常，只是召回不工作"。

### 3.1 `local_files_only=true` … `file was not found locally at "..."`

```
Error: `local_files_only=true` or `env.allowRemoteModels=false` and file was not found locally at "...".
```

紧跟一条裸的：

```
TypeError: fetch failed
  [cause]: Error: connect ECONNREFUSED 127.0.0.1:1234
```

**这是最常撞的一个。** 两句话都没说清它去哪找了。

**为什么**：插件先找**本地 ONNX 模型**；找不到就退回**HTTP 兜底**（默认 `http://127.0.0.1:1234`）；那儿也没东西 ⇒ 两条路都不通。那句 `ECONNREFUSED` 不是"安装坏了"，是**没模型**。

**怎么办**：把模型放到位。默认位置是**记忆树根**下面：

```
C:\Users\<你>\DSHMemory\models\bge-small-zh-v1.5-onnx\
  config.json               tokenizer.json        tokenizer_config.json
  special_tokens_map.json   vocab.txt
  onnx\model_quantized.onnx
```

**六个文件都要**。`tokenizer.json` 最容易漏（手工复制时）。

自查一行：

```powershell
Test-Path "$env:USERPROFILE\DSHMemory\models\bge-small-zh-v1.5-onnx\onnx\model_quantized.onnx"
```

**False ⇒ 就是这个问题。**

模型放别处也行，但要改 `routerOnnxDir` 指向**含 `bge-small-zh-v1.5-onnx` 的那一层**（**它的父目录**，不是它本身）：

```yaml
# profile 的 cordis.patch.yml
routerOnnxDir: D:/我的模型/bge-parent-lie
```

---

### 3.2 `Cannot find package '@huggingface/transformers'`

**为什么**：插件目录里没装依赖。它是**动态 import**，所以设计上不会让插件载入失败 —— 代价就是只在真正要用的时候才报。

**怎么办**：

```powershell
cd <插件目录>
npm install          # 或 pnpm install
```

---

### 3.3 `onnx: routerOnnxDir is not configured`

**为什么**：配置里 `routerOnnxDir` 是**空串**。

**怎么办**：留空是**故意的默认值** —— 正常情况下插件会从记忆树根推导出 `<根>/models`。看到这条说明根路径也没推导出来（通常意味着 `root` 配置本身有问题）。显式写一个：

```yaml
routerOnnxDir: C:/Users/你/DSHMemory/models
```

---

### 3.4 `onnx: empty embedding` / `embeddings: no vector in response`

**为什么**：模型文件**损坏或截断**，或者 HTTP 兜底返回的形状不对。

**怎么办**：重新拷一遍模型，对照发布方给的 sha256 校验：

```powershell
Get-FileHash "$env:USERPROFILE\DSHMemory\models\bge-small-zh-v1.5-onnx\onnx\model_quantized.onnx" -Algorithm SHA256
```

---

### 3.5 模型都对，但召回从来不触发

按顺序查：

1. **语料建了吗** —— 召回比的是语料，不建就永远是空的：
   ```powershell
   cd <插件目录>
   node scripts/build-corpus.mjs --dry
   ```
   看 `合并后: N 条`，N 是 0 就什么都没得召回。

2. **刚建完？等 30 秒** —— 插件每 30 秒检查一次索引文件的时间戳，**改了就自动热重载**。不用重启 DSH。

3. **`router` 开关** —— `cordis.patch.yml` 里 `router: false` 会关掉整个召回。

4. **门槛太高** —— 相关度低于 `routerMinCos`（默认 0.60）会被丢掉。整段对话确实和过去无关时，**不触发才是对的**。

---

## 四、建语料（build-corpus.mjs）

### 4.1 `session log directory not found: <路径>`

**为什么**：脚本去找 `<DSH_HOME>\sessions`，没找到。

**怎么办**：

- **DSH 装在别的用户下** ⇒ 设 `DSH_HOME`
- **想指到别处** ⇒ 设 `MEMORY_TREE_SESSIONS`
- **空环境本来就没有会话** ⇒ 这是正常的，先正常用几天

```powershell
$env:MEMORY_TREE_SESSIONS = "C:\Users\你\.dsh\sessions"
node scripts/build-corpus.mjs
```

---

### 4.2 语料建好了，但条数少得离谱 / 只有几条

**为什么**：脚本只索引**你自己说的话**。实测一份真实日志里：

| 内容 | 占比 | 索引吗 |
|---|---|---|
| 真人发言 | 1.8% | **是** |
| 助手回复 | 12.5% | 否 |
| 流式碎片（`reasoning-chunks`、`assistant/chunk`…） | 85.7% | 否 |

**⇒ 一千条日志里抽出十几条真人发言，是正常的。** 碎片是模型一个字一个字往外吐的中间态，索引它们会把信号埋掉。

---

### 4.3 脚本报 `Unexpected token '?'` 之类，或者一跑就崩

**为什么**：多半是**日志格式**的坑，不是你的错。DSH 的会话日志**不是单个 zstd 帧** —— 它**一行一帧**（一份 36 MB 的日志有 8 万多帧）。

**症状**：用整文件解压的写法，只会拿到**第一帧**（会话头，约 178 字节）——一个**看起来完全成功的空日志**。

本包的脚本已经按帧边界走，不会有这个问题。**如果你自己写脚本读日志，记住这一条。**

另一个：每个会话有**好几代**（`session.jsonl` / `.v3` / `.v4`）——同一段对话的不同 schema 版本。**读两代会把每轮记两遍**，所以只读最新那代。

---

### 4.4 `embedding failed at batch`

**为什么**：编码到一半失败了（多半是模型被移走，或者内存不够）。

**怎么办**：**语料和索引保持原样，没有写坏**。修好之后重跑即可（**幂等**）。

---

## 五、运行期

### 5.1 `no such node yet (the tree creates a level only once it has content)`

**这不是错误。** 树是**惰性创建**的：某一天没内容，那天就没有文件。

读一个还不存在的日期就会看到它。**说明那天还没发生任何值得记的事。**

---

### 5.2 `<日期> is before the tree start <日期>`

**为什么**：树有一个**下界**（`START_DATE`，默认 `2000-01-01`），是**防呆**用的 —— 挡住"时间戳坏了"造出一个 1970 的目录、然后永远留在树里。

**怎么办**：

- 日期是**正常的**却报这个 ⇒ 你的 `START_DATE` 被改高了，调回去
- 想读**装插件之前**的历史 ⇒ 树里本来就没有，得先 `memory_import` 把它灌进去

---

### 5.3 `memory-tree: could not allocate a snapshot name in <目录>`

**为什么**：**同一秒内**已经在写同名快照了。

**怎么办**：极少见。**删掉那个目录里的临时文件**（`*.tmp`）再试；或等一分钟。

---

### 5.4 界面上的小胶囊显示「引擎离线」

**为什么**：召回那条路不通（见第三、四节）。

**注意**：**这不影响树的记录与读取**。它只是说"召回现在不工作"。

---

### 5.5 日文件里写着「（待首次快照后填写）」

**不是错误。** 那个字段要等**第一次快照**（自动到压力阈值，或手动 `memory_snapshot`）才会填。

想立刻看到内容就手动触发一次：

```
memory_snapshot
```

---

### 5.6 机械流水是空的

**先确认它真的空**（流水每轮一行）：

```powershell
Select-String -Path "$env:USERPROFILE\DSHMemory\2026\*\*\*.md" -Pattern '^\| \d{2}:\d{2}:\d{2} \|' | Select-Object -First 5
```

- **真的一行都没有** ⇒ `cordis.patch.yml` 里 `turnLog: false` 关掉了
- **有** ⇒ 是我（或你）的 grep 写错了（注意时:分:秒三段）

---

## 六、备份与灾难恢复

### 6.1 `copy verification failed for <文件>`

**为什么**：备份**边复制边校验**，复制出来的和源**字节不一致**。常见原因：磁盘满了、盘在报错、或者文件正在被写。

**怎么办**：**树本身没被动过**（备份是只读源的）。腾出空间或修好盘再跑一次。**这是真信号，别忽略**。

---

### 6.2 `redact: N hit(s) survived scrubbing <文件>`

**为什么**：**遮蔽**没盖干净（备份包在记忆树里，必须遮蔽）。

**怎么办**：**这是 bug，不是配置问题** —— 请把这条原文和 `label` 一起反馈。**在它修好之前，不要把这个备份包分享出去。**

---

### 6.3 恢复之后发现某些值变成了 `[REDACTED]`

**这是设计。** 备份包在树里，所以它的**文本资产**在写入时就被遮蔽了。恢复后**必须重填**的通常是：

- profile 配置里的 `host` / 地址
- 任何 key、token、openid

**原因**：那些值只在工作区原件和凭据文件里，**不在这个包里**。

---

## 七、卸载

```powershell
dsh plugin --profile <PROFILE> remove dsh-memory-tree
```

**记忆树一个字节都不会动** —— 插件只追加，从不删。要删树得你自己动手。

> ⚠️ 如果 `dsh plugin remove` 也卡在 1.1 那个 pnpm 问题上，就**手改 `package.json`**：把 `dependencies` 和 `dsh.profile.bundles` 里那两处删掉，再重启。

---

## 附录：三条「看起来像 A、其实是 B」

### A. 「装了但没生效」≠「装错了」

**九成是没重启。** 宿主侧代码和配置只在启动时读一次。判据：`cordis.yml` 的文件时间 == DSH 主进程的启动时刻。

### B. 「端口活着」≠「界面起来了」

DSH 崩在 web boot 时，**宿主进程照常起来并应答 HTTP**。所以"端口通、能返回 401"**证明不了**界面是好的。

真判据：重启时刻**之后**有没有新的 `crash-*-web-boot.log`。

### C. 「命令跑完了」≠「事情做成了」

`dsh plugin add` 会在**半途失败**时照打 "initialized" 那行。所以**永远读产物，不读提示**：

- 装插件 → 读 `package.json` 的两处
- 建语料 → 读 `corpus.jsonl` 的行数
- 建索引 → 读 `embed_meta.json` 的 `count`

**这一条能省掉你大半的排错时间。**
