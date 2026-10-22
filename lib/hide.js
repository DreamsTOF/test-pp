/**
 * Hide the shipped delegation tools while our own delegation tool is serving.
 *
 * Two tools compete for the same decision. The shipped `subagent` row is
 * mounted by the Web presets inside the preset's own scope — an ANCESTOR of
 * every agent bound to that preset — so a profile-level `disabled: true` cannot
 * reach it, and `tools.restrict()` only works from that exact agent scope. Left
 * alone, the model sees both and picks the one whose description it learned
 * first; ours loses.
 *
 * The dependable surface is request assembly, which is what agent-loop's
 * `buildRequest` reads:
 *
 * 1. `system-prompt/assemble` removes the hidden schemas and every prompt
 *    sentence that names them, so the model never learns they exist and no
 *    `tool-addition`/`tool-removal` message is logged.
 * 2. A `tools.guard()` denial covers the residual paths the assembly filter
 *    cannot reach: a PTC program binding a name from `registry.schemas()`, or a
 *    session holding a schema assembled before the swap.
 *
 * Hiding is gated on {@link OfficialToolHidingOptions.isActive}: a deployment
 * whose definition directory is empty keeps the shipped tools rather than
 * leaving the model with no way to delegate at all.
 *
 * @module @local/dsh-agent-defs/hide
 */

/** Shipped delegation tools, in the order they are usually named. */
export const DEFAULT_HIDDEN_TOOLS = ['subagent', 'subagent_fork']

/**
 * Escape a literal tool name for the mention pattern, so a name such as `read`
 * never matches inside `already`.
 * @param {string} name - tool name.
 * @returns {string} the escaped source.
 */
function escapeRegExp(name) {
  return name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/**
 * Net `{` minus `}` on one line.
 * @param {string} line - source line.
 * @returns {number} the depth change.
 */
function braceDelta(line) {
  let depth = 0
  for (const character of line) {
    if (character === '{') depth += 1
    else if (character === '}') depth -= 1
  }
  return depth
}

/**
 * Drop every mention of a hidden tool while keeping the rest of the text valid.
 *
 * Prose lines carry several sentences, so only the mentioning sentences go. The
 * PTC `tools:sdk` declaration carries one binding per line, possibly spanning
 * several lines for object arguments, so the whole brace-balanced block goes —
 * deleting only its first line would leave an orphaned type body.
 * @param {string} text - one prompt section's text.
 * @param {readonly string[]} names - tool names to erase.
 * @returns {string} the text unchanged when nothing mentions them, else the remainder.
 */
export function stripMentions(text, names) {
  if (names.length === 0) return text
  const pattern = new RegExp(`(?<![A-Za-z0-9_])(?:${names.map(escapeRegExp).join('|')})(?![A-Za-z0-9_])`, 'u')
  if (!pattern.test(text)) return text
  const lines = text.split('\n')
  const kept = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!pattern.test(line)) {
      kept.push(line)
      continue
    }
    const sentences = line.split(/(?<=[.!?])\s+/)
    if (sentences.length > 1) {
      kept.push(sentences.filter(sentence => !pattern.test(sentence)).join(' '))
      continue
    }
    // HACK: counts raw braces, so a brace inside a string literal on the same
    // line over-counts. Generated SDK types quote no braces today.
    let depth = braceDelta(line)
    while (depth > 0 && index + 1 < lines.length) {
      index += 1
      depth += braceDelta(lines[index])
    }
  }
  return kept.join('\n').trim()
}

/**
 * @typedef {object} OfficialToolHidingOptions
 * @property {readonly string[]} names - tool names to hide.
 * @property {string} replacement - tool name the denial points at.
 * @property {() => boolean} isActive - whether our delegation tool currently serves.
 * @property {boolean} [stripPrompt] - also erase prompt mentions. Defaults to true.
 */

/**
 * Hide the shipped delegation tools for as long as `isActive()` holds.
 *
 * The registrations are permanent; the gate is read on every assembly and every
 * guarded call, so mounting or retiring the replacement tool needs no listener
 * churn.
 *
 * The assembly listener is registered immediately, because a prompt can be
 * assembled before the tool registry settles. The guard needs `ctx.tools`, so it
 * waits for that service rather than throwing during plugin load — an unguarded
 * `ctx.tools` read aborts the whole plugin and takes the replacement tool with
 * it, which is a silent total failure rather than a degraded one.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {OfficialToolHidingOptions} options - what to hide and when.
 * @returns {{ denial: string }} the denial text, for tests and diagnostics.
 */
export function installOfficialToolHiding(ctx, options) {
  const names = [...new Set(options.names)]
  const stripPrompt = options.stripPrompt !== false
  const denial = `\`${names.join('` / `')}\` is disabled in this profile. `
    + `Delegate with \`${options.replacement}\` instead: it selects an agent definition, which fixes the child's tools, `
    + 'persona, and default model. Supply `agent_preset`; add `provider` and `model` only to override the definition\'s model.'

  ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
    const result = await next()
    if (!options.isActive()) return result
    if (Array.isArray(result.tools)) {
      result.tools = result.tools.filter(tool => !names.includes(tool.name))
    }
    if (stripPrompt && Array.isArray(result.sections)) {
      result.sections = result.sections
        .map(section => typeof section.text === 'string'
          ? { ...section, text: stripMentions(section.text, names) }
          : section)
        // A section that only carried the hidden guidance must not survive as an
        // empty heading: the shipped delegation section is one sentence naming
        // exactly these tools.
        .filter(section => typeof section.text !== 'string' || section.text !== '')
    }
    return result
  })

  ctx.inject(['tools'], (toolsCtx) => {
    toolsCtx.tools.guard(exec => (options.isActive() && names.includes(exec.name) ? denial : undefined))
  })

  return { denial }
}
