# dsh-agent-defs

写一个 Markdown 文件，就能给 DeepSeek Harness 增加一个可被主代理挑选的子代理定义。

每个 `~/.agents/agent/*.md` 会变成一个 **Agent Preset**：frontmatter 决定这个子代理挂哪些工具、用哪些 skills，正文就是它的人设。主代理委派时通过 `subagent_defined` 工具的 `agent_preset` 参数从这些定义里挑一个。

改文件即时生效（默认 2 秒轮询）；已在运行的会话保留启动时的组合，下一次委派用新版本。

它同时接管了官方委派工具的可见性：只要本插件的委派工具在服务，`subagent` / `subagent_fork` 就从模型视野里消失，避免两个工具争同一个决策。

## 为什么不是“直接定义子代理”

0.2.1 起 `dsh-tool-subagent` 移除了 `persona` 与 `toolFilter`：子代理的人设、工具、skills 全部来自它所属的 Agent Preset。这个插件就是“给 preset 写一个 Markdown 前端”，所以文件格式是你熟悉的，底层仍是原生机制。

## 为什么要自己注册委派工具

两个原因，缺一不可：

1. **模型路由**。`tool-subagent` 的 `agentOptions` 是**工具实例级**的，同一实例的所有子代理共用一个路由；preset 也表达不了 per-child 路由。只有自己实现 `execute` 才能在每次调用时决定模型。
2. **可见性**。官方 `subagent` 由 Web preset 挂在该 preset 的 scope 里，是每个绑定 agent 的**祖先 scope**——profile 层的 `disabled: true` 够不着，`tools.restrict()` 又必须在那个精确的 agent scope 里调用。所以只能在请求组装处（`system-prompt/assemble`）把它从模型视野移除。

两者必须一起做：只注册自己的工具，模型仍会看到官方那个并优先用它；只隐藏官方工具而没有替代品，模型就完全失去委派能力。所以隐藏逻辑**门控在“我们的工具真的挂载成功”之上**——定义目录为空时，官方工具照常可见。

## 定义文件格式

默认形态就是三样东西：**名字、简介、prompt**。

```markdown
---
name: tdd-guide
description: Test-Driven Development specialist enforcing write-tests-first methodology. Use PROACTIVELY when writing new features, fixing bugs, or refactoring code.
---

You are a Test-Driven Development (TDD) specialist who ensures all code is developed test-first.

## TDD Workflow
...
```

扫描目录默认 `~/.agents/agents`。**不写 `tools`、`skills`、`model` 时，子代理继承主代理的全部工具、技能与模型**——文件只描述“这个子代理是谁”。

| 键 | 必填 | 含义 |
|---|---|---|
| `name` | 否 | 子代理的名字，也是主代理看到的枚举值；省略时取文件名。小写字母/数字/连字符 |
| `description` | **是** | 主代理据它在多个定义间做选择 |
| `tools` | 否 | **写了即进入独立模式**：只挂这些工具组，不再继承 |
| `skills` | 否 | 写了即进入独立模式：只挂这些 skill 目录 |
| `model` | 否 | 写了即进入独立模式：该子代理固定用这个模型 |
| `when-to-use` | 否 | 单独成行展示的“何时该选我” |
| `persona-prefix` | 否 | 加在正文之前的人设前缀 |
| `communication` | `true` | 是否给子代理 `send_message` 并告知它能双向通信；`false` 关掉 |

### 两种模式

| | 继承模式（默认） | 独立模式 |
|---|---|---|
| 触发 | 不写 `tools`/`skills`/`model` | 写了其中任意一个 |
| 工具 | **父代理的全部** | 只有列出的组 |
| skills | **父代理的全部** | 只有列出的目录 |
| 模型 | **父代理的** | 文件里的默认值，主代理可覆盖 |
| 实现 | 子代理加入父代理的 preset 代际，只替换人设 | 注册独立 preset，子代理挂载它 |

继承模式是**默认且推荐的**：你写给 agent 的定义通常只说“你是谁、怎么做事”，能力范围由主代理决定。它也最省心——父代理挂什么，子代理就有什么。

写了 `tools: []`（显式空）是“不给任何工具”，与省略不同。

正文（`---` 之后的部分）整体成为 `dsh-persona` 的 `prefix`。

### 双向通信是默认的

每个定义都会自动获得 `send_message`（挂 `dsh-tool-subagent-control`），人设末尾追加一段 **Reporting back**，告诉子代理：

