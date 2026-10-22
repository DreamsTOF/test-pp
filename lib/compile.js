/**
 * Agent definition files → Agent Preset declarations.
 *
 * Pure functions only: parse one Markdown file into a definition, and compile
 * that definition into the Cordis plugin rows an `@deepseek-ai/dsh-agent-preset`
 * declaration carries. Nothing here touches the filesystem, Cordis, or the model.
 *
 * The mapping is deliberately narrow. A definition says which tool GROUPS it may
 * use; a group is one plugin package (the row that registers those tools), never
 * an individual tool name, because a preset cannot subtract from what it mounts —
 * `tools.restrict()` filters only inherited names and rejects its own. Skills work
 * the same way: they are selected by directory, since the skill loader has no
 * name allow-list.
 *
 * @module @local/dsh-agent-defs/compile
 */

/** Frontmatter keys this loader understands; every other key fails loud. */
export const KNOWN_KEYS = [
  'name',
  'description',
  'tools',
  'skills',
  'model',
  'when-to-use',
  'persona-prefix',
  'communication',
]

/**
 * What every delegated child needs to know about talking to its parent.
 *
 * The shipped runtime note explains only that the child's permission scope is
 * fixed; it never says the child can message back, and a child that does not
 * know is a child that can only answer once at the end. This text is the
 * closing paragraph of the child's persona, so it is present from its first
 * request without depending on what the definition body says.
 */
export const COMMUNICATION_NOTE = [
  '## Reporting back',
  '',
  'You can talk to the agent that delegated this task, and it can steer you.',
  '',
  '- `send_message` with `agent_id` set to your delegating agent: send a short progress note, ask a question,',
  '  or report a blocker while you are still working. A working parent receives it at its next step.',
  '- Messages from your parent arrive as ordinary turns. Apply them to the work in progress instead of restarting.',
  '- Prefer one message when you have something the parent must act on, not after every step.',
  '- Your final answer still ends the turn; `send_message` is for what cannot wait until then.',
].join('\n')

/**
 * One selectable tool group. `tools` is what the group's package registers, and
 * the model reads it only in diagnostics; `plugins` is what a preset mounts.
 * @typedef {object} ToolGroup
 * @property {string} label - stable group name used in definition files.
 * @property {readonly string[]} tools - model-visible tool names this group registers.
 * @property {readonly object[]} plugins - preset rows that mount the group.
 */

/** @type {readonly ToolGroup[]} */
export const TOOL_GROUPS = [
  {
    label: 'fs',
    tools: ['read', 'write', 'edit', 'read_image'],
    plugins: [{ name: '@deepseek-ai/dsh-tool-fs' }],
  },
  {
    label: 'search',
    tools: ['glob', 'grep'],
    plugins: [{ name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } }],
  },
  {
    label: 'shell',
    tools: ['bash', 'pwsh'],
    plugins: [
      { name: '@deepseek-ai/dsh-tool-bash', disabled: { __jsExpr: "process.platform === 'win32'" } },
      { name: '@deepseek-ai/dsh-tool-pwsh', disabled: { __jsExpr: "process.platform !== 'win32'" } },
    ],
  },
  {
    label: 'jobs',
    tools: ['job_list', 'job_output', 'job_kill'],
    plugins: [{ name: '@deepseek-ai/dsh-tool-jobs' }],
  },
  {
    label: 'web',
    tools: ['web_search', 'web_fetch'],
    plugins: [{ name: '@deepseek-ai/dsh-tool-web' }],
  },
  {
    label: 'todo',
    tools: ['todo_write'],
    plugins: [{ name: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: true } }],
  },
  {
    label: 'ask',
    tools: ['ask_user_question'],
    plugins: [{ name: '@deepseek-ai/dsh-tool-ask-user' }],
  },
  {
    label: 'present',
    tools: ['present'],
    plugins: [{ name: '@deepseek-ai/dsh-tool-present' }],
  },
  {
    label: 'goal',
    tools: ['create_goal', 'get_goal', 'update_goal'],
    plugins: [{ name: '@deepseek-ai/dsh-tool-goal' }],
  },
  {
    label: 'schedule',
    tools: ['schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete'],
    plugins: [{ name: '@deepseek-ai/dsh-tool-schedule' }],
  },
  {
    label: 'mcp',
    tools: ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'],
    plugins: [{ name: '@deepseek-ai/dsh-mcp-resources' }],
  },
  {
    label: 'delegate',
    tools: ['subagent', 'subagent_fork', 'send_message', 'interrupt_agent', 'list_agents'],
    plugins: [
      { name: '@deepseek-ai/dsh-tool-subagent-control' },
      { name: '@deepseek-ai/dsh-tool-subagent-control/list-agents' },
      { name: '@deepseek-ai/dsh-tool-subagent', config: { provider: 'spawn', toolName: 'subagent' } },
    ],
  },
]

