// Runnable check for dsh-agent-defs.
//
// Part 1 exercises the pure compiler (frontmatter subset, tool-group mapping,
// validation) with no Cordis dependency, so it runs anywhere.
//
// Part 2 drives the REAL installed @deepseek-ai/dsh-agent-preset-registry
// (0.2.1-rc.2, the running installation) to prove that each compiled definition
// actually mounts as a preset and appears in the roster the parent model selects
// from — including the edit and delete paths, which are the whole point of
// scanning files instead of declaring presets by hand.
//
//   node dsh-agent-defs/test/self-check.mjs
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const HERE = pathToFileURL(import.meta.dirname).href
const { splitFrontmatter, compileDefinition, TOOL_GROUPS, GROUP_LABELS } = await import(`${HERE}/../lib/compile.js`)
const { apply: applyAgentDefs, createLoader } = await import(`${HERE}/../lib/index.js`)

let passed = 0
const check = (label, fn) => {
  fn()
  passed += 1
  console.log(`  ok  ${label}`)
}
const checkAsync = async (label, fn) => {
  await fn()
  passed += 1
  console.log(`  ok  ${label}`)
}

console.log('# compile: frontmatter subset')

check('parses block lists, inline lists and block scalars', () => {
  const source = [
    '---',
    'name: type-design-analyzer',
    'description: Analyze type design.',
    'tools:',
    '  - fs',
    '  - search',
    'skills: [a, b]',
    'persona-prefix: |',
    '  Line one.',
    '  Line two.',
    '---',
    '',
    '# Body',
    '',
    'Prompt body.',
  ].join('\n')
  const { data, body } = splitFrontmatter(source)
  assert.equal(data.name, 'type-design-analyzer')
  assert.deepEqual(data.tools, ['fs', 'search'])
  assert.deepEqual(data.skills, ['a', 'b'])
  assert.equal(data['persona-prefix'], 'Line one.\nLine two.')
  assert.equal(body, '# Body\n\nPrompt body.')
})

check('a file with no frontmatter yields an empty data object', () => {
  const { data, body } = splitFrontmatter('Just a body.\n')
  assert.deepEqual(data, {})
  assert.equal(body, 'Just a body.')
})

check('rejects an unclosed frontmatter block and a duplicate key', () => {
  assert.throws(() => splitFrontmatter('---\nname: x\n'), /never closes/u)
  assert.throws(() => splitFrontmatter('---\nname: x\nname: y\n---\n'), /appears twice/u)
})

console.log('# compile: definitions')

const BASE = {
  fallbackId: 'from-file',
  path: '/defs/x.md',
  data: { name: 'reviewer', description: 'Reviews code.', tools: ['fs', 'search'] },
  body: 'You review code.',
}

