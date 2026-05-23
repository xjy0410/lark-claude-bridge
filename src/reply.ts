// Feishu reply engine — multi-block streaming
//
// Each logical block becomes a separate reply in the thread:
//   text segment → streaming text card, PATCH-updated per token
//   tool call    → compact tool card, sent once when input is complete
//   done/error   → small summary card
//
// Text card layout: no header, raw markdown content (headings converted to bold)
// Tool card layout: colored header (tool type), body shows command/target
//
// Feishu card markdown limitations handled here:
//   ## headings  → **bold**
//   leading/trailing blank lines stripped before push

import { addReaction, replyCard, patchMessage, sendCard, pinMessage, unpinMessage } from './lark.js'
import type { AgentChunk } from './agent.js'

type CardColor = 'blue' | 'green' | 'red' | 'purple' | 'indigo' | 'turquoise' | 'wathet' | 'orange'

const EMOJI = {
  received: 'OK',
  done: 'DONE',
  error: 'BANGBANG',
} as const

const MAX_CARD_CONTENT = 3500

// -- PatchScheduler --
// One PATCH in-flight at a time. Latest-wins queuing.

class PatchScheduler {
  private inFlight = false
  private queued: object | null = null
  private cardMessageId: string | null = null

  bind(id: string): void { this.cardMessageId = id }

  push(card: object): void {
    if (!this.cardMessageId) return
    if (this.inFlight) { this.queued = card; return }
    this.fire(card)
  }

  async flush(card: object): Promise<void> {
    if (!this.cardMessageId) return
    while (this.inFlight) await new Promise(r => setTimeout(r, 30))
    this.queued = null
    await patchMessage(this.cardMessageId, card)
  }

  private fire(card: object): void {
    if (!this.cardMessageId) return
    this.inFlight = true
    patchMessage(this.cardMessageId, card).finally(() => {
      this.inFlight = false
      if (this.queued) { const next = this.queued; this.queued = null; this.fire(next) }
    })
  }
}

// -- Markdown preprocessing --
// Converts markdown constructs unsupported by Feishu card markdown.

