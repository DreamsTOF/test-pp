/**
 * One delegation tool whose per-call child model comes from the selected
 * definition file, unless the parent model names a route itself.
 *
 * Why this exists instead of `allowedAgentPresets` on `dsh-tool-subagent`: a
 * preset selects a plugin composition, and `agentOptions` is a property of the
 * TOOL INSTANCE, not of the preset. So a definition's `model` can never reach
 * the child through the shipped tool — every child of one instance shares its
 * route. Registering our own tool makes the route a per-call decision:
 *
 * 1. the model calls with `agent_preset: <definition id>`;
 * 2. this module reads that definition's declared `model`;
 * 3. an explicit `provider`/`model`/`reasoning_effort` argument wins over it,
 *    so an unset definition still lets the parent choose;
 * 4. nothing named anywhere falls back to the parent's own route, which is what
 *    the shipped tool does when no default is configured.
 *
 * @module @local/dsh-agent-defs/delegate
 */

/**
 * Definition ids, routes, and descriptions the tool needs at call time.
 */
export class DefinitionRoutes {
  constructor() {
    /** @type {Map<string, { description: string, model?: { provider: string, model: string, reasoningEffort?: string } }>} */
    this.entries = new Map()
  }

  /**
   * Replace the whole live set. The tool's enum is rebuilt from this on remount.
   *
   * A definition whose `model` cannot be parsed loses only its DEFAULT route,
   * never its place in the enum: the file may name a model id with no provider
   * while the plugin has no `defaultProvider`, and the parent model can still
   * select that definition with an explicit route. Dropping the definition
   * instead would make one malformed `model:` line hide every other definition.
   * @param {Array<{ id: string, description: string, whenToUse?: string, model?: string, inherit?: boolean, persona?: string }>} definitions - compiled definitions in roster order.
   * @param {{ provider?: string }} [defaults] - provider assumed when a file names only a model id.
   * @returns {Array<{ id: string, problem: string }>} definitions whose default route was dropped.
   */
  replace(definitions, defaults = {}) {
    this.entries = new Map()
    const dropped = []
    for (const definition of definitions) {
      let route
      try {
        route = parseRoute(definition.model, defaults.provider)
      } catch (error) {
        dropped.push({ id: definition.id, problem: error instanceof Error ? error.message : String(error) })
        route = undefined
      }
      this.entries.set(definition.id, {
        description: definition.description,
        ...definition.whenToUse === undefined ? {} : { whenToUse: definition.whenToUse },
        ...definition.inherit === true ? { inherit: true } : {},
        ...definition.persona === undefined ? {} : { persona: definition.persona },
        ...route === undefined ? {} : { model: route },
      })
    }
    return dropped
  }

  /**
   * Whether this definition runs under the PARENT's composition.
   *
   * An inheriting definition names no tools, skills, or model, so the child joins
   * the parent's preset generation and only its persona is replaced. It then has
   * every tool, every skill, and the parent's model — which is what an authored
   * agent file describes. Every other definition gets an independent preset.
   * @param {string} id - definition id.
   * @returns {boolean} true when the child must join the parent instead of mounting a preset.
   */
  inherits(id) {
    return this.entries.get(id)?.inherit === true
  }

  /**
   * The persona an inheriting definition contributes, if it has one.
   * @param {string} id - definition id.
   * @returns {string | undefined} the persona text.
   */
  personaFor(id) {
    return this.entries.get(id)?.persona
  }

  /** @returns {string[]} definition ids in roster order. */
  ids() {
    return [...this.entries.keys()]
  }

  /**
   * The route a definition declares, if any.
   * @param {string} id - definition id.
   * @returns {{ provider: string, model: string, reasoningEffort?: string } | undefined} the declared route.
   */
  routeFor(id) {
    return this.entries.get(id)?.model
  }

  /**
   * Model-facing guidance listing what each definition is for.
   *
   * The definition list is the ONLY thing the parent model has to choose from,
   * so it is laid out to be scanned rather than parsed: one definition per line,
   * `when-to-use` separated from `description`, and no doubled terminators (a
   * description that already ends in `.` must not gain a second one).
   * @returns {string} the parameter description.
   */
  describe() {
    const lines = [...this.entries].map(([id, entry]) => {
      const what = trimTerminator(entry.description)
      const when = entry.whenToUse === undefined ? '' : `\n  Use when: ${trimTerminator(entry.whenToUse)}.`
      const model = entry.model === undefined ? '' : `\n  Default model: ${entry.model.provider}/${entry.model.model}.`
      return `- ${id}: ${what}.${when}${model}`
    })
    return 'Which agent definition runs this child. Choose by what you need done, not by id:\n'
      + `${lines.join('\n')}\n`
      + 'A definition with a default model uses it unless you pass `provider` and `model`; '
      + 'a definition without one inherits your route. If a default model is unavailable, pass your own route.'
  }
}