/** Tool name → group label, so a definition may name tools instead of groups. */
const TOOL_TO_GROUP = new Map()
for (const group of TOOL_GROUPS) for (const tool of group.tools) TOOL_TO_GROUP.set(tool, group.label)

/** Canonical group labels, for diagnostics and `tools: ['*']`. */
export const GROUP_LABELS = TOOL_GROUPS.map(group => group.label)

/**
 * Tool names a definition may not select by name: each needs deployment
 * configuration (a provider name, a model route, a backend row) that a
 * frontmatter list cannot supply.
 */
const UNSUPPORTED_TOOLS = new Map([
  ['workflow', 'workflow fan-out needs a configured engine; mount @deepseek-ai/dsh-tool-workflow in a preset bundle instead'],
  ['run_code', 'run_code is the reserved PTC presentation transport, selected per composition rather than per tool list'],
  ['lsp', 'lsp needs a language-server provider row that a definition cannot choose'],
  ['terminal_open', 'persistent terminals need a PTY backend row that a definition cannot choose'],
])

/**
 * Split one Markdown file into frontmatter data and body.
 * @param {string} source - the whole file.
 * @returns {{ data: Record<string, unknown>, body: string }} parsed parts; a file without frontmatter has empty data.
 */
export function splitFrontmatter(source) {
  const text = source.replace(/^\uFEFF/u, '')
  if (!text.startsWith('---')) return { data: {}, body: text.trim() }
  const firstBreak = text.indexOf('\n')
  if (firstBreak < 0) throw new Error('frontmatter starts with "---" but never closes')
  const end = text.indexOf('\n---', firstBreak)
  if (end < 0) throw new Error('frontmatter starts with "---" but never closes')
  const raw = text.slice(firstBreak + 1, end)
  const afterFence = text.indexOf('\n', end + 1)
  const body = afterFence < 0 ? '' : text.slice(afterFence + 1).trim()
  return { data: parseFrontmatter(raw), body }
}

/**
 * Parse the frontmatter subset this loader accepts: `key: scalar`, block lists,
 * inline lists, and block scalars. A YAML dependency is avoided on purpose — this
 * module is loaded into the Host process, and the accepted subset is small enough
 * to validate exactly rather than to guess at.
 * @param {string} raw - frontmatter text, without the `---` fences.
 * @returns {Record<string, unknown>} parsed keys in file order.
 */
export function parseFrontmatter(raw) {
  /** @type {Record<string, unknown>} */
  const data = {}
  const lines = raw.split('\n')
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    index += 1
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    if (/^[ \t]/u.test(line)) {
      throw new Error(`frontmatter line ${String(index)} is indented without an owning key: ${JSON.stringify(line)}`)
    }
    const match = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/u.exec(line)
    if (match === null) throw new Error(`frontmatter line ${String(index)} is not "key: value": ${JSON.stringify(line)}`)
    const [, key, rest] = match
    if (Object.hasOwn(data, key)) throw new Error(`frontmatter key "${key}" appears twice`)
    const collected = []
    while (index < lines.length && (lines[index].trim() === '' || /^[ \t]/u.test(lines[index]))) {
      collected.push(lines[index])
      index += 1
    }
    data[key] = parseValue(rest, collected)
  }
  return data
}

/**
 * Interpret one key's inline text plus its indented continuation.
 * @param {string} rest - text after `key:` on the same line.
 * @param {string[]} collected - indented (or blank) following lines.
 * @returns {unknown} a string, a string list, or a block scalar.
 */
