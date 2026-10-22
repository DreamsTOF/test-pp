/**
 * Load Claude-style agent definition files from disk and register each one as an
 * Agent Preset.
 *
 * A definition is a Markdown file with YAML frontmatter; its body becomes the
 * child agent's persona and its `tools`/`skills` keys select the plugins the
 * preset mounts. The parent model picks one definition per delegation through
 * `subagent`'s `agent_preset` parameter.
 *
 * Hot reload is the point of scanning rather than declaring: editing a file
 * re-registers that preset, and because a preset revision is retained per Agent
 * generation, live sessions keep the composition they started with while the
 * next delegation sees the edit.
 *
 * @module @local/dsh-agent-defs
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, isAbsolute, join, resolve } from 'node:path'
import { compileDefinition, splitFrontmatter } from './compile.js'
import { DefinitionRoutes, createDelegationTool } from './delegate.js'
import { DEFAULT_HIDDEN_TOOLS, installOfficialToolHiding } from './hide.js'

export const name = 'agent-defs'

/**
 * Preset registration needs the registry, but hiding and the delegation tool do
 * not. Declaring the registry as a hard dependency makes ONE missing service
 * suspend the whole plugin — silently, with no tool and no hiding, which is
 * exactly the failure that looks like "the plugin was never loaded". The loader
 * therefore starts when the registry appears, and everything else runs anyway.
 */
export const inject = []

/** Poll interval used when the caller configures no value. */
const DEFAULT_WATCH_INTERVAL_MS = 2000

/**
 * @typedef {object} Config
 * @property {string[]} [roots] - Directories scanned for `*.md`, each resolved against the Host cwd. Defaults to `~/.agents/agent`.
 * @property {string[]} [defaultTools] - Tool groups a definition uses when it omits `tools`.
 * @property {number} [watchIntervalMs] - Poll interval for file changes; `0` disables watching.
 * @property {boolean} [includeSkillLoader] - Mount the skill loader for definitions that name `skills`. Defaults to true.
 * @property {number} [order] - Roster position of the first definition; later files increment it.
 * @property {false | { toolName?: string, provider?: string }} [expose] - Mount one delegation tool whose `agent_preset` enum is the live definition set. `false` disables it.
 * @property {false | { names?: string[], stripPrompt?: boolean }} [hideOfficialTools] - Hide the shipped delegation tools while `expose` serves. Defaults to hiding `subagent` and `subagent_fork`; `false` keeps them visible.
 */

/**
 * One registered definition, keyed by absolute source path.
 * `fingerprint` is the file identity whose change triggers re-registration;
 * `order` survives an edit so the roster keeps its shape.
 * @typedef {{ id: string, order: number, description: string, whenToUse?: string, model?: string, persona?: string, inherit?: boolean, fingerprint: string, unregister: () => Promise<void> }} Entry
 */

/**
 * Build the reconciler without mounting a watcher, so `apply` can own the
 * lifecycle and a test can drive scans directly.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {Config} config - loader configuration.
 * @returns {{ reconcile: () => Promise<{ ids: string[], changed: boolean }>, roots: string[], ids: () => string[], dispose: () => Promise<void> }} the reconciler.
 */