check('maps groups to plugin rows and the body to a persona', () => {
  const compiled = compileDefinition(BASE)
  assert.equal(compiled.id, 'reviewer')
  assert.deepEqual(compiled.groups, ['fs', 'search'])
  const names = compiled.plugins.map(plugin => plugin.name)
  assert.ok(names.includes('@deepseek-ai/dsh-persona'), 'persona row present')
  assert.ok(names.includes('@deepseek-ai/dsh-tool-fs'), 'fs row present')
  assert.ok(names.includes('@deepseek-ai/dsh-tool-fs-search'), 'search row present')
  assert.ok(!names.includes('@deepseek-ai/dsh-tool-bash'), 'shell row absent')
  assert.ok(compiled.plugins[0].config.prefix.startsWith('You review code.'), 'the body is the opening of the persona')

check('every definition gets send_message and is told it can report back', () => {
  // A child that cannot message its parent can only answer once, at the end of
  // its turn, so the parent cannot ask it anything while it works. The
  // communication rows are therefore not optional and not part of `tools:`.
  const compiled = compileDefinition(BASE)
  const names = compiled.plugins.map(plugin => plugin.name)
  assert.ok(names.includes('@deepseek-ai/dsh-tool-subagent-control'), 'send_message is mounted by default')
  const prefix = compiled.plugins[0].config.prefix
  assert.match(prefix, /## Reporting back/u)
  assert.match(prefix, /`send_message`/u, 'the child is told the tool by name')
  assert.match(prefix, /steer/u, 'the child knows the parent can steer it')

  // A definition that already asked for the whole delegate group is not doubled.
  const delegator = compileDefinition({ ...BASE, data: { ...BASE.data, tools: ['delegate'] } })
  const mounts = delegator.plugins.filter(plugin => plugin.name === '@deepseek-ai/dsh-tool-subagent-control')
  assert.equal(mounts.length, 1, 'one control row, from the group alone')
})

check('communication: false keeps the definition silent but still valid', () => {
  const compiled = compileDefinition({ ...BASE, data: { ...BASE.data, communication: false } })
  const names = compiled.plugins.map(plugin => plugin.name)
  assert.ok(!names.includes('@deepseek-ai/dsh-tool-subagent-control'), 'no send_message')
  assert.ok(!compiled.plugins[0].config.prefix.includes('## Reporting back'), 'no note either')
})
})

check('accepts individual tool names and folds them into their group', () => {
  const compiled = compileDefinition({ ...BASE, data: { ...BASE.data, tools: ['read', 'grep'] } })
  assert.deepEqual(compiled.groups, ['fs', 'search'])
})

check('tools: ["*"] selects every group', () => {
  const compiled = compileDefinition({ ...BASE, data: { ...BASE.data, tools: ['*'] } })
  assert.deepEqual(compiled.groups, GROUP_LABELS)
})

check('a definition naming no tools, skills, or model INHERITS the parent', () => {
  // The authored agent files this loader exists for carry only `name` and
  // `description`; everything else comes from the parent. Registering a preset
  // for such a file would give the child its own composition and silently drop
  // every parent tool, so inherit mode must produce no plugins at all.
  const compiled = compileDefinition({ ...BASE, data: { name: 'tdd-guide', description: 'TDD specialist.' } })
  assert.equal(compiled.inherit, true)
  assert.deepEqual(compiled.plugins, [], 'no preset plugins: the child joins the parent')
  assert.deepEqual(compiled.groups, [])
  assert.match(compiled.persona, /^You review code\./u, 'the body still becomes the persona')
  assert.match(compiled.persona, /## Reporting back/u, 'and still learns it can report back')

  // Explicit defaults do not silently turn an inherit-mode file into a preset.
  const withDefaults = compileDefinition({ ...BASE, data: { name: 'x', description: 'd' }, defaultTools: ['fs'] })
  assert.equal(withDefaults.inherit, true)
})

check('naming tools, skills, or a model opts into an independent composition', () => {
  const byTool = compileDefinition({ ...BASE, data: { name: 'x', description: 'd', tools: ['search'] } })
  assert.equal(byTool.inherit, false)
  assert.deepEqual(byTool.groups, ['search'])

  const bySkill = compileDefinition({ ...BASE, data: { name: 'x', description: 'd', skills: ['/s'] } })
  assert.equal(bySkill.inherit, false)

  const byModel = compileDefinition({ ...BASE, data: { name: 'x', description: 'd', model: 'p/m' } })
  assert.equal(byModel.inherit, false)

  // An explicit empty list is a request for "no tools", not inherit mode.
  const none = compileDefinition({ ...BASE, data: { name: 'x', description: 'd', tools: [] } })
  assert.equal(none.inherit, false)
  assert.deepEqual(none.groups, [])
})

check('names the skill loader only for definitions that declare skills', () => {
  const withSkills = compileDefinition({ ...BASE, data: { ...BASE.data, skills: ['/abs/skills'] } })
  const names = withSkills.plugins.map(plugin => plugin.name)
  assert.ok(names.includes('@deepseek-ai/dsh-skill-filesystem'), 'skill provider row present')
  assert.ok(names.includes('@deepseek-ai/dsh-tool-skill'), 'skill loader row present')
  const filesystem = withSkills.plugins.find(plugin => plugin.name === '@deepseek-ai/dsh-skill-filesystem')
  assert.deepEqual(filesystem.config.customSkillDirs, ['/abs/skills'])
  assert.equal(filesystem.config.includeDefaultRoots, false, 'default roots stay out of a child preset')

  const withoutSkills = compileDefinition(BASE)
  assert.ok(!withoutSkills.plugins.some(plugin => plugin.name.includes('skill')), 'no skill rows without skills')
})

check('falls back to the file name when name is omitted', () => {
  const compiled = compileDefinition({ ...BASE, data: { description: 'd' } })
  assert.equal(compiled.id, 'from-file')
})

check('fails loud on a missing description, an unknown key, a bad id and an unknown tool', () => {
  assert.throws(() => compileDefinition({ ...BASE, data: { name: 'x' } }), /"description" is required/u)
  assert.throws(() => compileDefinition({ ...BASE, data: { ...BASE.data, bogus: '1' } }), /unsupported frontmatter key/u)
  assert.throws(() => compileDefinition({ ...BASE, data: { ...BASE.data, name: 'Bad ID' } }), /lowercase letters/u)
  assert.throws(() => compileDefinition({ ...BASE, data: { ...BASE.data, tools: ['nope'] } }), /unknown tool or group/u)
  assert.throws(() => compileDefinition({ ...BASE, data: { ...BASE.data, tools: ['lsp'] } }), /not selectable by name/u)
})

console.log('# compile: the shell group is platform-gated')

check('the shell group carries platform conditions instead of a tool-name test', () => {
  const shell = TOOL_GROUPS.find(group => group.label === 'shell')
  const bash = shell.plugins.find(plugin => plugin.name === '@deepseek-ai/dsh-tool-bash')
  const pwsh = shell.plugins.find(plugin => plugin.name === '@deepseek-ai/dsh-tool-pwsh')
  assert.equal(bash.disabled.__jsExpr, "process.platform === 'win32'")
  assert.equal(pwsh.disabled.__jsExpr, "process.platform !== 'win32'")
})

// --- Part 2: the real registry ----------------------------------------------

const INSTALL = String.raw`C:\Users\dream\AppData\Local\nvm\v24.18.0\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai`
const fromInstall = (packagePath) => import(pathToFileURL(join(INSTALL, packagePath)).href)

let Context
try {
  ({ Context } = await import(`${pathToFileURL(join(INSTALL, 'cordis', 'lib', 'index.js')).href}`))
} catch (error) {
  console.log(`\n# registry: SKIPPED (installed dsh not found: ${error.code ?? error.message})`)
  console.log(`\n${String(passed)} checks passed`)
  process.exit(0)
}

console.log('\n# registry: compiled definitions mount and reach the roster')

const { default: Loader } = await fromInstall('cordis-plugin-loader/lib/index.js')
const { default: Group } = await fromInstall('cordis-plugin-group/lib/index.js')
const { default: SessionStore } = await fromInstall('dsh-session/lib/index.js')
const { default: SessionProjectionRegistry } = await fromInstall('dsh-session-projection/lib/index.js')
const { default: SystemPrompt } = await fromInstall('dsh-system-prompt/lib/index.js')
const { default: ToolRuntime } = await fromInstall('dsh-tools/lib/index.js')
const { default: AgentRegistry } = await fromInstall('dsh-agent/lib/index.js')
const { default: AgentLoop } = await fromInstall('dsh-agent-loop/lib/index.js')
const { default: AgentPresets } = await fromInstall('dsh-agent-preset-registry/lib/index.js')
// Services the tool rows in a compiled preset inject. Without them a preset row
// stays "never started" instead of failing, which would make this check pass for
// the wrong reason. The `-local` packages ARE the providers: each registers the
// service itself, so mounting the base package too would double-register.
const { default: WorkingDirectory } = await fromInstall('dsh-working-directory/lib/index.js')
const { default: FsLocal } = await fromInstall('dsh-fs-local/lib/index.js')
const { default: SubprocessLocal } = await fromInstall('dsh-subprocess-local/lib/index.js')
const { default: SkillRegistry } = await fromInstall('dsh-skill/lib/index.js')
const ShellEnv = await fromInstall('dsh-shell-env/lib/index.js')
const { default: PwshLocal } = await fromInstall('dsh-pwsh-local/lib/index.js')

const tempRoot = mkdtempSync(join(tmpdir(), 'agent-defs-'))
const skillsDir = join(tempRoot, 'skills')
mkdirSync(skillsDir, { recursive: true })
const writeAgent = (file, frontmatter, body) => {
  const path = join(tempRoot, file)
  writeFileSync(path, `---\n${frontmatter}\n---\n\n${body}\n`, 'utf8')
  return path
}
writeAgent(
  'type-design-analyzer.md',
  [
    'name: type-design-analyzer',
    'description: Analyze type design for encapsulation, invariant expression, usefulness, and enforcement.',
    'tools:',
    '  - fs',
    '  - search',
  ].join('\n'),
  '# Type Design Analyzer Agent\n\nYou evaluate whether types make illegal states harder to represent.',
)
writeAgent(
  'reviewer.md',
  [
    'description: Reviews changes with the shell and search only.',
    'tools: [search, shell]',
    `skills: ['${skillsDir.replaceAll('\\', '/')}']`,
  ].join('\n'),
  'You review software changes.',
)

const ctx = new Context()
// Preset rows resolve bare package names against this base, exactly as the
// launcher's install anchor does. The trailing slash matters: without it Node
// resolves relative to the parent directory and every row fails to import.
ctx.baseUrl = `${pathToFileURL(join(INSTALL, '..', '..')).href}/`
await ctx.plugin(Loader)
ctx.loader.builtins.group = Group
await ctx.plugin(SessionStore)
await ctx.plugin(SessionProjectionRegistry)
await ctx.plugin(SystemPrompt, { personaPrefix: '' })
await ctx.plugin(ToolRuntime)
await ctx.plugin(AgentRegistry)
await ctx.plugin(AgentLoop, { agents: [] })
await ctx.plugin(WorkingDirectory)
await ctx.plugin(FsLocal)
await ctx.plugin(SubprocessLocal)
await ctx.plugin(SkillRegistry)
await ctx.plugin(ShellEnv)
await ctx.plugin(PwshLocal)
// Every compiled definition now carries `dsh-tool-subagent-control` (the
// `send_message` half of two-way communication), which injects `subagents`.
// The real deployment always has both; the harness must too, or every preset
// reports "waiting for subagents" and the mount assertions mean nothing.
const { default: SubagentRuntimeService } = await fromInstall('dsh-subagent/lib/index.js')
const SpawnProvider = await fromInstall('dsh-subagent-spawn-in-process/lib/index.js')
await ctx.plugin(SubagentRuntimeService)
await ctx.plugin(SpawnProvider, { providerName: 'spawn' })
await ctx.plugin(AgentPresets, { default: 'type-design-analyzer' })

const loader = createLoader(ctx, { roots: [tempRoot], watchIntervalMs: 0 })
await loader.reconcile()

await checkAsync('registers one preset per definition file', async () => {
  const rows = await ctx.agentPresets.list()
  assert.deepEqual(rows.map(row => row.id).sort(), ['reviewer', 'type-design-analyzer'])
  const analyzer = rows.find(row => row.id === 'type-design-analyzer')
  assert.equal(analyzer.description, 'Analyze type design for encapsulation, invariant expression, usefulness, and enforcement.')
  assert.equal(analyzer.broken, undefined, `type-design-analyzer should mount cleanly: ${analyzer.broken ?? ''}`)
  const reviewer = rows.find(row => row.id === 'reviewer')
  assert.equal(reviewer.broken, undefined, `reviewer should mount cleanly: ${reviewer.broken ?? ''}`)
})

await checkAsync('registers from a context that does NOT declare agentPresets as a dependency', async () => {
  // Regression lock: `ctx.agentPresets` is a guarded property read that THROWS
  // when the service is not a declared dependency, and the thrown message is
  // swallowed by the loader's per-file catch — the plugin loads, hides the
  // shipped tools, and silently registers nothing. `ctx.get()` must be used.
  //
  // The plugin declares `inject = []` on purpose so a deployment without a
  // registry keeps its delegation tool, which makes this the normal path.
  const { default: BareSystemPrompt } = await fromInstall('dsh-system-prompt/lib/index.js')
  const bare = new Context()
  await bare.plugin(BareSystemPrompt, { personaPrefix: '' })
  // Provide the registry WITHOUT making it an injected dependency of the caller.
  const seen = []
  bare.provide('agentPresets', {
    async register(definition) {
      seen.push(definition.id)
      return async () => {}
    },
    async list() { return [] },
  })

  const validRoot = join(tempRoot, 'valid')
  mkdirSync(validRoot, { recursive: true })
  // An INDEPENDENT definition: it names tools, so it needs a preset and therefore
  // exercises the registration path. A file naming none inherits instead and is
  // deliberately not registered.
  writeFileSync(join(validRoot, 'v.md'), '---\nname: v\ndescription: d\ntools: [search]\n---\n\nbody\n', 'utf8')
  const validLoader = createLoader(bare, { roots: [validRoot], defaultTools: ['fs'], watchIntervalMs: 0 })
  const valid = await validLoader.reconcile()
  assert.deepEqual(valid.ids, ['v'], 'the preset registered without an inject declaration')
  assert.deepEqual(seen, ['v'], 'the registry actually received the declaration')

  // A file that fails to compile is reported, not silently dropped.
  const brokenRoot = join(tempRoot, 'broken')
  mkdirSync(brokenRoot, { recursive: true })
  writeFileSync(join(brokenRoot, 'b.md'), '---\nname: b\ndescription: d\ntools: [nope]\n---\n', 'utf8')
  const brokenLoader = createLoader(bare, { roots: [brokenRoot], defaultTools: ['fs'], watchIntervalMs: 0 })
  const broken = await brokenLoader.reconcile()
  assert.deepEqual(broken.ids, [], 'the invalid tool name yields no definition')
  assert.ok(
    brokenLoader.diagnostics.some(line => line.includes('compile')),
    'a compile failure is reported instead of vanishing',
  )

  await validLoader.dispose()
  await brokenLoader.dispose()
})

await checkAsync('publishes the composition the model selects from', async () => {
  const document = await ctx.agentPresets.readDocument('reviewer')
  assert.match(document.content, /dsh-persona/u)
  assert.match(document.content, /dsh-tool-fs-search/u)
  assert.match(document.content, /dsh-tool-bash/u)
  assert.match(document.content, /dsh-skill-filesystem/u)
})

await checkAsync('resolves each definition so allowedAgentPresets can offer it', async () => {
  for (const id of ['type-design-analyzer', 'reviewer']) {
    const row = await ctx.agentPresets.resolve(id)
    assert.equal(row.id, id)
    assert.equal(row.broken, undefined)
  }
})

await checkAsync('an edited file re-registers under the same id and order', async () => {
  const before = (await ctx.agentPresets.list()).find(row => row.id === 'reviewer')
  writeAgent('reviewer.md', ['description: Reviews changes with search only.', 'tools: [search]'].join('\n'), 'You review software changes, read-only.')
  utimesSync(join(tempRoot, 'reviewer.md'), new Date(), new Date(Date.now() + 5000))
  await loader.reconcile()
  const rows = await ctx.agentPresets.list()
  assert.equal(rows.length, 2, 'no duplicate declaration after an edit')
  const after = rows.find(row => row.id === 'reviewer')
  assert.equal(after.order, before.order, 'roster position is stable across an edit')
  assert.equal(after.broken, undefined)
  const document = await ctx.agentPresets.readDocument('reviewer')
  assert.ok(!document.content.includes('dsh-tool-bash'), 'the removed shell row is gone')
})

await checkAsync('editing only the model reports a change, so the tool remounts', async () => {
  // Regression lock: `changed` used to compare only the id list, so a `model:`
  // edit registered the new preset but never rebuilt the delegation tool — the
  // model kept running the previous route until a full restart.
  // A dedicated directory keeps this independent of tempRoot's lifecycle.
  const modelRoot = join(tempRoot, 'model-edit')
  mkdirSync(modelRoot, { recursive: true })
  const modelFile = join(modelRoot, 'worker.md')
  const fresh = createLoader(ctx, {
    roots: [modelRoot],
    defaultTools: ['fs'],
    watchIntervalMs: 0,
    expose: { toolName: 'subagent_defined', provider: 'spawn', defaultProvider: 'p' },
  })
  writeFileSync(modelFile, '---\nname: worker\ndescription: Works.\n---\n\nbody\n', 'utf8')
  const first = await fresh.reconcile()
  assert.equal(first.changed, true, 'first scan registers')

  const stable = await fresh.reconcile()
  assert.equal(stable.changed, false, 'an unchanged directory reports no change')

  writeFileSync(modelFile, '---\nname: worker\ndescription: Works.\nmodel: p/model-a\n---\n\nbody\n', 'utf8')
  utimesSync(modelFile, new Date(), new Date(Date.now() + 10000))
  const modeled = await fresh.reconcile()
  assert.equal(modeled.changed, true, 'a model-only edit must remount the tool')
  assert.equal(fresh.definitions()[0]?.model, 'p/model-a')

  await fresh.dispose()
})

await checkAsync('a deleted file retires its preset', async () => {
  rmSync(join(tempRoot, 'type-design-analyzer.md'))
  await loader.reconcile()
  assert.deepEqual((await ctx.agentPresets.list()).map(row => row.id), ['reviewer'])
})

await checkAsync('a file that fails to compile keeps its previous registration', async () => {
  writeAgent('reviewer.md', ['description: Reviews with search.', 'tools: [search, nope]'].join('\n'), 'broken')
  utimesSync(join(tempRoot, 'reviewer.md'), new Date(), new Date(Date.now() + 10000))
  await loader.reconcile()
  assert.deepEqual((await ctx.agentPresets.list()).map(row => row.id), ['reviewer'], 'a half-saved edit must not drop the preset')
})

await loader.dispose()
await checkAsync('dispose retires every registration it owns', async () => {
  assert.deepEqual((await ctx.agentPresets.list()).map(row => row.id), [])
})

await checkAsync('apply() mounts without a caller driving scans', async () => {
  await applyAgentDefs(ctx, { roots: [tempRoot], watchIntervalMs: 0 })
  // The file is still the broken one, so a fresh loader registers nothing; the
  // point here is that apply() returns without throwing on an unreadable def.
  assert.equal((await ctx.agentPresets.list()).length, 0)
})

// --- Part 3: per-definition model resolution --------------------------------
//
// The shipped `subagent` tool takes `agentOptions` from the TOOL INSTANCE, so a
// definition's model could never reach the child through it. This plugin owns a
// delegation tool so the route becomes a per-call decision: the definition's
// declared model is the default, and the parent model may override it.

console.log('\n# model: the definition declares a default, the parent may override')

const { parseRoute, resolveChildRoute, DefinitionRoutes, createDelegationTool } = await import(`${HERE}/../lib/delegate.js`)

check('a bare model id uses the configured default provider', () => {
  assert.deepEqual(parseRoute('deepseek-v4-flash', 'aggregate'), { provider: 'aggregate', model: 'deepseek-v4-flash' })
})

check('provider/model names both, and an empty value declares nothing', () => {
  assert.deepEqual(parseRoute('openai/gpt-5.6-sol', undefined), { provider: 'openai', model: 'gpt-5.6-sol' })
  assert.equal(parseRoute(undefined, 'aggregate'), undefined)
  assert.equal(parseRoute('  ', 'aggregate'), undefined)
})

check('a bare id without a default provider fails loud instead of guessing', () => {
  assert.throws(() => parseRoute('deepseek-v4-flash', undefined), /names no provider/u)
})

check('the definition route applies when the parent names nothing', () => {
  const route = resolveChildRoute({
    request: {},
    declared: { provider: 'aggregate', model: 'deepseek-v4-flash' },
    configured: undefined,
  })
  assert.deepEqual(route, { provider: 'aggregate', model: 'deepseek-v4-flash' })
})

check('an explicit parent route wins over the definition route', () => {
  const route = resolveChildRoute({
    request: { provider: 'openai', model: 'gpt-5.6-sol' },
    declared: { provider: 'aggregate', model: 'deepseek-v4-flash' },
    configured: undefined,
  })
  assert.deepEqual(route, { provider: 'openai', model: 'gpt-5.6-sol' })
})

check('an unusable definition default never blocks an explicit parent route', () => {
  // The file's model is a DEFAULT, not a constraint. A definition may name a
  // provider this deployment has no adapter for; the parent must be able to
  // rescue the call by naming a workable route.
  const route = resolveChildRoute({
    request: { provider: 'magpie', model: 'workbuddy-ai/deepseek-v4.1-flash' },
    declared: { provider: 'aggregate', model: 'model-that-does-not-exist', reasoningEffort: 'high' },
    configured: undefined,
  })
  assert.deepEqual(route, { provider: 'magpie', model: 'workbuddy-ai/deepseek-v4.1-flash' })
  assert.equal(route.reasoningEffort, undefined, 'the dead route\'s effort is not carried onto the new model')
})

check('an unparseable default model drops only that default, never the definition', () => {
  // A bare model id with no configured provider cannot be resolved. That must
  // not remove the definition from the enum: the parent can still select it and
  // supply both halves of the route.
  const routes = new DefinitionRoutes()
  const dropped = routes.replace([
    { id: 'broken-default', description: 'Keeps its place.', model: 'no-provider-here' },
    { id: 'good', description: 'Has a provider.', model: 'p/m' },
  ], {})
  assert.deepEqual(routes.ids(), ['broken-default', 'good'], 'both stay selectable')
  assert.equal(routes.routeFor('broken-default'), undefined, 'only the default was dropped')
  assert.deepEqual(routes.routeFor('good'), { provider: 'p', model: 'm' })
  assert.equal(dropped.length, 1)
  assert.equal(dropped[0].id, 'broken-default')
})

check('a definition with no model leaves the parent free to choose', () => {
  const chosen = resolveChildRoute({
    request: { provider: 'openai', model: 'gpt-5.6-sol' },
    declared: undefined,
    configured: undefined,
  })
  assert.deepEqual(chosen, { provider: 'openai', model: 'gpt-5.6-sol' })
  const inherited = resolveChildRoute({ request: {}, declared: undefined, configured: undefined })
  assert.equal(inherited, undefined, 'nothing named anywhere means inherit the parent route')
})

check('the tool-instance default is the last fallback', () => {
  const route = resolveChildRoute({
    request: {},
    declared: undefined,
    configured: { provider: 'aggregate', model: 'deepseek-v4-1-flash' },
  })
  assert.deepEqual(route, { provider: 'aggregate', model: 'deepseek-v4-1-flash' })
})

check('changing the route without naming an effort drops the old effort', () => {
  const route = resolveChildRoute({
    request: { provider: 'openai', model: 'gpt-5.6-sol' },
    declared: { provider: 'aggregate', model: 'deepseek-v4-flash', reasoningEffort: 'high' },
    configured: undefined,
  })
  assert.equal(route.reasoningEffort, undefined, 'a new model resolves its own default effort')
})

check('supplying only one of provider/model is rejected', () => {
  assert.throws(
    () => resolveChildRoute({ request: { provider: 'openai' }, declared: undefined, configured: undefined }),
    /must be supplied together/u,
  )
})

check('DefinitionRoutes exposes ids, routes and the default model in the description', () => {
  const routes = new DefinitionRoutes()
  routes.replace([
    { id: 'with-model', description: 'Has a default model.', model: 'deepseek-v4-flash' },
    { id: 'no-model', description: 'Inherits the parent route.' },
  ], { provider: 'aggregate' })
  assert.deepEqual(routes.ids(), ['with-model', 'no-model'])
  assert.deepEqual(routes.routeFor('with-model'), { provider: 'aggregate', model: 'deepseek-v4-flash' })
  assert.equal(routes.routeFor('no-model'), undefined)
  const text = routes.describe()
  // One definition per line, so a model scanning many definitions can tell them
  // apart; the default model is its own line, and no sentence ends in `..`.
  assert.match(text, /- with-model: Has a default model\./u)
  assert.match(text, /Default model: aggregate\/deepseek-v4-flash\./u)
  assert.match(text, /- no-model: Inherits the parent route\./u)
  assert.ok(!text.includes('..'), 'a trailing period in the source field must not double')
})

await checkAsync('when-to-use is shown separately from what the definition is', async () => {
  const { DefinitionRoutes: Routes } = await import(`${HERE}/../lib/delegate.js`)
  const routes = new Routes()
  routes.replace([{ id: 'r', description: 'Reviews a change.', whenToUse: 'a diff needs a read before merge' }], {})
  const text = routes.describe()
  assert.match(text, /- r: Reviews a change\./u)
  assert.match(text, /Use when: a diff needs a read before merge\./u, 'the trigger is on its own line and complete')
  assert.ok(!text.includes('..'), 'no doubled terminators')
})

// The tool definition itself: the schema the model reads, and the request the
// body builds. A stub host supplies defineTool so this stays a pure check.
await checkAsync('the delegation tool carries the enum and sends the resolved route', async () => {
  const calls = []
  const routes = new DefinitionRoutes()
  routes.replace([
    { id: 'with-model', description: 'Has a default model.', model: 'deepseek-v4-flash' },
    { id: 'no-model', description: 'Inherits the parent route.' },
  ], { provider: 'aggregate' })

  const { defineTool } = await import(pathToFileURL(join(INSTALL, 'dsh-tools/lib/index.js')).href)
  const { ReasoningEffortId } = await import(pathToFileURL(join(INSTALL, 'dsh-llm/lib/index.js')).href)
  const { delegationDepthOf } = await import(pathToFileURL(join(INSTALL, 'dsh-subagent/lib/index.js')).href)

  const started = []
  const definition = createDelegationTool({
    toolName: 'subagent_defined',
    routes,
    configured: { provider: 'spawn', maxDepth: 3 },
    getProvider: () => ({ name: 'spawn' }),
    resolveRoute: async (childOptions) => { calls.push(childOptions) },
    host: { defineTool, reasoningEffortId: ReasoningEffortId, delegationDepthOf },
  })

  assert.equal(definition.name, 'subagent_defined')
  // `defineTool` normalizes the parameter DSL into JSON Schema.
  const presetParameter = definition.parameters.properties.agent_preset
  assert.deepEqual(presetParameter.enum, ['with-model', 'no-model'])
  assert.ok(definition.parameters.required.includes('agent_preset'), 'the definition is required')

  // A stub agent whose context behaves like a real Agent context: a service is
  // reachable through `get()` but the guarded property read THROWS, which is the
  // exact failure that shipped once ("cannot get property subagents without
  // inject"). Modelling both access paths is what keeps that bug caught.
  const services = {
    subagents: {
      // Snapshot the route per call: the body hands over the live request
      // object, so holding the reference would let a later call rewrite the
      // earlier assertion.
      startActivation: async (spec) => {
        started.push({ provider: spec.provider, agentOptions: spec.request.agentOptions, agentPreset: spec.request.agentPreset, maxDepth: spec.request.maxDepth })
        return { childId: 'child-1' }
      },
    },
  }
  const parent = {
    id: 'parent',
    session: { header: {} },
    options: { subagentDepth: 0 },
    ctx: {
      get: name => services[name],
      // Mirrors cordis: an undeclared service through the property form throws.
      get subagents() { throw new Error('cannot get property "subagents" without inject') },
    },
  }

  const result = await definition.execute(
    { description: 'analyze', prompt: 'do it', agent_preset: 'with-model' },
    { agent: parent, signal: new AbortController().signal },
  )
  assert.deepEqual(result, { kind: 'activation', subagentId: 'child-1' })
  assert.deepEqual(calls.at(-1), { provider: 'aggregate', model: 'deepseek-v4-flash' }, 'preflight saw the definition route')
  assert.deepEqual(started.at(-1).agentOptions, { provider: 'aggregate', model: 'deepseek-v4-flash' })
  assert.equal(started.at(-1).agentPreset, 'with-model')
  assert.equal(started.at(-1).provider, 'spawn')
  assert.equal(started.at(-1).maxDepth, 3)

  // Overriding: the parent's explicit route replaces the definition default.
  await definition.execute(
    { description: 'analyze', prompt: 'do it', agent_preset: 'with-model', provider: 'openai', model: 'gpt-5.6-sol' },
    { agent: parent, signal: new AbortController().signal },
  )
  assert.deepEqual(started.at(-1).agentOptions, { provider: 'openai', model: 'gpt-5.6-sol' })

  // A definition with no model: the parent still chooses.
  await definition.execute(
    { description: 'analyze', prompt: 'do it', agent_preset: 'no-model', provider: 'openai', model: 'gpt-5.6-sol' },
    { agent: parent, signal: new AbortController().signal },
  )
  assert.deepEqual(started.at(-1).agentOptions, { provider: 'openai', model: 'gpt-5.6-sol' })

  // Nothing named: no agentOptions at all, so the child inherits the parent route.
  const preflightsBefore = calls.length
  await definition.execute(
    { description: 'analyze', prompt: 'do it', agent_preset: 'no-model' },
    { agent: parent, signal: new AbortController().signal },
  )
  assert.equal(started.at(-1).agentOptions, undefined)
  assert.equal(calls.length, preflightsBefore, 'no route to preflight when nothing is named')
})

await checkAsync('an unusable default model still lets an explicit route through', async () => {
  // The definition file cannot know this deployment's adapters, so its `model`
  // is a default and never a constraint. What must hold: with a dead default,
  // (a) selecting the definition without a route fails at the preflight,
  // (b) the same call WITH an explicit route reaches startActivation, and
  // (c) the dead route is never what the preflight sees.
  const { defineTool } = await import(pathToFileURL(join(INSTALL, 'dsh-tools/lib/index.js')).href)
  const { ReasoningEffortId } = await import(pathToFileURL(join(INSTALL, 'dsh-llm/lib/index.js')).href)
  const { delegationDepthOf } = await import(pathToFileURL(join(INSTALL, 'dsh-subagent/lib/index.js')).href)

  const routes = new DefinitionRoutes()
  routes.replace([{ id: 'dead-default', description: 'Points at a dead route.', model: 'deadprovider/dead-model' }], {})
  const preflights = []
  const starts = []
  const definition = createDelegationTool({
    toolName: 'subagent_defined',
    routes,
    configured: { provider: 'spawn' },
    getProvider: () => ({ name: 'spawn' }),
    // Mirror the real preflight: an unknown provider adapter rejects the call.
    resolveRoute: async (options) => {
      preflights.push(options)
      if (options.provider !== 'live') throw new Error(`no adapter registered for provider "${options.provider}"`)
    },
    host: { defineTool, reasoningEffortId: ReasoningEffortId, delegationDepthOf },
  })

  const parent = {
    id: 'parent',
    session: { header: {} },
    options: { subagentDepth: 0 },
    ctx: {
      get: name => (name === 'subagents'
        ? { startActivation: async (spec) => { starts.push(spec.request.agentOptions); return { childId: 'c' } } }
        : undefined),
      get subagents() { throw new Error('cannot get property "subagents" without inject') },
    },
  }

  // (a) the dead default fails, and it is the dead route that failed.
  await assert.rejects(
    definition.execute({ description: 'd', prompt: 'p', agent_preset: 'dead-default' }, { agent: parent, signal: new AbortController().signal }),
    /no adapter registered for provider "deadprovider"/u,
  )
  assert.equal(starts.length, 0, 'no child started')

  // (b) the same definition with a workable route goes through.
  await definition.execute(
    { description: 'd', prompt: 'p', agent_preset: 'dead-default', provider: 'live', model: 'live-model' },
    { agent: parent, signal: new AbortController().signal },
  )
  // (c) the dead route never reached the preflight on that call.
  assert.deepEqual(preflights.at(-1), { provider: 'live', model: 'live-model' })
  assert.deepEqual(starts.at(-1), { provider: 'live', model: 'live-model' })
})

// --- Part 4: hiding the shipped delegation tools -----------------------------
//
// Two tools cannot compete for one decision: the model picks whichever it saw
// first, and the shipped `subagent` is mounted by the preset inside an ancestor
// scope a profile `disabled` row cannot reach. Hiding is what makes the
// replacement reachable, so the two halves ship together — and the gate matters
// as much as the hiding, because hiding with no replacement strands the model.

console.log('\n# hide: the shipped tools give way to ours, but only while ours serves')

const { installOfficialToolHiding, stripMentions, DEFAULT_HIDDEN_TOOLS } = await import(`${HERE}/../lib/hide.js`)

const { default: HideSystemPrompt } = await fromInstall('dsh-system-prompt/lib/index.js')
const { default: HideToolRuntime, defineTool: hideDefineTool } = await fromInstall('dsh-tools/lib/index.js')

/**
 * A fresh registry with the shipped tools, our replacement, and a prompt section
 * that names both — the shape a real Web preset produces.
 * @param {boolean} serving - what `isActive()` reports.
 */
const hideHarness = async (serving) => {
  const host = new Context()
  await host.plugin(HideSystemPrompt, { personaPrefix: '' })
  await host.plugin(HideToolRuntime)
  for (const toolName of [...DEFAULT_HIDDEN_TOOLS, 'subagent_defined', 'read']) {
    host.tools.register(hideDefineTool({
      name: toolName,
      description: `${toolName} description`,
      parameters: {},
      output: { schema: { type: 'string' }, render: () => [] },
      async execute() { return 'ok' },
    }))
  }
  host.systemPrompt.section({
    name: 'delegation:policy',
    order: 100,
    text: 'Start independent delegations with `subagent` or `subagent_fork` together in one assistant message. Use `read` for files.',
  })
  const handle = installOfficialToolHiding(host, {
    names: DEFAULT_HIDDEN_TOOLS,
    replacement: 'subagent_defined',
    isActive: () => serving,
  })
  return { host, denial: handle.denial }
}

await checkAsync('while our tool serves, the shipped schemas and their prompt sentence are gone', async () => {
  const { host } = await hideHarness(true)
  const assembly = await host.systemPrompt.assemble({})
  const names = assembly.tools.map(tool => tool.name)
  assert.ok(!names.includes('subagent'), 'subagent schema removed')
  assert.ok(!names.includes('subagent_fork'), 'subagent_fork schema removed')
  assert.ok(names.includes('subagent_defined'), 'our tool stays visible')
  assert.ok(names.includes('read'), 'unrelated tools are untouched')
  const policy = assembly.sections.find(section => section.name === 'delegation:policy').text
  assert.ok(!policy.includes('subagent_fork'), 'the sentence naming them is dropped')
  assert.ok(policy.includes('read'), 'the surrounding advice survives')
})

await checkAsync('while our tool does NOT serve, the shipped tools stay visible', async () => {
  const { host } = await hideHarness(false)
  const assembly = await host.systemPrompt.assemble({})
  const names = assembly.tools.map(tool => tool.name)
  assert.ok(names.includes('subagent'), 'an empty definition set must not strand the model')
  assert.ok(names.includes('subagent_fork'))
  const policy = assembly.sections.find(section => section.name === 'delegation:policy').text
  assert.ok(policy.includes('subagent_fork'), 'the prompt keeps naming them')
})

await checkAsync('a call to a hidden tool is denied while our tool serves, allowed otherwise', async () => {
  const active = await hideHarness(true)
  // Guards run inside dispatch; a hidden name must reach the guard's denial
  // rather than the tool body.
  const denied = await active.host.tools.execute({ name: 'subagent', arguments: {}, signal: new AbortController().signal })
  assert.equal(denied.isError, true, 'the call is refused')
  assert.match(JSON.stringify(denied.content), /subagent_defined/u, 'the denial names the replacement')

  const inactive = await hideHarness(false)
  const allowed = await inactive.host.tools.execute({ name: 'subagent', arguments: {}, signal: new AbortController().signal })
  assert.notEqual(allowed.isError, true, 'with no replacement serving, the shipped tool still runs')
})

await checkAsync('the denial names both hidden tools and the replacement', async () => {
  const { denial } = await hideHarness(true)
  assert.match(denial, /`subagent` \/ `subagent_fork` is disabled/u)
  assert.match(denial, /subagent_defined/u, 'the denial names the replacement')
})

check('stripMentions drops a whole PTC declaration block, not just its first line', () => {
  const text = [
    'export interface ToolArgsMap {',
    '  subagent: {',
    '    prompt: string',
    '    description: string',
    '  }',
    '  read: { path: string }',
    '}',
  ].join('\n')
  const stripped = stripMentions(text, ['subagent'])
  assert.ok(!stripped.includes('prompt: string'), 'the balanced block went with it')
  assert.ok(stripped.includes('read: { path: string }'), 'the neighbouring binding survives')
})

check('stripMentions never matches a hidden name inside a longer word', () => {
  assert.equal(stripMentions('already subagentic', ['subagent']), 'already subagentic')
})

// --- Part 4: definitions already on this machine -----------------------------
//
// The realistic case is a directory of pre-existing Claude-style definitions
// whose frontmatter carries only name and description. They must load without
// edits, taking the configured default tool groups.

const realDir = join(homedir(), '.agents', 'agents')
if (existsSync(realDir)) {
  console.log('\n# real definitions')
  await checkAsync('loads the pre-existing definition directory without edits', async () => {
    const real = createLoader(ctx, { roots: [realDir], defaultTools: ['fs', 'search'], watchIntervalMs: 0 })
    const result = await real.reconcile()
    assert.ok(result.ids.length > 0, 'at least one definition loaded')
    // Authored files carry only `name` and `description`, so every one of them
    // inherits: it contributes a persona and no preset. Asserting the actual
    // shape (not a registry row) is what tells the two modes apart.
    const definitions = real.definitions()
    for (const definition of definitions) {
      assert.equal(definition.inherit, true, `${definition.id} should inherit the parent composition`)
      assert.ok(definition.persona.length > 0, `${definition.id} should carry its body as the persona`)
      assert.ok(definition.description.length > 0, `${definition.id} should expose its description`)
    }
    await real.dispose()
  })
} else {
  console.log('\n# real definitions: SKIPPED (no ~/.agents/agents)')
}

rmSync(tempRoot, { recursive: true, force: true })
console.log(`\n${String(passed)} checks passed`)
