#!/usr/bin/env bun
// lark-channel: Feishu/Lark <-> Claude Code Agent collaboration bridge
//
// Architecture:
//   Feishu WebSocket (lark-cli event subscribe)
//     -> Bridge (NDJSON parser)
//     -> Router (chat_id -> group config from YAML)
//     -> Queue (per-group serial, cross-group parallel)
//     -> Agent (Python SDK subprocess with session resume)
//     -> Reply Engine (Reaction + Card + PATCH streaming)
//     -> lark-cli (send/reply)
//     -> Feishu group chat

import { resolve } from 'path'
import { loadConfig, initRoutes, routeChat, parseTtl, type GroupConfig } from './router.js'
import { startBridge, type LarkEvent } from './bridge.js'
import { getQueue } from './queue.js'
import { queryAgent, setPythonPath } from './agent.js'
import { handleAgentResponse } from './reply.js'
import { initAccess, isSenderAllowed, handleUnauthorized, resolvePairingCode, addSender, setAccessPolicy, getAllowed } from './access.js'
import { initSessions, getSessionId, setSessionId, listCliSessions, getRecentHistory, getSessionContextSize, getLastHistoryTime, getHistorySince, getAllSessions, isSessionBusy } from './sessions.js'
import { startPatrol, stopPatrol } from './patrol.js'
import { initHeartbeat, stopHeartbeat } from './heartbeat.js'
import { sendText, sendCard, dissolveChat } from './lark.js'

// Resolve config path from CLI arg or default
const configPath = process.argv[2] || './config.yaml'

function log(msg: string): void {
  console.error(`[lark-channel] ${msg}`)
}