export function createLoader(ctx, config = {}) {
  const roots = (config.roots ?? []).length > 0
    ? config.roots.map(root => (isAbsolute(root) ? root : resolve(root)))
    : [join(homedir(), '.agents', 'agents')]
  // Off by default: a definition that names no `tools:` inherits the parent's
  // whole composition, so there is no fallback group list to apply. A deployment
  // that wants authored files to be read-only sets this explicitly.
  const defaultTools = config.defaultTools
  const includeSkillLoader = config.includeSkillLoader !== false
  let nextOrder = config.order ?? 100
  /** @type {Map<string, Entry>} */
  const registered = new Map()
  /** Per-scan diagnostics, surfaced by the trace so a silent empty scan is visible. */
  const diagnostics = []
  let disposed = false

  /**
   * Ids of the definitions currently registered, in roster order.
   * @returns {string[]} the ids a parent model may select.
   */
  const ids = () => [...registered.values()]
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
    .map(entry => entry.id)

  /**
   * Compiled definitions currently registered, in roster order. The delegation
   * tool reads `model` from here, so an edit reaches the next mount.
   * @returns {Array<{ id: string, description: string, model?: string }>} the compiled definitions.
   */
  const definitions = () => [...registered.values()]
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
    .map(entry => ({
      id: entry.id,
      description: entry.description,
      ...entry.whenToUse === undefined ? {} : { whenToUse: entry.whenToUse },
      ...entry.inherit === true ? { inherit: true } : {},
      ...entry.persona === undefined ? {} : { persona: entry.persona },
      ...entry.model === undefined ? {} : { model: entry.model },
    }))

  /**
   * Read one definition file into its compiled form.
   * @param {string} path - absolute file path.
   * @returns {Promise<ReturnType<typeof compileDefinition>>} the compiled definition.
   */
  const load = async (path) => {
    const source = await readFile(path, 'utf8')
    const { data, body } = splitFrontmatter(source)
    const fallbackId = basename(path, extname(path)).toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '')
    return compileDefinition({ fallbackId, path, data, body, defaultTools, includeSkillLoader })
  }

  /**
   * List every definition file under the configured roots.
   * A missing root is the normal first-run state, not a failure.
   * @returns {Promise<Array<{ path: string, fingerprint: string }>>} candidates in deterministic order.
   */
  const scan = async () => {
    /** @type {Array<{ path: string, fingerprint: string }>} */
    const found = []
    for (const root of roots) {
      let entries
      try {
        entries = await readdir(root, { withFileTypes: true })
      } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
          diagnostics.push(`root ${root}: ${String(error?.code)}`)
          continue
        }
        diagnostics.push(`root ${root}: readdir failed ${String(error?.code)} ${error?.message ?? ''}`)
        throw error
      }
      diagnostics.push(`root ${root}: ${String(entries.length)} entries`)
      for (const entry of entries) {
        if (!entry.isFile() || extname(entry.name).toLowerCase() !== '.md') continue
        const path = join(root, entry.name)
        const info = await stat(path)
        found.push({ path, fingerprint: `${String(info.mtimeMs)}:${String(info.size)}` })
      }
    }
    return found.sort((left, right) => left.path.localeCompare(right.path))
  }

  /**
   * Reconcile the registry with one scan: register new or edited definitions,
   * retire definitions whose file disappeared, and leave an unchanged file
   * untouched so its retained revision and KV-cache prefix survive.
   *
   * A file that fails to compile keeps its previous registration: a half-saved
   * edit must not silently remove a definition a running team depends on.
   * @returns {Promise<{ ids: string[], changed: boolean }>} live ids, and whether membership changed.
   */
  const reconcile = async () => {
    if (disposed) return { ids: [], changed: false }
    const candidates = await scan()
    const before = toolSignature()
    const live = new Set()
    for (const candidate of candidates) {
      if (disposed) return { ids: ids(), changed: false }
      const previous = registered.get(candidate.path)
      if (previous !== undefined && previous.fingerprint === candidate.fingerprint) {
        live.add(candidate.path)
        continue
      }
      let compiled
      try {
        compiled = await load(candidate.path)
      } catch (error) {
        // Keep the old registration so a half-saved edit cannot erase a preset.
        if (previous !== undefined) live.add(candidate.path)
        const message = error instanceof Error ? error.message : String(error)
        diagnostics.push(`compile ${candidate.path}: ${message}`)
        ctx.logger.warn(`agent-defs: ${candidate.path}: ${message}`)
        continue
      }
      const order = previous?.order ?? nextOrder++
      // Retire the previous declaration before declaring the new one, so a
      // rename inside one file cannot leave two presets under one id.
      if (previous !== undefined) {
        registered.delete(candidate.path)
        await previous.unregister()
      }
      // An inheriting definition names no tools, skills, or model, so it needs no
      // preset at all: the delegation layer composes the child from the parent
      // plus this persona. Registering a preset for it would give the child a
      // composition of its own and silently drop the parent's tools.
      if (compiled.inherit === true) {
        registered.set(candidate.path, {
          id: compiled.id,
          order,
          description: compiled.description,
          ...compiled.whenToUse === undefined ? {} : { whenToUse: compiled.whenToUse },
          ...compiled.persona === undefined ? {} : { persona: compiled.persona },
          inherit: true,
          fingerprint: candidate.fingerprint,
          unregister: async () => {},
        })
        live.add(candidate.path)
        continue
      }
      // `ctx.agentPresets` is a guarded property read: it THROWS when the
      // registry is not a declared dependency of this context. The getter form
      // returns undefined instead, which is what lets the tool and the hiding
      // above survive a deployment without a preset registry.
      const presets = ctx.get('agentPresets')
      if (presets === undefined) {
        diagnostics.push(`register ${compiled.id}: no agentPresets service in this context`)
        continue
      }
      try {
        const unregister = await presets.register({
          id: compiled.id,
          name: compiled.id,
          description: compiled.description,
          order,
          plugins: compiled.plugins,
        })
        registered.set(candidate.path, {
          id: compiled.id,
          order,
          description: compiled.description,
          ...compiled.whenToUse === undefined ? {} : { whenToUse: compiled.whenToUse },
          ...compiled.model === undefined ? {} : { model: compiled.model },
          fingerprint: candidate.fingerprint,
          unregister,
        })
        live.add(candidate.path)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        diagnostics.push(`register ${compiled.id}: ${message}`)
        ctx.logger.warn(`agent-defs: ${candidate.path}: ${message}`)
      }
    }
    for (const [path, entry] of [...registered]) {
      if (live.has(path)) continue
      registered.delete(path)
      await entry.unregister()
    }
    // `ids()` alone cannot see a model or description edit, and the delegation
    // tool bakes both into its schema — a model change that does not reach
    // `refresh()` leaves the tool advertising the previous route until restart.
    return { ids: ids(), changed: toolSignature() !== before }
  }

  /**
   * Every fact the delegation tool's schema shows, as one comparable string.
   *
   * The tool's enum, its descriptions, and each definition's default model all
   * live in the mounted schema, so a change to any of them needs a remount. The
   * id list alone is not enough: editing only a `model` line changes no id.
   * @returns {string} the schema-relevant state.
   */
  const toolSignature = () => [...registered.values()]
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
    .map(entry => `${entry.id}\u0000${entry.description}\u0000${entry.whenToUse ?? ''}\u0000${entry.model ?? ''}`)
    .join('\u0001')

  return {
    reconcile,
    ids,
    definitions,
    roots,
    diagnostics,
    dispose: async () => {
      if (disposed) return
      disposed = true
      const entries = [...registered.values()]
      registered.clear()
      for (const entry of entries) await entry.unregister()
    },
  }
}

