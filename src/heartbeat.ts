// Heartbeat module — multi-terminal status via Feishu doc
// Each terminal periodically writes its status to a shared doc,
// then updates a pinned message in the manager group with all terminals' status.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { fetchDoc, updateDoc, sendCard, pinMessage, patchMessage } from './lark.js'
import { listCliSessions } from './sessions.js'

interface TerminalStatus {
  name: string
  status: 'online' | 'offline'
  lastSeen: string
  sessions: number
}

interface HeartbeatState {
  pinMessageId: string | null
  docToken: string | null
}

const OFFLINE_THRESHOLD_MS = 10 * 60 * 1000 // 10 minutes
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes

let state: HeartbeatState = { pinMessageId: null, docToken: null }
let statePath = ''
let terminalName = ''
let heartbeatDocUrl = ''
let managerChatId = ''
let timer: ReturnType<typeof setInterval> | null = null

export function initHeartbeat(opts: {
  terminalName: string
  heartbeatDoc: string
  managerChatId: string
  stateDir: string
}): void {
  terminalName = opts.terminalName
  heartbeatDocUrl = opts.heartbeatDoc
  managerChatId = opts.managerChatId
  statePath = `${opts.stateDir}/heartbeat.json`

  if (!heartbeatDocUrl || !managerChatId) return

  loadState()
  // Initial heartbeat
  doHeartbeat().catch(err => console.error(`[heartbeat] initial error: ${err}`))
  // Schedule recurring
  timer = setInterval(() => {
    doHeartbeat().catch(err => console.error(`[heartbeat] error: ${err}`))
  }, HEARTBEAT_INTERVAL_MS)
}

export function stopHeartbeat(): void {
  if (timer) { clearInterval(timer); timer = null }
}

function loadState(): void {
  try {
    if (existsSync(statePath)) {
      state = JSON.parse(readFileSync(statePath, 'utf-8'))
    }
  } catch { state = { pinMessageId: null, docToken: null } }
}

function saveState(): void {
  const dir = dirname(statePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(statePath, JSON.stringify(state, null, 2))
}

function parseDocContent(content: string): TerminalStatus[] {
  const lines = content.trim().split('\n').filter(l => l.includes('|'))
  return lines.map(line => {
    const [name, status, lastSeen, sessionsStr] = line.split('|')
    return {
      name: name.trim(),
      status: (status?.trim() === 'online' ? 'online' : 'offline') as 'online' | 'offline',
      lastSeen: lastSeen?.trim() ?? new Date().toISOString(),
      sessions: parseInt(sessionsStr?.replace(/\D/g, '') ?? '0', 10),
    }
  })
}

function serializeStatuses(statuses: TerminalStatus[]): string {
  return statuses.map(s => `${s.name}|${s.status}|${s.lastSeen}|sessions:${s.sessions}`).join('\n')
}

function buildStatusCard(statuses: TerminalStatus[]): object {
  const lines = statuses.map(s => {
    const time = new Date(s.lastSeen).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
    const icon = s.status === 'online' ? '🟢' : '🔴'
    const sess = s.sessions > 0 ? `${s.sessions} session${s.sessions !== 1 ? 's' : ''}` : 'idle'
    return `${icon} **${s.name}** (${sess}, ${time})`
  })
  return {
    config: { wide_screen_mode: true },
    elements: [{ tag: 'markdown', content: lines.join('\n') || '*No terminals registered*' }],
  }
}

async function doHeartbeat(): Promise<void> {
  // 1. Read current doc content
  const docResult = await fetchDoc(heartbeatDocUrl)
  let statuses: TerminalStatus[] = []
  if (docResult.ok && docResult.stdout.trim()) {
    statuses = parseDocContent(docResult.stdout)
  }

  // 2. Update own entry
  const sessionCount = listCliSessions().filter(s => s.status === 'busy').length
  const now = new Date().toISOString()
  const idx = statuses.findIndex(s => s.name === terminalName)
  const entry: TerminalStatus = { name: terminalName, status: 'online', lastSeen: now, sessions: sessionCount }
  if (idx >= 0) {
    statuses[idx] = entry
  } else {
    statuses.push(entry)
  }

  // 3. Mark stale terminals as offline
  const threshold = Date.now() - OFFLINE_THRESHOLD_MS
  for (const s of statuses) {
    if (s.name !== terminalName && new Date(s.lastSeen).getTime() < threshold) {
      s.status = 'offline'
    }
  }

  // 4. Write back to doc
  const newContent = serializeStatuses(statuses)
  await updateDoc(heartbeatDocUrl, newContent)

  // 5. Update pinned message in manager group
  const card = buildStatusCard(statuses)
  if (state.pinMessageId) {
    await patchMessage(state.pinMessageId, card)
  } else {
    const msgId = await sendCard(managerChatId, card)
    if (msgId) {
      state.pinMessageId = msgId
      await pinMessage(msgId)
      saveState()
    }
  }
}

export { TerminalStatus }