/**
 * Drop one trailing sentence terminator so a composed sentence has exactly one.
 * @param {string} text - the definition field.
 * @returns {string} the text without a trailing `.`, `!`, or `?`.
 */
function trimTerminator(text) {
  return text.trim().replace(/[.!?]+$/u, '')
}

/**
 * Read a definition's `model` value.
 *
 * Two accepted spellings keep the file readable: a bare model id, which uses
 * the configured default provider, and `provider/model`, which names both. The
 * bare form is the common case because a definition is usually written for one
 * deployment's provider.
 * @param {string | undefined} value - the frontmatter `model` string.
 * @param {string | undefined} defaultProvider - provider used by the bare form.
 * @returns {{ provider: string, model: string, reasoningEffort?: string } | undefined} the parsed route.
 */
export function parseRoute(value, defaultProvider) {
  if (value === undefined || value.trim() === '') return undefined
  const text = value.trim()
  const slash = text.indexOf('/')
  if (slash > 0 && slash < text.length - 1) {
    return { provider: text.slice(0, slash), model: text.slice(slash + 1) }
  }
  if (defaultProvider === undefined || defaultProvider === '') {
    throw new Error(
      `model "${text}" names no provider, and the plugin has no defaultProvider configured; write "provider/model" or set defaultProvider`,
    )
  }
  return { provider: defaultProvider, model: text }
}

/**
 * Merge the three route layers into the child options one call uses.
 *
 * Precedence, highest first: the model's explicit argument, the selected
 * definition's declared model, the tool instance's configured default. An
 * explicit route that differs from the definition's clears the definition's
 * effort, matching the shipped tool: a new model resolves its own default
 * rather than inheriting an effort chosen for another model.
 * @param {object} input - the three layers.
 * @param {{ provider?: string, model?: string, reasoning_effort?: string }} input.request - model-facing route fields.
 * @param {{ provider: string, model: string, reasoningEffort?: string } | undefined} input.declared - the definition's route.
 * @param {{ provider?: string, model?: string, reasoningEffort?: string } | undefined} input.configured - tool-instance defaults.
 * @param {(value: string) => string} [input.effortId] - adapter-owned effort brand; defaults to identity so this stays pure.
 * @returns {{ provider?: string, model?: string, reasoningEffort?: string } | undefined} child options, or undefined to inherit.
 */
export function resolveChildRoute({ request, declared, configured, effortId = value => value }) {
  const explicit = request.provider !== undefined || request.model !== undefined || request.reasoning_effort !== undefined
  if (explicit) {
    if ((request.provider === undefined) !== (request.model === undefined)) {
      throw new Error('child LLM `provider` and `model` must be supplied together')
    }
    const baseline = declared ?? configured
    const routeChanged = request.provider !== undefined
      && (request.provider !== baseline?.provider || request.model !== baseline?.model)
    const baselineOptions = toAgentOptions(baseline)
    const { reasoningEffort: _dropped, ...baselineWithoutEffort } = baselineOptions ?? {}
    return {
      ...routeChanged && request.reasoning_effort === undefined ? baselineWithoutEffort : baselineOptions ?? {},
      ...request.provider === undefined ? {} : { provider: request.provider, model: request.model },
      ...request.reasoning_effort === undefined ? {} : { reasoningEffort: effortId(request.reasoning_effort) },
    }
  }
  // An explicit request always names a route (validated above), so the object
  // built here is non-empty; only the inherited branch can be empty.
  return toAgentOptions(declared ?? configured)
}
/**
 * Project a route onto the exact `AgentOptions` fields a child accepts.
 *
 * `configured` doubles as the plugin's settings bag (it also carries `provider`
 * as the backend name and `maxDepth`), so passing it straight through would send
 * settings the child loop rejects. Only the three route fields cross this line.
 * @param {{ provider?: string, model?: string, reasoningEffort?: string } | undefined} route - resolved route.
 * @returns {{ provider?: string, model?: string, reasoningEffort?: string } | undefined} agent options, or undefined to inherit.
 */
function toAgentOptions(route) {
  if (route === undefined) return undefined
  const options = {
    ...route.provider === undefined ? {} : { provider: route.provider },
    ...route.model === undefined ? {} : { model: route.model },
    ...route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort },
  }
  // An empty layer must stay absent: `agentOptions: {}` would tell the child
  // "no route chosen" in a shape the provider still has to merge.
  return Object.keys(options).length === 0 ? undefined : options
}