function feishuMd(text: string): string {
  return text
    .replace(/^#{1,6}\s+(.+)$/gm, '**$1**')  // headings → bold
    .replace(/^\n+/, '')                        // strip leading blank lines
}

// -- Card builders --

function textCard(content: string): object {
  const md = feishuMd(content).trim()
  return {
    config: { wide_screen_mode: true },
    elements: [{ tag: 'markdown', content: md || '*...*' }],
  }
}

interface ToolSpec { header: string; body: string; color: CardColor }

function parseToolUse(raw: string): ToolSpec {
  const colonIdx = raw.indexOf(':')
  if (colonIdx === -1) {
    return toolSpec(raw.trim(), '', 'blue')
  }
  const tool = raw.slice(0, colonIdx).trim()
  const rest = raw.slice(colonIdx + 1).trim()
  let input: Record<string, unknown> = {}
  try { input = JSON.parse(rest) } catch {
    return toolSpec(tool, rest.slice(0, 300), 'blue')
  }

  switch (tool) {
    case 'Bash':
      return toolSpec('Bash', String(input.command ?? '').replace(/\s+/g, ' ').trim().slice(0, 500), 'orange')
    case 'Read':
      return toolSpec('Read', basename(String(input.file_path ?? '')), 'blue')
    case 'Write':
      return toolSpec('Write', basename(String(input.file_path ?? '')), 'blue')
    case 'Edit':
      return toolSpec('Edit', basename(String(input.file_path ?? '')), 'blue')
    case 'Grep':
      return toolSpec('Grep', String(input.pattern ?? '').slice(0, 100), 'turquoise')
    case 'Glob':
      return toolSpec('Glob', String(input.pattern ?? ''), 'turquoise')
    case 'WebSearch':
      return toolSpec('Search', String(input.query ?? '').slice(0, 120), 'wathet')
    case 'WebFetch':
      return toolSpec('Fetch', String(input.url ?? '').slice(0, 200), 'wathet')
    case 'Task':
      return toolSpec('Agent Task', String(input.description ?? '').slice(0, 150), 'purple')
    case 'Agent':
      return toolSpec('Agent', String(input.description ?? '').slice(0, 150), 'purple')
    case 'TaskCreate':
      return toolSpec('Task', String(input.subject ?? '').slice(0, 100), 'indigo')
    case 'TaskUpdate':
      return toolSpec('Task', String(input.subject ?? input.status ?? '').slice(0, 100), 'indigo')
    case 'TaskList':
    case 'TaskGet':
      return toolSpec('Task', '', 'indigo')
    default:
      return toolSpec(tool, rest.slice(0, 200), 'blue')
  }
}

function toolSpec(header: string, body: string, color: CardColor): ToolSpec {
  return { header, body, color }
}


interface CollapsedTool {
  spec: ToolSpec
  result?: string
}

function buildCollapsiblePanel(tool: CollapsedTool): object {
  const bodyElements: object[] = []
  if (tool.spec.body) {
    bodyElements.push({ tag: 'markdown', content: '```\n' + tool.spec.body + '\n```' })
  }
  if (tool.result) {
    bodyElements.push({ tag: 'markdown', content: tool.result })
  }
  if (bodyElements.length === 0) {
    bodyElements.push({ tag: 'markdown', content: '*completed*' })
  }
  return {
    tag: 'collapsible_panel',
    expanded: false,
    background_color: 'grey',
    header: {
      title: { tag: 'markdown', content: `**${tool.spec.header}**${tool.spec.body ? ' `' + tool.spec.body.slice(0, 40) + (tool.spec.body.length > 40 ? '...' : '') + '`' : ''}` },
      vertical_align: 'center',
    },
    body: { elements: bodyElements },
  }
}


function buildResultPreview(content: string, lineCount: number, spec: ToolSpec, isError: boolean): string {
  if (isError) {
    const lines = content.trim().split('\n').filter(l => l.trim()).slice(-4)
    return '**Error**\n```\n' + lines.join('\n') + '\n```'
  }

  const lines = content.split('\n')
  const nonEmpty = lines.filter(l => l.trim())

  switch (spec.header) {
    case 'Read':
      return `*${lineCount} line${lineCount !== 1 ? 's' : ''}*`
    case 'Write':
    case 'Edit':
      return `*${lineCount} line${lineCount !== 1 ? 's' : ''} written*`
    case 'Grep':
    case 'Glob':
      return nonEmpty.length > 0
        ? `*${nonEmpty.length} result${nonEmpty.length !== 1 ? 's' : ''}*`
        : '*no results*'
    case 'Search':
      return `*${nonEmpty.length} result${nonEmpty.length !== 1 ? 's' : ''}*`
    case 'Agent Task':
    case 'Agent':
      // Sub-agent result can be long; show first 2 lines only
      return nonEmpty.slice(0, 2).join('\n') + (nonEmpty.length > 2 ? '\n*...*' : '')
    case 'Bash': {
      if (nonEmpty.length === 0) return '*no output*'
      const preview = nonEmpty.slice(0, 6).join('\n')
      const extra = nonEmpty.length > 6 ? `\n*... ${nonEmpty.length - 6} more lines*` : ''
      return '```\n' + preview + extra + '\n```'
    }
    default: {
      const first = nonEmpty[0]?.slice(0, 150) ?? ''
      return first ? '`' + first + '`' : ''
    }
  }
}


function errorCard(content: string): object {
  let display = content || 'Unknown error'
  if (display.includes('Traceback (most recent call last)')) {
    const lines = display.trim().split('\n')
    const meaningful = lines.filter(l => l.trim() && !l.startsWith('  ')).slice(-4)
    display = meaningful.join('\n') || display.slice(-500)
  }
  if (display.length > 800) display = display.slice(-800)
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: 'Error' }, template: 'red' as CardColor },
    elements: [{ tag: 'markdown', content: '```\n' + display + '\n```' }],
  }
}

function basename(p: string): string { return p.split('/').pop() || p }

// -- URL extraction for action buttons --

interface ActionButton { label: string; url: string; type: 'primary' | 'default' }

