// Configuration loader and chat_id routing
// Loads settings from config.yaml and agent definitions from ~/.lark-channel/agents/*.md

import { readFileSync, existsSync, readdirSync } from 'fs'
import { resolve, join } from 'path'
import YAML from 'yaml'

export interface ScheduleConfig {
  cron: string
  prompt: string
}

export interface GroupConfig {
  chatId: string
  name: string
  cwd: string
  persona: string
  permissionMode: string
  schedule: ScheduleConfig[]
  sessionId?: string
  isManager?: boolean
}

export interface Settings {
  sessionTtl: string
  maxConcurrent: number
  defaultModel: string
  python: string
}

export interface AccessConfig {
  policy: 'open' | 'allowlist'
  allowedSenders: string[]
}

export interface AppConfig {
  settings: Settings
  access: AccessConfig
  groups: GroupConfig[]
}

function expandHome(p: string): string {
  if (p.startsWith('~/')) {
    return resolve(process.env.HOME ?? '~', p.slice(2))
  }
  return p
}

// Parse YAML frontmatter from a markdown file.
// Returns { meta: parsed frontmatter, body: text after second --- }
function parseFrontmatter(content: string): { meta: Record<string, unknown>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return { meta: {}, body: content }
  try {
    return { meta: YAML.parse(match[1]) ?? {}, body: match[2].trim() }
  } catch {
    return { meta: {}, body: content }
  }
}

// Load the shared Feishu workspace capabilities block (_feishu_workspace.md)
function loadWorkspaceBlock(agentsDir: string): string {
  const path = join(agentsDir, '_feishu_workspace.md')
  if (!existsSync(path)) return ''
  try {
    return readFileSync(path, 'utf-8').trim()
  } catch {
    return ''
  }
}

// Load all agent .md files from a directory.
// Files starting with _ are shared context, not agent definitions.
function loadAgentFiles(agentsDir: string, workspaceBlock: string): GroupConfig[] {
  if (!existsSync(agentsDir)) return []
  const groups: GroupConfig[] = []

  const files = readdirSync(agentsDir)
    .filter(f => f.endsWith('.md') && !f.startsWith('_'))
    .sort()

  for (const file of files) {
    const filePath = join(agentsDir, file)
    try {
      const content = readFileSync(filePath, 'utf-8')
      const { meta, body } = parseFrontmatter(content)

      const chatId = meta.chat_id as string
      if (!chatId || chatId === 'MANAGER_CHAT_ID_PLACEHOLDER') continue

      // Compose persona: agent-specific body + shared Feishu workspace block
      const persona = workspaceBlock
        ? `${body}\n\n---\n\n${workspaceBlock}`
        : body

      const schedule: ScheduleConfig[] = ((meta.schedule as Array<Record<string, string>>) ?? []).map(s => ({
        cron: s.cron,
        prompt: s.prompt,
      }))

      groups.push({
        chatId,
        name: (meta.name as string) ?? file.replace('.md', ''),
        cwd: expandHome((meta.cwd as string) ?? '.'),
        persona,
        permissionMode: (meta.permission_mode as string) ?? 'default',
        schedule,
        sessionId: (meta.session_id as string) ?? undefined,
        isManager: (meta.is_manager as boolean) ?? false,
      })
    } catch (err) {
      console.error(`[router] Failed to load agent file ${file}: ${err}`)
    }
  }

  return groups
}

export function loadConfig(configPath: string): AppConfig {
  const fullPath = resolve(configPath)
  if (!existsSync(fullPath)) {
    throw new Error(`Config file not found: ${fullPath}\nCopy config.example.yaml to config.yaml and customize it.`)
  }

  const raw = readFileSync(fullPath, 'utf-8')
  const doc = YAML.parse(raw)

  const settings: Settings = {
    sessionTtl: doc.settings?.session_ttl ?? '7d',
    maxConcurrent: doc.settings?.max_concurrent ?? 10,
    defaultModel: doc.settings?.default_model ?? 'claude-sonnet-4-6',
    python: doc.settings?.python ?? 'python3',
  }

  const access: AccessConfig = {
    policy: doc.access?.policy ?? 'open',
    allowedSenders: doc.access?.allowed_senders ?? [],
  }

  // Load agent definitions from ~/.lark-channel/agents/
  const agentsDir = expandHome(doc.settings?.agents_dir ?? '~/.lark-channel/agents')
  const workspaceBlock = loadWorkspaceBlock(agentsDir)
  const agentGroups = loadAgentFiles(agentsDir, workspaceBlock)

  // Also support inline groups in config.yaml (legacy / override)
  const inlineGroups: GroupConfig[] = (doc.groups ?? []).map((g: Record<string, unknown>) => ({
    chatId: g.chat_id as string,
    name: g.name as string,
    cwd: expandHome((g.cwd as string) ?? '.'),
    persona: (g.persona as string) ?? '',
    permissionMode: (g.permission_mode as string) ?? 'default',
    schedule: ((g.schedule as Array<Record<string, string>>) ?? []).map(s => ({
      cron: s.cron,
      prompt: s.prompt,
    })),
  })).filter((g: GroupConfig) => g.chatId)

  // Agent files take precedence; inline groups fill any gaps
  const chatIdsSeen = new Set(agentGroups.map(g => g.chatId))
  const merged = [
    ...agentGroups,
    ...inlineGroups.filter(g => !chatIdsSeen.has(g.chatId)),
  ]

  return { settings, access, groups: merged }
}

const routeMap = new Map<string, GroupConfig>()

export function initRoutes(groups: GroupConfig[]): void {
  routeMap.clear()
  for (const g of groups) {
    routeMap.set(g.chatId, g)
  }
}

export function routeChat(chatId: string): GroupConfig | null {
  return routeMap.get(chatId) ?? null
}

export function getAllGroups(): GroupConfig[] {
  return [...routeMap.values()]
}

export function parseTtl(ttl: string): number {
  const match = ttl.match(/^(\d+)([dhms])$/)
  if (!match) return 7 * 24 * 60 * 60 * 1000
  const value = parseInt(match[1], 10)
  switch (match[2]) {
    case 'd': return value * 24 * 60 * 60 * 1000
    case 'h': return value * 60 * 60 * 1000
    case 'm': return value * 60 * 1000
    case 's': return value * 1000
    default: return 7 * 24 * 60 * 60 * 1000
  }
}