function parseValue(rest, collected) {
  const inline = rest.trim()
  if (inline === '') {
    const items = collected.map(line => line.trim()).filter(line => line !== '' && !line.startsWith('#'))
    if (items.length === 0) return ''
    if (items.every(item => item.startsWith('- '))) return items.map(item => unquote(item.slice(2).trim()))
    return items.map(line => line.replace(/^[ \t]+/u, '')).join('\n')
  }
  if (inline === '|' || inline === '|-' || inline === '>' || inline === '>-') {
    const body = collected.map(line => line.replace(/^[ \t]{0,2}/u, '')).join('\n').trim()
    return inline.startsWith('>') ? body.replace(/\n+/gu, ' ') : body
  }
  if (inline.startsWith('[') && inline.endsWith(']')) {
    const inner = inline.slice(1, -1).trim()
    if (inner === '') return []
    return inner.split(',').map(item => unquote(item.trim())).filter(item => item !== '')
  }
  return unquote(inline)
}

/**
 * Strip one layer of matching quotes and decode the escapes used inside them.
 * @param {string} value - raw scalar text.
 * @returns {string} the scalar.
 */
function unquote(value) {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(["\\nt])/gu, (_whole, character) =>
      character === 'n' ? '\n' : character === 't' ? '\t' : character)
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'")
  }
  return value
}

/**
 * Turn one parsed definition into a compiled preset declaration.
 *
 * `name` is the only required field: it is both the preset id the parent model
 * selects and the label a reviewer reads. `description` is required too, because
 * it is the entire text the parent model uses to choose between definitions.
 * @param {object} input - parsed definition.
 * @param {string} input.fallbackId - id derived from the file name.
 * @param {string} input.path - absolute file path, for diagnostics.
 * @param {Record<string, unknown>} input.data - parsed frontmatter.
 * @param {string} input.body - Markdown body used as the persona.
 * @param {readonly string[]} [input.defaultTools] - groups used when the file omits `tools`.
 * @param {boolean} [input.includeSkillLoader] - whether this deployment wants the skill loader rows.
 * @returns {{ id: string, description: string, groups: string[], plugins: object[], body: string, skills: string[], model?: string, whenToUse?: string }}
 *   the compiled definition; `plugins` is ready for `agentPresets.register`.
 */
export function compileDefinition(input) {
  const { fallbackId, path, data, body } = input
  for (const key of Object.keys(data)) {
    if (!KNOWN_KEYS.includes(key)) {
      throw new Error(`${path}: unsupported frontmatter key "${key}"; known keys are ${KNOWN_KEYS.join(', ')}`)
    }
  }
  const declaredName = typeof data.name === 'string' ? data.name.trim() : ''
  const id = declaredName === '' ? fallbackId : declaredName
  assertId(id, path)
  const description = typeof data.description === 'string' ? data.description.trim() : ''
  if (description === '') {
    throw new Error(`${path}: "description" is required — the parent model reads it to choose a definition`)
  }

  const groups = resolveGroups(data.tools, path, input.defaultTools)
  const skills = asStringList(data.skills, path, 'skills')
  const model = typeof data.model === 'string' && data.model !== '' ? data.model : undefined
  const whenToUse = typeof data['when-to-use'] === 'string' && data['when-to-use'] !== '' ? data['when-to-use'] : undefined

  // Inherit mode is the default and the point of this format: a definition that
  // names no tools, skills, or model describes WHO the child is, and the child
  // gets the parent's whole composition — every tool, every skill, the same
  // model. That is what an authored agent file usually means, and it needs no
  // separate preset: the child joins the parent's generation and only its
  // persona is replaced.
  //
  // Naming any of those three opts into an INDEPENDENT composition, which is a
  // different child: it no longer sees the parent's tools.
  const independent = data.tools !== undefined || skills.length > 0 || model !== undefined
  const communicate = data.communication !== false
  const prefix = (typeof data['persona-prefix'] === 'string' && data['persona-prefix'] !== '' ? `${data['persona-prefix']}\n\n` : '') + body
  const persona = prefix.trim() === ''
    ? ''
    : `${prefix.trim()}${communicate ? `\n\n${COMMUNICATION_NOTE}` : ''}`

  if (!independent) {
    // No preset at all: `plugins` stays empty and the delegation layer composes
    // the child from the parent plus this persona.
    return {
      id,
      description,
      groups: [],
      plugins: [],
      body,
      skills: [],
      persona,
      inherit: true,
      communicate,
      ...whenToUse === undefined ? {} : { whenToUse },
    }
  }

  const plugins = []
  if (persona !== '') plugins.push({ name: '@deepseek-ai/dsh-persona', config: { prefix: persona } })
  for (const group of TOOL_GROUPS) {
    if (!groups.includes(group.label)) continue
    for (const plugin of group.plugins) plugins.push(cloneRow(plugin))
  }
  if (communicate && !groups.includes('delegate')) {
    // `send_message` only; the full `delegate` group would also hand this child
    // the power to start children of its own, which a definition did not ask for.
    plugins.push({ name: '@deepseek-ai/dsh-tool-subagent-control' })
  }
  if (skills.length > 0 && input.includeSkillLoader !== false) {
    plugins.push({
      name: '@deepseek-ai/dsh-skill-filesystem',
      config: { includeDefaultRoots: false, customSkillDirs: [...skills] },
    })
    plugins.push({ name: '@deepseek-ai/dsh-tool-skill' })
  }
  return {
    id,
    description,
    groups,
    plugins,
    body,
    skills,
    persona,
    inherit: false,
    communicate,
    ...model === undefined ? {} : { model },
    ...whenToUse === undefined ? {} : { whenToUse },
  }
}