/**
 * Resolve a bare package name the way the composed tree does: against the
 * launcher's install anchor, not this file's own location. A plugin installed
 * outside the dsh installation cannot import `@deepseek-ai/*` directly.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {string} specifier - bare package name.
 * @returns {Promise<Record<string, unknown>>} the module namespace.
 */
async function importFromHost(ctx, specifier) {
  const internal = ctx.loader?.internal
  if (internal !== undefined && ctx.baseUrl !== undefined) {
    return await internal.import(specifier, ctx.baseUrl, {})
  }
  return await import(specifier)
}

/**
 * Mount one delegation tool named by `expose`, whose `agent_preset` enum is the
 * live definition set.
 *
 * The set is an enum on the tool schema, so it can only be widened by mounting
 * a new tool instance: an agent that already assembled its schema keeps the
 * enum it saw until its next request. Remounting on an unchanged set is avoided
 * so editing a definition's body does not churn every agent's tool catalog.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {{ toolName?: string, provider?: string }} options - tool name and backend.
 * @param {{ ids: () => string[], definitions: () => object[] }} loader - live definition state.
 * @returns {{ refresh: (ids: string[]) => Promise<void>, serving: () => boolean, dispose: () => Promise<void> }} the mount handle.
 */
function createExpose(ctx, options, loader) {
  const toolName = options.toolName ?? 'subagent_defined'
  const provider = options.provider ?? 'spawn'
  const routes = new DefinitionRoutes()
  /** @type {{ stop: () => Promise<void> } | undefined} */
  let mounted
  let currentKey = ''
  let disposed = false
  /**
   * Whether this tool currently serves delegations. It is the gate for hiding
   * the shipped tools: hiding while our own tool is absent would leave the
   * model with no way to delegate at all.
   * @returns {boolean} true only while a mounted registration exists.
   */
  const serving = () => mounted !== undefined && !disposed

  /**
   * Replace the mounted delegation tool with one carrying `ids` as its enum and
   * each definition's declared model as its default route.
   * @param {string[]} candidates - definition ids to offer, in roster order.
   * @returns {Promise<void>} resolves after the replacement mounted.
   */
  const refresh = async (candidates) => {
    if (disposed) return
    if (candidates.length === 0) {
      await unmount()
      return
    }
    const dropped = routes.replace(loader.definitions(), { provider: options.defaultProvider ?? options.provider })
    for (const entry of dropped) {
      ctx.logger.warn(`agent-defs: ${entry.id}: default model ignored (${entry.problem}); select it with an explicit provider/model`)
    }
    const key = candidates.map(id => `${id}\u0000${routes.routeFor(id)?.model ?? ''}`).join('\u0001')
    if (key === currentKey && mounted !== undefined) return
    const tools = await importFromHost(ctx, '@deepseek-ai/dsh-tools')
    const subagent = await importFromHost(ctx, '@deepseek-ai/dsh-subagent')
    const llm = await importFromHost(ctx, '@deepseek-ai/dsh-llm')
    await unmount()
    // The tool needs the delegation stack plus `llm` for the route preflight;
    // a deployment without them simply never mounts it.
    const fiber = ctx.inject(['tools', 'subagents', 'systemPrompt', 'llm'], (runtimeCtx) => {
      const definition = createDelegationTool({
        toolName,
        routes,
        configured: {
          provider,
          ...options.maxDepth === undefined ? {} : { maxDepth: options.maxDepth },
        },
        routeDefaults: {
          ...options.model === undefined ? {} : { model: options.model },
          ...options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort },
        },
        getProvider: name => runtimeCtx.subagents.getProvider(name),
        resolveRoute: async (childOptions, signal) => {
          await runtimeCtx.llm.resolveCallConfig({
            provider: childOptions.provider,
            model: childOptions.model,
            ...childOptions.reasoningEffort === undefined ? {} : { reasoningEffort: childOptions.reasoningEffort },
          }, signal)
        },
        host: {
          defineTool: tools.defineTool,
          reasoningEffortId: llm.ReasoningEffortId,
          delegationDepthOf: subagent.delegationDepthOf,
        },
      })
      const dispose = runtimeCtx.effect(() => runtimeCtx.tools.register(definition), 'agent-defs.delegation-tool')
      ctx.logger.info(`agent-defs: mounted \`${toolName}\` with ${String(candidates.length)} definition(s)`)
      return dispose
    })
    // Await the fiber so the caller observes a registered tool, and so a missing
    // service surfaces as a logged diagnostic instead of a silent no-op.
    void fiber.then(
      () => { if (mounted !== undefined) mounted.ready = true },
      error => ctx.logger.warn(`agent-defs: \`${toolName}\` did not mount: ${error instanceof Error ? error.message : String(error)}`),
    )
    mounted = { stop: async () => { await fiber.dispose() }, ready: false }
    currentKey = key
  }

  /**
   * Retire the mounted tool, if any.
   * @returns {Promise<void>} resolves after the fiber stopped.
   */
  const unmount = async () => {
    const previous = mounted
    mounted = undefined
    currentKey = ''
    if (previous !== undefined) await previous.stop()
  }

  return {
    refresh,
    serving,
    dispose: async () => {
      disposed = true
      await unmount()
    },
  }
}

