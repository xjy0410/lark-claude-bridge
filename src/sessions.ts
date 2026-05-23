// Session persistence
// Maps chat_id -> Agent SDK session_id for resume support.
// Persists to disk so sessions survive process restarts.

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs'
import { dirname, resolve, join } from 'path'

interface SessionEntry {
  sessionId: string
  lastActive: string  // ISO 8601
}

export interface CliSession {
  pid: number
  sessionId: string
  cwd: string
  name?: string
  status?: string
  startedAt: number
  kind: string
  entrypoint: string
}

export interface HistoryEntry {
  display: string
  timestamp: number
  sessionId: string
}

export function isSessionBusy(sessionId: string): { busy: boolean; pid?: number; status?: string } {
  const sessDir = resolve(process.env.HOME ?? '.', '.claude', 'sessions')
  try {
    const files = readdirSync(sessDir).filter(f => f.endsWith('.json'))
    for (const file of files) {
      const data = JSON.parse(readFileSync(join(sessDir, file), 'utf-8'))
      if (data.sessionId === sessionId) {
        try { process.kill(data.pid, 0) } catch { return { busy: false } }
        return { busy: true, pid: data.pid, status: data.status ?? 'busy' }
      }
    }
  } catch {}
  return { busy: false }
}

let store: Record<string, SessionEntry> = {}
let savePath = './sessions.json'
let ttlMs = 7 * 24 * 60 * 60 * 1000

export function initSessions(path: string, ttl: number): void {
  savePath = path
  ttlMs = ttl
  load()
  // Clean expired sessions on load
  cleanup()
}

function load(): void {
  try {
    if (existsSync(savePath)) {
      store = JSON.parse(readFileSync(savePath, 'utf-8'))
    }
  } catch {
    store = {}
  }
}

function save(): void {
  const dir = dirname(savePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(savePath, JSON.stringify(store, null, 2))
}

function cleanup(): void {
  const now = Date.now()
  let changed = false
  for (const [chatId, entry] of Object.entries(store)) {
    const age = now - new Date(entry.lastActive).getTime()
    if (age > ttlMs) {
      delete store[chatId]
      changed = true
    }
  }
  if (changed) save()
}

export function getSessionId(chatId: string): string | undefined {
  const entry = store[chatId]
  if (!entry) return undefined
  // Check TTL
  const age = Date.now() - new Date(entry.lastActive).getTime()
  if (age > ttlMs) {
    delete store[chatId]
    save()
    return undefined
  }
  return entry.sessionId
}

export function setSessionId(chatId: string, sessionId: string): void {
  store[chatId] = {
    sessionId,
    lastActive: new Date().toISOString(),
  }
  save()
}

export function getAllSessions(): Record<string, SessionEntry> {
  return { ...store }
}

export function clearSession(chatId: string): void {
  delete store[chatId]
  save()
}

export function listCliSessions(): CliSession[] {
  const sessDir = resolve(process.env.HOME ?? '.', '.claude', 'sessions')
  try {
    const files = readdirSync(sessDir).filter(f => f.endsWith('.json'))
    const sessions: CliSession[] = []
    for (const file of files) {
      const data = JSON.parse(readFileSync(join(sessDir, file), 'utf-8'))
      try { process.kill(data.pid, 0) } catch { continue }
      sessions.push(data)
    }
    return sessions
  } catch { return [] }
}

export function getSessionContextSize(sessionId: string): string {
  const projectsDir = resolve(process.env.HOME ?? '.', '.claude', 'projects')
  if (!existsSync(projectsDir)) return '?'
  try {
    const dirs = readdirSync(projectsDir)
    for (const dir of dirs) {
      const filePath = join(projectsDir, dir, `${sessionId}.jsonl`)
      if (existsSync(filePath)) {
        const stat = Bun.file(filePath).size
        if (stat > 1024 * 1024) return `${(stat / 1024 / 1024).toFixed(1)}MB`
        return `${(stat / 1024).toFixed(0)}KB`
      }
    }
  } catch {}
  return '?'
}

export function getLastHistoryTime(sessionId: string): number | null {
  const histPath = resolve(process.env.HOME ?? '.', '.claude', 'history.jsonl')
  if (!existsSync(histPath)) return null
  try {
    const lines = readFileSync(histPath, 'utf-8').trim().split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].trim()) continue
      const d = JSON.parse(lines[i])
      if (d.sessionId === sessionId) return d.timestamp
    }
  } catch {}
  return null
}

export function getRecentHistory(sessionId: string, count = 3): HistoryEntry[] {
  const histPath = resolve(process.env.HOME ?? '.', '.claude', 'history.jsonl')
  if (!existsSync(histPath)) return []
  try {
    const lines = readFileSync(histPath, 'utf-8').trim().split('\n')
    const entries: HistoryEntry[] = []
    for (let i = lines.length - 1; i >= 0 && entries.length < count; i--) {
      if (!lines[i].trim()) continue
      const d = JSON.parse(lines[i])
      if (d.sessionId === sessionId && d.display) {
        entries.unshift({ display: d.display, timestamp: d.timestamp, sessionId: d.sessionId })
      }
    }
    return entries
  } catch { return [] }
}

export function getHistorySince(sessionId: string, sinceTs: number): HistoryEntry[] {
  const histPath = resolve(process.env.HOME ?? '.', '.claude', 'history.jsonl')
  if (!existsSync(histPath)) return []
  try {
    const lines = readFileSync(histPath, 'utf-8').trim().split('\n')
    const entries: HistoryEntry[] = []
    for (const line of lines) {
      if (!line.trim()) continue
      const d = JSON.parse(line)
      if (d.sessionId === sessionId && d.display && d.timestamp > sinceTs) {
        entries.push({ display: d.display, timestamp: d.timestamp, sessionId: d.sessionId })
      }
    }
    return entries
  } catch { return [] }
}