- 可以用 `send_message` + 委派者的 `agent_id` 发进度、提问、报阻塞
- 父代理发来的消息会作为普通轮次到达，应用到当前工作而不是重来
- 只在父代理需要行动时才发，不要每步都发
- 最终回答仍会结束本轮，`send_message` 用于等不到那时的信息

**为什么必须默认给**：shipped 的 `subagent` 只注册委派本身，`send_message` 是**另一个插件**；不挂它，子代理只能在整轮结束时回答一次，父代理中途问不了任何东西。而 shipped 的委派提示（`SUBAGENT_DELEGATION_CONTEXT`）只讲权限受限，**一个字都没提可以回报**——不明确告诉子代理，它就不会用。

不需要双向通信的定义写 `communication: false`（比如纯一次性只读审查）。

### 模型：文件默认 + 主代理覆盖

`model` 支持两种写法：

```yaml
model: deepseek-v4-flash                        # 只用模型 id，provider 取插件的 defaultProvider
model: magpie/workbuddy-ai/deepseek-v4.1-flash  # 同时指定 provider 和模型（按第一个 / 切分）
```

三层优先级，高到低：

1. **主代理在调用时显式传入** `provider` + `model`（`reasoning_effort` 可选）
2. **定义文件里的 `model`**
3. 插件配置的 `expose.model` / 无

如果三层都没有，子代理**继承主代理的路由**，与 shipped 的 `subagent` 工具行为一致。

**文件里的 `model` 是默认值，不是约束。** 它写的时候不知道运行环境有什么适配器，所以：

- 写了 `model` 的定义 → 主代理不传就自动用它
- **主代理传了 → 永远覆盖**，即使文件里的默认值在这台机器上不可用，也不影响你救场
- 文件里的 `model` **解析失败**（比如裸 id 但没有 `defaultProvider`）→ 只丢掉这个默认值，定义仍然可选，你在调用时传完整路由即可
- 默认值不可用时，只有调用时**也不传**路由才会失败，报错来自 `ctx.llm.resolveCallConfig` 的适配器检查

换路由时如果没给 `reasoning_effort`，会丢弃文件里为旧模型设的强度——新模型用自己的默认值。给旧模型设的 `high` 不该悄悄套到新模型上。

`model` 只在定义文件的 `---` 里生效；`dsh-agent-preset` 的 `config` 里没有对应字段（`agentOptions` 是工具实例级的，preset 无法表达 per-child 路由），所以本插件自己实现了委派工具。

### 工具组

`tools` 接受组名或具体工具名，两者可以混写；工具名会被折算成它所属的组。

| 组 | 提供的工具 |
|---|---|
| `fs` | `read` `write` `edit` `read_image` |
| `search` | `glob` `grep` |
| `shell` | `bash`（非 Windows）/ `pwsh`（Windows） |
| `jobs` | `job_list` `job_output` `job_kill` |
| `web` | `web_search` `web_fetch` |
| `todo` | `todo_write` |
| `ask` | `ask_user_question` |
| `present` | `present` |
| `goal` | `create_goal` `get_goal` `update_goal` |
| `schedule` | `schedule_create` `schedule_list` `schedule_update` `schedule_delete` |
| `mcp` | `list_mcp_resources` `list_mcp_resource_templates` `read_mcp_resource` |
| `delegate` | `subagent` `subagent_fork` `send_message` `interrupt_agent` `list_agents` |

**为什么按组而不是按工具名**：preset 只能“挂什么”不能“减什么”，`tools.restrict()` 只过滤继承来的名字，且拒绝命名本 scope 自己注册的工具。所以“只给 `read` 不给 `write`”无法用工具名表达。要只读文件，用 `fs` 的配置行改（见下）。

`workflow`、`run_code`、`lsp`、`terminal_open` 需要部署级配置（引擎、模型路由、后端行），不能用名字选，写进 `tools` 会明确报错。

### 只读子代理

`fs` 组默认四个工具全开。要限制，覆盖该定义的插件行——把 `lib/compile.js` 里 `fs` 组的 `plugins` 改成：

```js
plugins: [{ name: '@deepseek-ai/dsh-tool-fs', config: { write: false, edit: false } }],
```

或者更简单：`tools: [search]` 不给 `fs`。

### skills 按目录选，不按名字选