/**
 * Mount the definition loader.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {Config} [config] - loader configuration.
 * @returns {Promise<void>} resolves after the first scan and the tool mount settled.
 */
export async function apply(ctx, config = {}) {
  const loader = createLoader(ctx, config)
  const exposeConfig = config.expose
  const expose = exposeConfig === false ? undefined : createExpose(ctx, exposeConfig ?? {}, loader)

  // Two tools compete for one decision, and the shipped one is mounted by the
  // preset inside an ancestor scope that a profile `disabled` row cannot reach.
  // Hiding it is what makes the replacement reachable at all, so the two halves
  // ship together. The gate keeps it honest: an empty definition directory
  // leaves the shipped tools alone rather than stranding the model.
  const hideConfig = config.hideOfficialTools
  const hiding = expose === undefined || hideConfig === false
    ? undefined
    : installOfficialToolHiding(ctx, {
      names: hideConfig?.names ?? DEFAULT_HIDDEN_TOOLS,
      replacement: exposeConfig?.toolName ?? 'subagent_defined',
      isActive: () => expose.serving(),
      stripPrompt: hideConfig?.stripPrompt !== false,
    })
  if (hiding !== undefined) {
    ctx.logger.info(`agent-defs: hiding ${DEFAULT_HIDDEN_TOOLS.join(', ')} while \`${exposeConfig?.toolName ?? 'subagent_defined'}\` serves`)
  }

  const runOnce = async () => {
    const result = await loader.reconcile()
    if (expose !== undefined && result.changed) await expose.refresh(result.ids)
    return result
  }

  // Diagnostic trace: a plugin that fails to appear is otherwise indistinguishable
  // from one that was never loaded, and this file is the only surface a running
  // host leaves behind for that question.
  const trace = (stage, detail = '') => {
    try {
      const line = `${new Date().toISOString()} ${stage}${detail === '' ? '' : ` ${detail}`}\n`
      appendFileSync(join(homedir(), '.dsh', 'agent-defs.trace.log'), line)
    } catch { /* diagnostics must never break the plugin */ }
  }
  trace('apply', `roots=${JSON.stringify(config.roots ?? [])} expose=${expose === undefined ? 'off' : 'on'}`)
  trace('build', `module=${import.meta.url} pid=${String(process.pid)} cwd=${process.cwd()}`)

  // Independent probe: prove the definition directory is readable from THIS
  // process, separately from the loader. A silent empty scan and an unreadable
  // directory look identical in `reconcile()`'s output.
  for (const root of loader.roots) {
    try {
      const probe = await readdir(root, { withFileTypes: true })
      trace('probe', `${root} -> ${String(probe.length)} entries: ${probe.map(entry => entry.name).join(',')}`)
    } catch (error) {
      trace('probe', `${root} -> FAILED ${String(error?.code)} ${error?.message ?? ''}`)
    }
  }

  // The delegation tool and the hiding depend on the definition FILES, not on
  // the preset registry: mount them first so a registry that is absent or late
  // cannot cost the model its only delegation path.
  const initial = await loader.reconcile()
  trace('scan', `roots=${JSON.stringify(loader.roots)} definitions=${JSON.stringify(initial.ids)}`)
  for (const line of loader.diagnostics) trace('  ', line)
  if (expose !== undefined) await expose.refresh(initial.ids)
  trace('expose', `serving=${String(expose?.serving() ?? false)}`)

  // Registration itself needs `agentPresets`. Waiting for it here rather than
  // declaring it as a plugin dependency is what keeps the two halves above
  // alive when the registry is missing or arrives after this plugin.
  ctx.inject(['agentPresets'], async () => {
    const result = await loader.reconcile()
    if (expose !== undefined && result.changed) await expose.refresh(result.ids)
    trace('presets', `registered=${JSON.stringify(result.ids)}`)
  })

  const watchIntervalMs = config.watchIntervalMs ?? DEFAULT_WATCH_INTERVAL_MS
  if (watchIntervalMs > 0) {
    const timer = setInterval(() => {
      // Before the registry exists `reconcile()` cannot register anything, and
      // the injected start above performs that first real scan.
      if (ctx.get('agentPresets') === undefined) return
      void runOnce().catch((error) => {
        ctx.logger.warn(`agent-defs: rescan failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }, watchIntervalMs)
    ctx.effect(() => () => clearInterval(timer), 'agent-defs.watch')
  }
  ctx.effect(() => () => {
    void (async () => {
      await expose?.dispose()
      await loader.dispose()
    })()
  }, 'agent-defs.registrations')
}