function formatTimeAgo(ts: number): string {
  const diff = Date.now() - ts
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

async function main(): Promise<void> {
  log('Starting...')

  // 1. Load configuration
  const config = loadConfig(configPath)
  log(`Loaded ${config.groups.length} group(s) from ${configPath}`)

  // 2. Initialize subsystems
  const stateDir = resolve(process.env.HOME ?? '.', '.lark-channel')
  initRoutes(config.groups)
  initAccess(config.access, resolve(stateDir, 'access.json'))
  initSessions(resolve(stateDir, 'sessions.json'), parseTtl(config.settings.sessionTtl))
  setPythonPath(config.settings.python)

  const tn = config.settings.terminalName



  // 3. Admin command handler (messages starting with special prefixes)
  function handleAdminCommand(event: LarkEvent, group: GroupConfig): boolean {
    const text = event.content.trim().toLowerCase()

    // "sessions" quick command — only in manager group
    if (text === 'sessions' && group.isManager) {
      const cliSessions = listCliSessions()
      const feishuSessions = getAllSessions()
      const feishuSessionIds = new Set(Object.values(feishuSessions).map(s => s.sessionId))
      const cliSessionIds = new Set(cliSessions.map(s => s.sessionId))

      const lines: string[] = [`**Sessions [${tn}]:**\n`]

      // CLI-only sessions
      const cliOnly = cliSessions.filter(s => !feishuSessionIds.has(s.sessionId))
      // Shared sessions (in both CLI and Feishu)
      const shared = cliSessions.filter(s => feishuSessionIds.has(s.sessionId))
      // Feishu-only sessions
      const feishuOnly = Object.entries(feishuSessions).filter(([_, s]) => !cliSessionIds.has(s.sessionId))

      let idx = 1
      if (shared.length > 0) {
        lines.push('**Shared (CLI + Feishu):**')
        for (const s of shared) {
          const name = s.name ? ` "${s.name}"` : ''
          const status = s.status ? `[${s.status}]` : ''
          const id = s.sessionId.slice(0, 8)
          const size = getSessionContextSize(s.sessionId)
          const lastTs = getLastHistoryTime(s.sessionId)
          const timeAgo = lastTs ? formatTimeAgo(lastTs) : '?'
          const chatId = Object.entries(feishuSessions).find(([_, v]) => v.sessionId === s.sessionId)?.[0]
          const groupName = chatId ? routeChat(chatId)?.name ?? '' : ''
          lines.push(`**${idx}.** ${status} \`${id}\`${name}  (${size}, ${timeAgo})`)
          lines.push(`  cwd: ${s.cwd}${groupName ? `  group: ${groupName}` : ''}`)
          idx++
        }
        lines.push('')
      }

      if (cliOnly.length > 0) {
        lines.push('**CLI only:**')
        for (const s of cliOnly) {
          const name = s.name ? ` "${s.name}"` : ''
          const status = s.status ? `[${s.status}]` : ''
          const id = s.sessionId.slice(0, 8)
          const size = getSessionContextSize(s.sessionId)
          const lastTs = getLastHistoryTime(s.sessionId)
          const timeAgo = lastTs ? formatTimeAgo(lastTs) : '?'
          lines.push(`**${idx}.** ${status} \`${id}\`${name}  (${size}, ${timeAgo})`)
          lines.push(`  cwd: ${s.cwd}`)
          idx++
        }
        lines.push('')
      }

      if (feishuOnly.length > 0) {
        lines.push('**Feishu only:**')
        for (const [chatId, s] of feishuOnly) {
          const id = s.sessionId.slice(0, 8)
          const size = getSessionContextSize(s.sessionId)
          const groupName = routeChat(chatId)?.name ?? chatId.slice(0, 12)
          const timeAgo = formatTimeAgo(new Date(s.lastActive).getTime())
          lines.push(`**${idx}.** \`${id}\`  (${size}, ${timeAgo})`)
          lines.push(`  group: ${groupName}`)
          idx++
        }
        lines.push('')
      }

      if (idx === 1) lines.push('*(none active)*\n')

      lines.push('---')
      lines.push('`use <N>` 接管  |  `new` 新建  |  `help` 命令列表')
      const card = {
        config: { wide_screen_mode: true },
        elements: [{ tag: 'markdown', content: lines.join('\n') }],
      }
      sendCard(event.chat_id, card)
      return true
    }

    // "use <N>" command — show session info and prompt for takeover
    const useMatch = text.match(/^use\s+(?:session\s+)?(\d+)$/)
    if (useMatch && group.isManager) {
      const idx = parseInt(useMatch[1], 10) - 1
      const cliSessions = listCliSessions()
      if (idx < 0 || idx >= cliSessions.length) {
        sendText(event.chat_id, `Invalid index. Use \`sessions\` to see available sessions (1-${cliSessions.length}).`)
        return true
      }
      const s = cliSessions[idx]
      const name = s.name ? ` "${s.name}"` : ''
      const size = getSessionContextSize(s.sessionId)
      const history = getRecentHistory(s.sessionId, 3)
      const histLines = history.map(h => `> ${h.display.length > 50 ? h.display.slice(0, 50) + '...' : h.display}`)
      const lines = [
        `**Session ${idx + 1}:** \`${s.sessionId.slice(0, 8)}\`${name}  (${size})`,
        `cwd: ${s.cwd}`,
        '',
        ...histLines,
        '',
        '---',
        `To takeover, send:  \`takeover ${idx + 1} <group name>\``,
        'Example:  `takeover 1 debug-payment`',
      ]
      const card = {
        config: { wide_screen_mode: true },
        elements: [{ tag: 'markdown', content: lines.join('\n') }],
      }
      sendCard(event.chat_id, card)
      return true
    }

    // "takeover <N> <name>" command — create group and bind session
    const takeoverMatch = text.match(/^takeover\s+(\d+)\s+(.+)$/)
    if (takeoverMatch && group.isManager) {
      const idx = parseInt(takeoverMatch[1], 10) - 1
      const groupName = takeoverMatch[2].trim()
      const cliSessions = listCliSessions()
      if (idx < 0 || idx >= cliSessions.length) {
        sendText(event.chat_id, `Invalid index.`)
        return true
      }
      const s = cliSessions[idx]
      const displayName = `${groupName} [${tn}]`
      const slug = groupName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

      // Create group, add user, write config, restart — via agent
      const instructions = [
        `Execute these steps to takeover session \`${s.sessionId}\`:`,
        `1. Create group: lark-cli im +chat-create --name "${displayName}" --description "Takeover ${s.sessionId.slice(0, 8)}" --type private --set-bot-manager --as bot`,
        `2. Add user: lark-cli api POST /open-apis/im/v1/chats/{chat_id}/members --data '{"id_list":["${event.sender_id}"],"member_id_type":"open_id"}' --as bot`,
        `3. Write config to ~/.lark-channel/agents/${slug}.md with:`,
        `   chat_id: {new chat_id}`,
        `   name: ${slug}`,
        `   cwd: ${s.cwd}`,
        `   permission_mode: bypassPermissions`,
        `   session_id: ${s.sessionId}`,
        `   persona: 你正在继续一个已有的 Claude Code 会话。保持之前的上下文和工作风格。用用户的语言回复，回复简洁。`,
        `4. Restart: launchctl unload ~/Library/LaunchAgents/com.xu.lark-channel.plist && launchctl load ~/Library/LaunchAgents/com.xu.lark-channel.plist`,
        `5. Confirm to user that workspace "${displayName}" is ready.`,
      ].join('\n')
      // Pass to manager agent to execute
      getQueue(event.chat_id).enqueue(async () => {
        try {
          const sessionId = getSessionId(event.chat_id) ?? group.sessionId
          const chunks = queryAgent({
            message: instructions,
            sessionId,
            persona: group.persona,
            cwd: group.cwd,
            permissionMode: group.permissionMode,
            model: config.settings.defaultModel,
          })
          const result = await handleAgentResponse(event.message_id, event.chat_id, chunks, tn)
          if (result.sessionId) setSessionId(event.chat_id, result.sessionId)
        } catch (err) {
          log(`Error in takeover: ${err}`)
        }
      })
      return true
    }

    // "new <name>" command — create fresh workspace
    const newMatch = text.match(/^new\s+(.+)$/)
    if (newMatch && group.isManager) {
      const groupName = newMatch[1].trim()
      const displayName = `${groupName} [${tn}]`
      const slug = groupName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

      const instructions = [
        `Create a new workspace "${displayName}":`,
        `1. Create group: lark-cli im +chat-create --name "${displayName}" --type private --set-bot-manager --as bot`,
        `2. Add user: lark-cli api POST /open-apis/im/v1/chats/{chat_id}/members --data '{"id_list":["${event.sender_id}"],"member_id_type":"open_id"}' --as bot`,
        `3. Create workspace dir: mkdir -p ~/.lark-channel/workspaces/${slug}`,
        `4. Write config to ~/.lark-channel/agents/${slug}.md with:`,
        `   chat_id: {new chat_id}`,
        `   name: ${slug}`,
        `   cwd: ~/.lark-channel/workspaces/${slug}`,
        `   permission_mode: bypassPermissions`,
        `   persona: 你是一个全能助手 Agent。用用户的语言回复，回复简洁。`,
        `5. Restart: launchctl unload ~/Library/LaunchAgents/com.xu.lark-channel.plist && launchctl load ~/Library/LaunchAgents/com.xu.lark-channel.plist`,
        `6. Confirm to user that workspace "${displayName}" is ready.`,
      ].join('\n')
      getQueue(event.chat_id).enqueue(async () => {
        try {
          const sessionId = getSessionId(event.chat_id) ?? group.sessionId
          const chunks = queryAgent({
            message: instructions,
            sessionId,
            persona: group.persona,
            cwd: group.cwd,
            permissionMode: group.permissionMode,
            model: config.settings.defaultModel,
          })
          const result = await handleAgentResponse(event.message_id, event.chat_id, chunks, tn)
          if (result.sessionId) setSessionId(event.chat_id, result.sessionId)
        } catch (err) {
          log(`Error in new workspace: ${err}`)
        }
      })
      return true
    }

    // "help" command — only in manager group
    if (text === 'help' && group.isManager) {
      const helpLines = [
        '**Session Manager Commands:**\n',
        '`sessions` — list all active CLI sessions',
        '`use <N>` — view session N details',
        `\`takeover <N> <name>\` — takeover session N, create group "<name> [${tn}]"`,
        `\`new <name>\` — create new workspace "<name> [${tn}]"`,
        '`help` — show this message',
      ]
      const card = {
        config: { wide_screen_mode: true },
        elements: [{ tag: 'markdown', content: helpLines.join('\n') }],
      }
      sendCard(event.chat_id, card)
      return true
    }

    // "help" command — workspace groups
    if (text === 'help' && !group.isManager) {
      const helpLines = [
        '**Workspace Commands:**\n',
        '`update` — show CLI activity since last interaction',
        '`watch` — view current session status',
        '`fork` — fork session, continue independently',
        '`kill-cli` — terminate CLI process, take over here',
        '`end` — end workspace (dissolve group, stop session)',
      ]
      const card = {
        config: { wide_screen_mode: true },
        elements: [{ tag: 'markdown', content: helpLines.join('\n') }],
      }
      sendCard(event.chat_id, card)
      return true
    }

    // Pairing: "pair xxxxx"
    const pairMatch = text.match(/^pair\s+([a-km-z]{5})$/i)
    if (pairMatch) {
      const entry = resolvePairingCode(pairMatch[1])
      if (entry) {
        sendText(event.chat_id, `Sender ${entry.senderId} approved.`)
      }
      return true
    }

    // Policy: "access policy open" or "access policy allowlist"
    if (text === 'access policy open' || text === 'access policy allowlist') {
      const p = text.endsWith('open') ? 'open' : 'allowlist'
      setAccessPolicy(p as 'open' | 'allowlist')
      return true
    }

    // List allowed: "access list"
    if (text === 'access list') {
      const list = getAllowed()
      sendText(event.chat_id, list.length > 0 ? list.join('\n') : '(none)')
      return true
    }

    // "update" command — show CLI activity since last feishu interaction, works in any group
    if (text === 'update') {
      const boundSessionId = getSessionId(event.chat_id) ?? group.sessionId
      if (!boundSessionId) {
        sendText(event.chat_id, 'No session bound to this group.')
        return true
      }
      const allSessions = getAllSessions()
      const entry = allSessions[event.chat_id]
      const sinceTs = entry ? new Date(entry.lastActive).getTime() : 0
      const newEntries = getHistorySince(boundSessionId, sinceTs)
      if (newEntries.length === 0) {
        sendText(event.chat_id, 'No new CLI activity since last interaction here.')
        return true
      }
      const lines = [`**CLI updates since ${formatTimeAgo(sinceTs)}** (${newEntries.length} messages):\n`]
      for (const h of newEntries.slice(-10)) {
        const display = h.display.length > 70 ? h.display.slice(0, 70) + '...' : h.display
        const time = formatTimeAgo(h.timestamp)
        lines.push(`[${time}] ${display}`)
      }
      if (newEntries.length > 10) {
        lines.push(`\n... and ${newEntries.length - 10} more`)
      }
      lines.push('\n---')
      lines.push('Context is auto-synced. Your next message will include all CLI updates.')
      const card = {
        config: { wide_screen_mode: true },
        elements: [{ tag: 'markdown', content: lines.join('\n') }],
      }
      sendCard(event.chat_id, card)
      return true
    }

    // "fork" command — fork current session into a new independent session
    if (text === 'fork') {
      // Clear the stored session so next message creates a fresh one with fork
      const boundSessionId = getSessionId(event.chat_id) ?? group.sessionId
      if (!boundSessionId) {
        sendText(event.chat_id, 'No session bound to this group.')
        return true
      }
      // Store a fork marker — next agent call will use fork_session
      pendingForks.add(event.chat_id)
      sendText(event.chat_id, 'Next message will fork from the current session context. Send your message now.')
      return true
    }

    // "kill-cli" command — terminate CLI process occupying the session
    if (text === 'kill-cli' || text === 'kill cli') {
      const boundSessionId = getSessionId(event.chat_id) ?? group.sessionId
      if (!boundSessionId) {
        sendText(event.chat_id, 'No session bound to this group.')
        return true
      }
      const state = isSessionBusy(boundSessionId)
      if (!state.busy || !state.pid) {
        sendText(event.chat_id, 'CLI session is not running.')
        return true
      }
      sendText(event.chat_id, `Terminating CLI process (pid: ${state.pid})...`)
      try {
        process.kill(state.pid, 'SIGTERM')
        sendText(event.chat_id, 'CLI process terminated. You can now use this session from Feishu.')
      } catch (err) {
        sendText(event.chat_id, `Failed to kill process: ${err}`)
      }
      return true
    }

    // "watch" command — show recent session file tail
    if (text === 'watch') {
      const boundSessionId = getSessionId(event.chat_id) ?? group.sessionId
      if (!boundSessionId) {
        sendText(event.chat_id, 'No session bound to this group.')
        return true
      }
      const state = isSessionBusy(boundSessionId)
      const statusText = state.busy ? `CLI is **running** (pid: ${state.pid}, status: ${state.status})` : 'CLI is **idle**'
      const history = getRecentHistory(boundSessionId, 5)
      const lines = [statusText, '']
      if (history.length > 0) {
        lines.push('**Recent activity:**')
        for (const h of history) {
          const display = h.display.length > 60 ? h.display.slice(0, 60) + '...' : h.display
          const time = formatTimeAgo(h.timestamp)
          lines.push(`[${time}] ${display}`)
        }
      }
      const card = {
        config: { wide_screen_mode: true },
        elements: [{ tag: 'markdown', content: lines.join('\n') }],
      }
      sendCard(event.chat_id, card)
      return true
    }

    // "end" command — dissolve workspace group (not manager/assistant)
    if (text === 'end' && !group.isManager) {
      pendingEnds.add(event.chat_id)
      const card = {
        config: { wide_screen_mode: true },
        elements: [
          { tag: 'markdown', content: '**Are you sure you want to end this workspace?**\n\nThis will dissolve the group chat and stop the background session. Context is preserved and can be resumed later.' },
          { tag: 'hr' },
          { tag: 'markdown', content: 'Send `confirm end` to proceed, or anything else to cancel.' },
        ],
      }
      sendCard(event.chat_id, card)
      return true
    }

    if (text === 'confirm end' && pendingEnds.has(event.chat_id) && !group.isManager) {
      pendingEnds.delete(event.chat_id)
      // Stop CLI process if running
      const boundSessionId = getSessionId(event.chat_id) ?? group.sessionId
      if (boundSessionId) {
        const state = isSessionBusy(boundSessionId)
        if (state.busy && state.pid) {
          try { process.kill(state.pid, 'SIGTERM') } catch {}
        }
      }
      sendText(event.chat_id, 'Workspace ended. Context preserved. Dissolving group...')
      setTimeout(() => { dissolveChat(event.chat_id).catch(() => {}) }, 2000)
      return true
    }

    // Cancel pending end if any other message
    if (pendingEnds.has(event.chat_id) && text !== 'confirm end') {
      pendingEnds.delete(event.chat_id)
    }

    return false
  }

  // Track pending fork requests and end confirmations
  const pendingForks = new Set<string>()
  const pendingEnds = new Set<string>()

  // 4. Start Lark event bridge
  const bridge = startBridge(
    (event: LarkEvent) => {
      const group = routeChat(event.chat_id)
      if (!group) return // unconfigured group, ignore

      // Check admin commands first
      if (handleAdminCommand(event, group)) return

      // Access control
      if (!isSenderAllowed(event.sender_id)) {
        handleUnauthorized(event.chat_id, event.sender_id)
        return
      }

      // Enqueue for processing (serial within group)
      getQueue(event.chat_id).enqueue(async () => {
        try {
          let sessionId = getSessionId(event.chat_id) ?? group.sessionId
          let forkSession = false

          // Check if this is a fork request
          if (pendingForks.has(event.chat_id)) {
            pendingForks.delete(event.chat_id)
            forkSession = true
          }

          // Check if session is busy (occupied by CLI)
          if (sessionId && !forkSession) {
            const state = isSessionBusy(sessionId)
            if (state.busy) {
              const history = getRecentHistory(sessionId, 3)
              const histLines = history.map(h => `> ${h.display.length > 50 ? h.display.slice(0, 50) + '...' : h.display}`)
              const lines = [
                `**Session is occupied by CLI** (pid: ${state.pid}, status: ${state.status})`,
                '',
                ...histLines,
                '',
                '---',
                '**Options:**',
                '`watch` — view current CLI activity',
                '`fork` — fork session, continue independently',
                '`kill-cli` — terminate CLI process, take over here',
              ]
              const card = {
                config: { wide_screen_mode: true },
                elements: [{ tag: 'markdown', content: lines.join('\n') }],
              }
              sendCard(event.chat_id, card)
              return
            }
          }

          // If forking, pass fork flag to agent
          const chunks = queryAgent({
            message: event.content,
            sessionId: forkSession ? sessionId : sessionId,
            persona: group.persona,
            cwd: group.cwd,
            permissionMode: group.permissionMode,
            model: config.settings.defaultModel,
            forkSession,
          })

          const result = await handleAgentResponse(
            event.message_id,
            event.chat_id,
            chunks,
            tn,
          )

          if (result.sessionId) {
            setSessionId(event.chat_id, result.sessionId)
          }
        } catch (err) {
          log(`Error processing message in ${group.name}: ${err}`)
        }
      })
    },
    {
      onError: (err) => log(err),
    },
  )

  // 5. Start scheduled patrols
  startPatrol(config.groups, config.settings)

  // 5.5 Start heartbeat
  const managerGroup = config.groups.find(g => g.isManager)
  if (managerGroup && config.settings.heartbeatDoc) {
    initHeartbeat({
      terminalName: tn,
      heartbeatDoc: config.settings.heartbeatDoc,
      managerChatId: managerGroup.chatId,
      stateDir: stateDir,
    })
  }

  // 6. Graceful shutdown
  const shutdown = () => {
    log('Shutting down...')
    stopHeartbeat()
    stopPatrol()
    bridge.kill()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  log('Ready. Listening for Feishu messages...')
}

main().catch((err) => {
  log(`Fatal: ${err}`)
  process.exit(1)
})