`dsh-tool-skill` 没有名称白名单，`skill-filesystem` 只认根目录下的 `<name>/SKILL.md` 或平铺 `<name>.md`。所以要“只用某几个 skill”，建一个只放它们的目录，然后：

```yaml
skills: ['C:/path/to/that/dir']
```

定义挂载时设 `includeDefaultRoots: false`，子代理的 skill 目录里不会混入全局 skills。

## 安装

```sh
dsh plugin --profile web add C:/Users/dream/dsh-pulgn/dsh-agent-defs
```

或者直接在 `~/.dsh/profiles/web/cordis.patch.yml` 末尾加：

```yaml
- insert:
    - id: agent-defs
      name: 'file:///C:/Users/dream/dsh-pulgn/dsh-agent-defs/lib/index.js'
      config:
        roots: ['C:/Users/dream/.agents/agents']
        watchIntervalMs: 2000
        order: 100
        includeSkillLoader: true
        expose:
          toolName: subagent_defined
          provider: spawn
```

只写 `name`/`description`/正文的定义**不需要** `agent-preset-registry`——它们是继承模式，不注册 preset。只有独立模式（写了 `tools`/`skills`/`model`）才需要。改完 patch 后 DSH 会热重载。

## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `roots` | `['~/.agents/agents']` | 扫描 `*.md` 的目录，按顺序 |
| `defaultTools` | `[]` | 已不用于继承判定；省略 `tools` 一律继承 |
| `watchIntervalMs` | `2000` | 轮询间隔；`0` 关闭（重启才生效） |
| `order` | `100` | 首个定义的 roster 位置，后续文件递增 |
| `includeSkillLoader` | `true` | 是否为声明了 `skills` 的定义挂加载器 |
| `expose` | `{ }` | 挂一个委派工具，枚举即当前定义集合；`false` 关闭 |
| `expose.toolName` | `subagent_defined` | 工具名 |
| `expose.provider` | `spawn` | 委派后端（`ctx.subagents` 的 provider 名） |
| `expose.defaultProvider` | 同 `expose.provider` | 定义写裸模型 id 时假定的 **LLM provider**（如 `magpie`） |
| `expose.model` | — | 工具实例级兜底模型，三层优先级最低 |
| `expose.reasoningEffort` | — | 工具实例级兜底推理强度 |
| `expose.maxDepth` | — | 子代理递归深度上限 |
| `hideOfficialTools` | `{ stripPrompt: true }` | 我们的工具在服务时隐藏官方委派工具；`false` 关闭 |
| `hideOfficialTools.names` | `['subagent', 'subagent_fork']` | 要隐藏的工具名 |
| `hideOfficialTools.stripPrompt` | `true` | 同时删除提示词里提到它们的句子 |

注意 `expose.provider` 是**子代理后端**（`spawn`/`fork`），`expose.defaultProvider` 是 **LLM 路由 provider**（`magpie`/`openai`）。两者不是一回事。

## 隐藏官方委派工具

`hideOfficialTools` 默认开启。生效条件只有一个：**我们的委派工具真的挂载成功了**。

| 场景 | 官方 `subagent` | 我们的工具 |
|---|---|---|
| 定义目录有文件，工具挂载成功 | 隐藏 | 可见 |
| 定义目录为空 / 挂载失败 / `expose: false` | **保持可见** | 不可见 |

实现分两层：

1. `system-prompt/assemble` 从 `assembly.tools` 里滤掉这些 schema，并删除提示词中提到它们的句子（包括 PTC `tools:sdk` 的整块声明）。模型从未见过它们，日志里也不会出现 tool-addition/removal。
2. `tools.guard()` 兜底拒绝：覆盖 PTC 程序从 `registry.schemas()` 绑名、以及旧会话持有旧 schema 的残留路径。拒绝文本指向 `subagent_defined`。

被拒绝时模型看到：

```
`subagent` / `subagent_fork` is disabled in this profile. Delegate with `subagent_defined` instead:
it selects an agent definition, which fixes the child's tools, persona, and default model.
Supply `agent_preset`; add `provider` and `model` only to override the definition's model.
```

### 与其它隐藏插件的叠加

如果你另外装了 `@local/dsh-deny-subagent` 之类的插件，两者会同时生效——功能正常，但**拒绝文本可能指向别的替代工具**（那个插件写的是 `spawn_teammate`）。同时挂着时，模型被拒绝后看到的建议以先触发的 guard 为准。要么保留本插件的隐藏、退役其它插件，要么反过来；不建议两套并存而不检查拒绝文本。