/**
 * Build the delegation tool definition for one provider.
 *
 * The schema is regenerated per mount because `agent_preset` is an enum of the
 * definitions that exist right now; a definition added later reaches the model
 * only after a remount, which the loader performs when membership changes.
 * @param {object} options - registration inputs.
 * @param {string} options.toolName - model-facing tool name.
 * @param {DefinitionRoutes} options.routes - live definition routes.
 * @param {{ provider?: string, model?: string, reasoningEffort?: string, maxDepth?: number | 'provider-managed' }} [options.configured] - tool-instance defaults; `provider` here is the SUBAGENT BACKEND name, never an LLM route.
 * @param {{ provider?: string, model?: string, reasoningEffort?: string }} [options.routeDefaults] - LLM route used when nothing else names one.
 * @param {(name: string) => unknown} options.getProvider - resolves a registered provider.
 * @param {(request: object) => Promise<void>} options.resolveRoute - resolves the effective route through the live adapter.
 * @param {{ defineTool: Function, reasoningEffortId: Function, delegationDepthOf: Function }} options.host - host-provided factories.
 * @returns {object} the tool definition.
 */
export function createDelegationTool({ toolName, routes, configured, routeDefaults, getProvider, resolveRoute, host }) {
  const providerName = configured?.provider ?? 'spawn'
  return host.defineTool({
    name: toolName,
    description:
      'Delegate a self-contained task to a subagent (a separate agent that works in its own context) so it does not '
      + 'consume this conversation\'s context. The subagent returns its result, not its intermediate steps. '
      + '`agent_preset` selects which agent definition runs the child; each definition fixes its own tools, persona, '
      + 'and default model. Supply `provider` and `model` only to override the definition\'s default model.',
    parameters: {
      description: {
        type: 'string',
        required: true,
        description: 'A short (3-5 word) description of the delegated task, for display.',
      },
      prompt: {
        type: 'string',
        required: true,
        description: 'The complete, self-contained task for the subagent. It does not share this conversation\'s context, so include everything it needs.',
      },
      agent_preset: {
        type: 'string',
        required: true,
        enum: routes.ids(),
        description: routes.describe(),
      },
      provider: {
        type: 'string',
        description: 'Override the LLM provider for this child. Supply together with model; omit to use the definition\'s default model, then your own route.',
      },
      model: {
        type: 'string',
        description: 'Override the model id for this child. Supply together with provider; omit to use the definition\'s default model, then your own route.',
      },
      reasoning_effort: {
        type: 'string',
        description: 'Adapter-owned reasoning effort. Omit to use the definition\'s effort or the selected model\'s default.',
      },
      cwd: {
        type: 'string',
        description: 'Initial child working directory. Relative paths use your current directory; omitted inherits it.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, const: 'activation' },
          subagentId: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `started subagent ${value.subagentId}` }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec.agent
      if (parent === undefined) throw new Error(`${toolName} requires a calling agent (exec.agent was undefined)`)
      const provider = getProvider(providerName)
      if (provider === undefined) throw new Error(`no subagent provider "${providerName}" is registered`)

      const declared = routes.routeFor(args.agent_preset)
      const childOptions = resolveChildRoute({
        request: args,
        declared,
        configured: routeDefaults,
        effortId: host.reasoningEffortId,
      })      // Validate the route through the live adapter before a child exists, so an
      // unknown model fails the call instead of a background child.
      if (childOptions !== undefined) await resolveRoute(childOptions, exec.signal)

      const maxDepth = configured?.maxDepth
      const numericMaxDepth = typeof maxDepth === 'number' ? maxDepth : undefined
      if (numericMaxDepth !== undefined && host.delegationDepthOf(parent) >= numericMaxDepth) {
        throw new Error(`delegation depth for \`${toolName}\` is at its maximum of ${String(numericMaxDepth)}`)
      }
      exec.signal.throwIfAborted()
      // `agent.ctx.subagents` is a guarded property read: an Agent context does
      // not declare every service the tool reaches, and the property form throws
      // "cannot get property ... without inject". The getter form returns the
      // service the registry really has.
      const agentCtx = exec.agent.ctx
      const subagents = typeof agentCtx?.get === 'function' ? agentCtx.get('subagents') : undefined
      if (subagents === undefined) throw new Error(`${toolName} requires the subagents service, which this agent context does not see`)

      // Two shapes, decided by the definition itself:
      //  - inheriting: no `agentPreset`, so the child joins the parent's current
      //    generation and keeps every tool, skill, and the parent's route; only
      //    the persona is replaced. This is what a file naming no tools means.
      //  - independent: the preset carries the child's own composition.
      const inherits = routes.inherits(args.agent_preset)
      const persona = inherits ? routes.personaFor(args.agent_preset) : undefined
      const started = await subagents.startActivation({
        provider: providerName,
        label: args.description,
        request: {
          prompt: [{ type: 'text', text: args.prompt }],
          parent,
          ...inherits ? {} : { agentPreset: args.agent_preset },
          ...persona === undefined ? {} : { persona },
          ...args.cwd === undefined ? {} : { cwd: args.cwd },
          ...childOptions === undefined ? {} : { agentOptions: childOptions },
          ...numericMaxDepth === undefined ? {} : { maxDepth: numericMaxDepth },
        },
        signal: exec.signal,
        delivery: 'parent',
      })
      return { kind: 'activation', subagentId: started.childId }
    },
  })
}