/**
 * Resolve `tools:` into group labels, accepting either labels or tool names so a
 * definition may say `tools: [read, grep]` or `tools: [fs, search]`.
 * @param {unknown} value - the frontmatter value.
 * @param {string} path - source file, for diagnostics.
 * @param {readonly string[] | undefined} defaults - groups used when the key is absent.
 * @returns {string[]} resolved group labels, in declaration order.
 */
function resolveGroups(value, path, defaults) {
  // `undefined` means "the file said nothing", which is the inherit signal, not
  // a request for defaults. Only an explicit `tools: []` asks for no tools.
  if (value === undefined) return []
  const wanted = asStringList(value, path, 'tools')
  if (wanted.includes('*')) return GROUP_LABELS.slice()
  const groups = []
  for (const item of wanted) {
    if (GROUP_LABELS.includes(item)) {
      if (!groups.includes(item)) groups.push(item)
      continue
    }
    const group = TOOL_TO_GROUP.get(item)
    if (group !== undefined) {
      if (!groups.includes(group)) groups.push(group)
      continue
    }
    const unsupported = UNSUPPORTED_TOOLS.get(item)
    if (unsupported !== undefined) throw new Error(`${path}: tool "${item}" is not selectable by name — ${unsupported}`)
    throw new Error(`${path}: unknown tool or group "${item}"; groups: ${GROUP_LABELS.join(', ')}; tools: ${[...TOOL_TO_GROUP.keys()].join(', ')}`)
  }
  return groups
}

/**
 * Normalize a frontmatter list value.
 * @param {unknown} value - list, comma string, or absent.
 * @param {string} path - source file, for diagnostics.
 * @param {string} key - key name, for diagnostics.
 * @returns {string[]} the entries.
 */
function asStringList(value, path, key) {
  if (value === undefined || value === '') return []
  if (typeof value === 'string') return value.split(',').map(item => item.trim()).filter(item => item !== '')
  if (Array.isArray(value) && value.every(item => typeof item === 'string')) {
    return value.map(item => item.trim()).filter(item => item !== '')
  }
  throw new Error(`${path}: "${key}" must be a list of strings`)
}

/**
 * Reject ids the preset registry and the model-facing enum cannot carry.
 * @param {string} id - candidate id.
 * @param {string} path - source file, for diagnostics.
 */
function assertId(id, path) {
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(id)) {
    throw new Error(`${path}: name "${id}" must be lowercase letters, digits and hyphens`)
  }
}

/**
 * Copy a tool-group row so one definition mutating it cannot affect another.
 * @param {object} row - group row.
 * @returns {object} a detached row.
 */
function cloneRow(row) {
  return JSON.parse(JSON.stringify(row))
}