function extractActionButtons(text: string): ActionButton[] {
  const buttons: ActionButton[] = []
  const seen = new Set<string>()
  const add = (label: string, url: string, type: 'primary' | 'default') => {
    if (!seen.has(url) && buttons.length < 4) { seen.add(url); buttons.push({ label, url, type }) }
  }

  const feishuPattern = /https:\/\/[a-z0-9-]+\.feishu\.cn\/(docx|wiki|sheets|base|file)\/[A-Za-z0-9_?=&-]+/g
  for (const m of text.matchAll(feishuPattern)) {
    const url = m[0].replace(/[)>\].,]+$/, '')
    const kind = m[1]
    const label = kind === 'docx' || kind === 'wiki' ? 'Open Doc'
                : kind === 'sheets' ? 'Open Sheet'
                : kind === 'base' ? 'Open Base' : 'Open File'
    add(label, url, 'primary')
  }

  const ghPattern = /https:\/\/github\.com\/[^\s)>\]]+\/(?:pull|issues)\/\d+/g
  for (const m of text.matchAll(ghPattern)) {
    const url = m[0].replace(/[)>\].,]+$/, '')
    const label = url.includes('/pull/') ? `View PR #${url.split('/').pop()}` : `Issue #${url.split('/').pop()}`
    add(label, url, 'default')
  }

  return buttons
}

// -- Active text block --
// Manages the in-flight streaming text card.


export interface ReplyResult { sessionId?: string }

// Status pin management — one pinned message per chat showing current state
const statusPins = new Map<string, string>() // chatId → pinned messageId

async function updateStatus(chatId: string, status: string): Promise<void> {
  const card = {
    config: { wide_screen_mode: true },
    elements: [{ tag: 'note', elements: [{ tag: 'plain_text', content: status }] }],
  }
  const existing = statusPins.get(chatId)
  if (existing) {
    patchMessage(existing, card).catch(() => {})
  } else {
    const id = await sendCard(chatId, card)
    if (id) {
      statusPins.set(chatId, id)
      pinMessage(id).catch(() => {})
    }
  }
}

async function clearStatus(chatId: string): Promise<void> {
  const existing = statusPins.get(chatId)
  if (existing) {
    unpinMessage(existing).catch(() => {})
    statusPins.delete(chatId)
  }
}

interface Step {
  text: string
  tools: CollapsedTool[]
  cardId: string | null
  patcher: PatchScheduler | null
}

function buildStepCard(step: Step, opts: { isFinal: boolean; startMs: number; totalTools: number; buttons: ActionButton[] }): object {
  const elements: object[] = []

  // Text content on top
  if (step.text.trim()) {
    let display = feishuMd(step.text).trim()
    if (display.length > MAX_CARD_CONTENT) display = display.slice(0, MAX_CARD_CONTENT) + '\n\n*...(truncated)*'
    elements.push({ tag: 'markdown', content: display })
  }

  // Collapsed tool panels below
  if (step.tools.length > 0) {
    if (step.text.trim()) elements.push({ tag: 'hr' })
    for (const tool of step.tools) {
      elements.push(buildCollapsiblePanel(tool))
    }
  }

  if (elements.length === 0) {
    elements.push({ tag: 'markdown', content: '*(done)*' })
  }

  // Final step gets buttons + footer
  if (opts.isFinal) {
    if (opts.buttons.length > 0) {
      elements.push({ tag: 'hr' })
      elements.push({
        tag: 'action',
        actions: opts.buttons.map(b => ({
          tag: 'button',
          text: { tag: 'plain_text', content: b.label },
          type: b.type,
          url: b.url,
        })),
      })
    }
    const s = Math.round((Date.now() - opts.startMs) / 1000)
    const elapsed = s > 0 ? `${s}s` : ''
    const toolNote = opts.totalTools > 0 ? `${opts.totalTools} tool${opts.totalTools !== 1 ? 's' : ''}` : ''
    const footer = [toolNote, elapsed].filter(Boolean).join(' · ')
    if (footer) {
      elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: footer }] })
    }
  }

  return { config: { wide_screen_mode: true }, elements }
}