## 主代理怎么挑

`expose` 会挂一个 `subagent_defined` 工具，参数 `agent_preset` 的枚举就是当前所有定义的 id，参数说明里带上每个定义的 `description` 与默认模型：

```
Which agent definition runs this child. Available definitions:
read-only-reviewer: Reviews a change against its stated intent without modifying the workspace.;
type-design-analyzer: Analyze type design for encapsulation... (default model magpie/workbuddy-ai/deepseek-v4.1-flash).
A definition with a default model uses it unless you pass `provider` and `model`;
a definition without one inherits your route.
```

定义集合或默认模型变化（增删文件、改 `model`）时才重挂工具；只改正文不会打扰任何已运行会话。

## 模型体验

### `subagent_defined` 工具

#### 模型看到的内容

固定 schema，加一个随定义集合变化的 `agent_preset` 枚举。`prompt` 与 `description` 必填；`provider`/`model`/`reasoning_effort` 可选，仅在要覆盖定义默认时使用。参数文本由上面的 `describe()` 生成，列出每个定义的描述和默认模型。

#### Token 影响

每次父级请求支付一个固定 schema；参数说明随定义数量线性增长（每个定义一行）。定义很多时可缩短 `description` 来控制。

#### KV Cache 影响

枚举与说明只在定义集合或默认模型变化时改变，其余时间前缀稳定。改定义正文不改变 schema。

## 行为细节

- 编译失败的文件**保留上一次成功的注册**，并记一条 warn——半保存的编辑不会让运行中的团队突然失去定义。
- 删除文件会退役对应 preset；已有会话保留它启动时的组合（preset 代际按 Agent 保留）。
- 同一文件内改 `name` 会先退役旧 id 再注册新 id，不会留下两个。
- 顺序按文件路径排序，与 roster `order` 一致，重启后位置不变。
- 模型路由在创建子代理**之前**通过 `ctx.llm.resolveCallConfig` 预检，未知模型让工具调用直接失败，而不是启动一个注定失败的子代理。
- 显式换路由但没给 `reasoning_effort` 时，会丢弃文件里为旧模型设的强度，让新模型用自己默认值（与 shipped 工具一致）。

## 验证

```sh
node test/self-check.mjs
```

46 项检查：frontmatter 解析、组映射、校验失败、真实 `agent-preset-registry` 挂载、编辑重注册、删除退役、编译失败保留、模型三层优先级、`DefinitionRoutes` 描述文本、委派工具的实际请求构造、隐藏的开关门控与提示词去提及、无 inject 声明时的注册路径、以及本机 `~/.agents/agents` 里已有定义的加载。

## 排查

插件把加载过程写进 `~/.dsh/agent-defs.trace.log`。工具没出现时，先看这个文件：

| trace 里有 | 含义 |
|---|---|
| 没有 `apply` 行 | 插件没被加载：检查 profile 里的 `file://` 路径 |
| `probe ... FAILED <code>` | 定义目录读不到 |
| `compile <path>: <原因>` | 定义文件格式错误，原因会写全 |
| `register <id>: <原因>` | preset 挂载失败 |
| `expose serving=true` | 工具已挂载 |
| 完全没有新行 | 进程没重启，旧模块还在缓存里 |

一个已修复的真实故障作为参考：`ctx.agentPresets` 是**受保护的属性读**，服务未声明为 inject 依赖时会直接抛错；这个错误被逐文件的 catch 吞进 logger，表现为"插件加载成功、官方工具被隐藏、但什么都没注册"。注册路径必须用 `ctx.get('agentPresets')`，因为它不检查 inject 声明。`test/self-check.mjs` 里有一条回归测试锁住这个行为。

## 已知限制

- 定义不能挂 `workflow`/`lsp`/PTY 终端等需要部署配置的能力。
- 插件代码在 Host 进程内执行；只加载你自己写的定义目录。
- 枚举是工具 schema 的一部分：新增定义文件后，**已经进入对话**的会话要下一轮请求才看到新的枚举值；新会话立即可见。
- `model` 只影响子代理的 LLM 路由，不改变 preset 里挂的插件组合；同一个定义的子代理共享一套工具。
- 换模型不做降级：定义写了一个本机没配置的模型，工具调用会报错（预检失败），不会静默回退到主代理路由。