export async function handleAgentResponse(
  messageId: string,
  chatId: string,
  agentChunks: AsyncGenerator<AgentChunk>,
): Promise<ReplyResult> {
  const startMs = Date.now()
  addReaction(messageId, EMOJI.received).catch(() => {})
  updateStatus(chatId, 'thinking...').catch(() => {})

  let sessionId: string | undefined
  let hasError = false
  let totalTools = 0
  let lastToolSpec: ToolSpec | null = null

  // Step management
  const flushedSteps: Step[] = []
  let current: Step = { text: '', tools: [], cardId: null, patcher: null }

  const ensureStepCard = async () => {
    if (current.cardId) return
    current.cardId = await replyCard(messageId, textCard('*...*'))
    if (current.cardId) {
      current.patcher = new PatchScheduler()
      current.patcher.bind(current.cardId)
    }
  }

  const flushStep = async () => {
    if (!current.text.trim() && current.tools.length === 0) return
    await ensureStepCard()
    if (current.patcher) {
      const card = buildStepCard(current, { isFinal: false, startMs, totalTools, buttons: [] })
      await current.patcher.flush(card)
    }
    flushedSteps.push(current)
    current = { text: '', tools: [], cardId: null, patcher: null }
  }

  try {
    for await (const chunk of agentChunks) {
      switch (chunk.type) {

        case 'text': {
          // New text after tools completed → new step
          if (current.tools.length > 0) {
            await flushStep()
          }
          current.text += chunk.content
          await ensureStepCard()
          current.patcher?.push(textCard(current.text))
          break
        }

        case 'tool_use': {
          totalTools++
          const spec = parseToolUse(chunk.content)
          lastToolSpec = spec
          current.tools.push({ spec })
          await ensureStepCard()
          updateStatus(chatId, `running: ${spec.header}${spec.body ? ' ' + spec.body.slice(0, 30) : ''}...`).catch(() => {})
          // Show working state on current card
          const workingText = current.text || `*Working... (${current.tools.length} tool${current.tools.length !== 1 ? 's' : ''})*`
          current.patcher?.push(textCard(workingText))
          break
        }

        case 'tool_result': {
          if (lastToolSpec && chunk.content) {
            const preview = buildResultPreview(
              chunk.content,
              chunk.lineCount ?? chunk.content.split('\n').length,
              lastToolSpec,
              chunk.isError ?? false,
            )
            const last = current.tools[current.tools.length - 1]
            if (last && preview) last.result = preview
          }
          break
        }

        case 'result': {
          sessionId = chunk.sessionId
          break
        }

        case 'error': {
          hasError = true
          addReaction(messageId, EMOJI.error).catch(() => {})
          clearStatus(chatId).catch(() => {})
          if (current.patcher) {
            await current.patcher.flush(errorCard(chunk.content))
          } else {
            await replyCard(messageId, errorCard(chunk.content))
          }
          return { sessionId }
        }
      }
    }
  } catch (err) {
    hasError = true
    addReaction(messageId, EMOJI.error).catch(() => {})
    clearStatus(chatId).catch(() => {})
    if (current.patcher) {
      await current.patcher.flush(errorCard(String(err)))
    } else {
      await replyCard(messageId, errorCard(String(err)))
    }
    return { sessionId }
  }

  if (!hasError) {
    await ensureStepCard()
    const buttons = extractActionButtons(current.text)
    const card = buildStepCard(current, { isFinal: true, startMs, totalTools, buttons })
    if (current.patcher) {
      await current.patcher.flush(card)
    }
    addReaction(messageId, EMOJI.done).catch(() => {})
    clearStatus(chatId).catch(() => {})
  }

  return { sessionId }
}

// Patrol / scheduled report card
export async function sendReportCard(chatId: string, title: string, content: string): Promise<void> {
  let display = feishuMd(content).trim()
  if (display.length > MAX_CARD_CONTENT) display = display.slice(0, MAX_CARD_CONTENT) + '\n\n*...(truncated)*'
  await sendCard(chatId, {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: title }, template: 'purple' as CardColor },
    elements: [{ tag: 'markdown', content: display }],
  })
}
