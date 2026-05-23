// lark-cli command wrapper
// All Feishu/Lark operations go through lark-cli subprocess calls.
// Uses the Go binary directly (bypassing the Node.js wrapper) for lower latency.

import { spawn } from 'bun'
import { existsSync, readlinkSync } from 'fs'
import { resolve, dirname } from 'path'

function resolveLarkCliBinary(): string {
  try {
    const wrapper = Bun.which('lark-cli')
    if (!wrapper) return 'lark-cli'
    let scriptPath = wrapper
    try {
      const link = readlinkSync(wrapper)
      scriptPath = resolve(dirname(wrapper), link)
    } catch {}
    // scriptPath is the Node.js wrapper (scripts/run.js); Go binary is at ../bin/lark-cli
    const gobin = resolve(dirname(scriptPath), '..', 'bin', 'lark-cli')
    if (existsSync(gobin)) return gobin
  } catch {}
  return 'lark-cli'
}

const LARK_CLI = resolveLarkCliBinary()

export interface ExecResult {
  ok: boolean
  stdout: string
  stderr: string
}

export async function exec(args: string[]): Promise<ExecResult> {
  const proc = spawn([LARK_CLI, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const code = await proc.exited
  return { ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim() }
}

// -- Reactions (via raw API, no lark-cli shortcut) --

export async function addReaction(messageId: string, emoji: string): Promise<ExecResult> {
  return exec([
    'api', 'POST',
    `/open-apis/im/v1/messages/${messageId}/reactions`,
    '--data', JSON.stringify({ reaction_type: { emoji_type: emoji } }),
    '--as', 'bot',
  ])
}

export async function removeReaction(messageId: string, reactionId: string): Promise<ExecResult> {
  return exec([
    'api', 'DELETE',
    `/open-apis/im/v1/messages/${messageId}/reactions/${reactionId}`,
    '--as', 'bot',
  ])
}

// -- Message Sending --

export async function sendText(chatId: string, text: string): Promise<ExecResult> {
  return exec(['im', '+messages-send', '--chat-id', chatId, '--text', text, '--as', 'bot'])
}

export async function sendMarkdown(chatId: string, markdown: string): Promise<ExecResult> {
  return exec(['im', '+messages-send', '--chat-id', chatId, '--markdown', markdown, '--as', 'bot'])
}

export async function replyText(messageId: string, text: string): Promise<ExecResult> {
  return exec(['im', '+messages-reply', '--message-id', messageId, '--text', text, '--as', 'bot'])
}

export async function replyMarkdown(messageId: string, markdown: string): Promise<ExecResult> {
  return exec(['im', '+messages-reply', '--message-id', messageId, '--markdown', markdown, '--as', 'bot'])
}

// -- Card Messages (Interactive) --

export async function sendCard(chatId: string, card: object): Promise<string | null> {
  const result = await exec([
    'im', '+messages-send',
    '--chat-id', chatId,
    '--msg-type', 'interactive',
    '--content', JSON.stringify(card),
    '--as', 'bot',
  ])
  if (!result.ok) return null
  try {
    return JSON.parse(result.stdout).data?.message_id ?? null
  } catch {
    return null
  }
}

export async function replyCard(messageId: string, card: object): Promise<string | null> {
  const result = await exec([
    'im', '+messages-reply',
    '--message-id', messageId,
    '--msg-type', 'interactive',
    '--content', JSON.stringify(card),
    '--as', 'bot',
  ])
  if (!result.ok) return null
  try {
    return JSON.parse(result.stdout).data?.message_id ?? null
  } catch {
    return null
  }
}

// -- Message PATCH (for streaming card updates, raw API) --

export async function patchMessage(messageId: string, card: object): Promise<ExecResult> {
  return exec([
    'api', 'PATCH',
    `/open-apis/im/v1/messages/${messageId}`,
    '--data', JSON.stringify({
      msg_type: 'interactive',
      content: JSON.stringify(card),
    }),
    '--as', 'bot',
  ])
}

// -- File Messages --

export async function sendFile(chatId: string, filePath: string): Promise<ExecResult> {
  return exec(['im', '+messages-send', '--chat-id', chatId, '--file', filePath, '--as', 'bot'])
}

export async function sendImage(chatId: string, imagePath: string): Promise<ExecResult> {
  return exec(['im', '+messages-send', '--chat-id', chatId, '--image', imagePath, '--as', 'bot'])
}

// -- Chat Operations --

export async function searchMessages(
  query: string,
  options: { chatId?: string; pageLimit?: number } = {},
): Promise<ExecResult> {
  const args = ['im', '+messages-search', '--query', query, '--as', 'user']
  if (options.chatId) args.push('--chat-id', options.chatId)
  if (options.pageLimit) args.push('--page-limit', String(options.pageLimit))
  args.push('--format', 'json')
  return exec(args)
}

export async function getChatMessages(
  chatId: string,
  options: { start?: string; end?: string; pageSize?: number } = {},
): Promise<ExecResult> {
  const args = ['im', '+chat-messages-list', '--chat-id', chatId, '--as', 'bot']
  if (options.start) args.push('--start', options.start)
  if (options.end) args.push('--end', options.end)
  if (options.pageSize) args.push('--page-size', String(options.pageSize))
  args.push('--format', 'json')
  return exec(args)
}

// -- Calendar --

export async function getAgenda(options: { start?: string; end?: string } = {}): Promise<ExecResult> {
  const args = ['calendar', '+agenda', '--as', 'user']
  if (options.start) args.push('--start', options.start)
  if (options.end) args.push('--end', options.end)
  args.push('--format', 'json')
  return exec(args)
}

export async function createCalendarEvent(
  summary: string,
  start: string,
  end: string,
  options: { attendees?: string; description?: string } = {},
): Promise<ExecResult> {
  const args = ['calendar', '+create', '--summary', summary, '--start', start, '--end', end, '--as', 'user']
  if (options.attendees) args.push('--attendees', options.attendees)
  if (options.description) args.push('--description', options.description)
  args.push('--format', 'json')
  return exec(args)
}

// -- Tasks --

export async function getMyTasks(options: { dueEnd?: string } = {}): Promise<ExecResult> {
  const args = ['task', '+get-my-tasks', '--as', 'user']
  if (options.dueEnd) args.push('--due-end', options.dueEnd)
  args.push('--format', 'json')
  return exec(args)
}

// -- Docs --

export async function createDoc(
  title: string,
  markdown: string,
  options: { folderToken?: string } = {},
): Promise<ExecResult> {
  const args = ['docs', '+create', '--title', title, '--markdown', markdown, '--as', 'user']
  if (options.folderToken) args.push('--folder-token', options.folderToken)
  args.push('--format', 'json')
  return exec(args)
}

export async function fetchDoc(docUrl: string): Promise<ExecResult> {
  return exec(['docs', '+fetch', '--doc', docUrl])
}

export async function updateDoc(docUrl: string, markdown: string): Promise<ExecResult> {
  return exec(['docs', '+update', '--doc', docUrl, '--markdown', markdown, '--mode', 'overwrite'])
}

export async function searchDocs(query: string, options: { pageLimit?: number } = {}): Promise<ExecResult> {
  const args = ['docs', '+search', '--query', query, '--as', 'user']
  if (options.pageLimit) args.push('--page-limit', String(options.pageLimit))
  args.push('--format', 'json')
  return exec(args)
}

// -- Contact --

export async function searchUser(query: string): Promise<ExecResult> {
  const args = ['contact', '+search-user', '--query', query, '--as', 'user', '--format', 'json']
  return exec(args)
}

// -- VC/Minutes --

export async function searchMeetings(
  options: { start?: string; end?: string; query?: string } = {},
): Promise<ExecResult> {
  const args = ['vc', '+search', '--as', 'user']
  if (options.start) args.push('--start', options.start)
  if (options.end) args.push('--end', options.end)
  if (options.query) args.push('--query', options.query)
  args.push('--format', 'json')
  return exec(args)
}

export async function getMeetingNotes(meetingIds: string): Promise<ExecResult> {
  return exec(['vc', '+notes', '--meeting-ids', meetingIds, '--as', 'user', '--format', 'json'])
}

// -- CardKit 2.0 Streaming --

export async function createCardKitCard(cardJson: object): Promise<string | null> {
  const result = await exec([
    'api', 'POST',
    '/open-apis/cardkit/v1/cards',
    '--data', JSON.stringify({ type: 'card_json', data: JSON.stringify(cardJson) }),
    '--as', 'bot',
  ])
  if (!result.ok) return null
  try {
    return JSON.parse(result.stdout).data?.card_id ?? null
  } catch {
    return null
  }
}

export async function streamCardKitElement(
  cardId: string,
  elementId: string,
  content: string,
  sequence: number,
): Promise<ExecResult> {
  return exec([
    'api', 'PUT',
    `/open-apis/cardkit/v1/cards/${cardId}/elements/${elementId}/content`,
    '--data', JSON.stringify({ content, sequence }),
    '--as', 'bot',
  ])
}

export async function setCardKitStreamingMode(
  cardId: string,
  streaming: boolean,
  sequence: number,
): Promise<ExecResult> {
  return exec([
    'api', 'PUT',
    `/open-apis/cardkit/v1/cards/${cardId}/settings`,
    '--data', JSON.stringify({ settings: JSON.stringify({ streaming_mode: streaming }), sequence }),
    '--as', 'bot',
  ])
}

// -- Pin Messages --

export async function pinMessage(messageId: string): Promise<ExecResult> {
  return exec([
    'api', 'POST',
    '/open-apis/im/v1/pins',
    '--data', JSON.stringify({ message_id: messageId }),
    '--as', 'bot',
  ])
}

export async function unpinMessage(messageId: string): Promise<ExecResult> {
  return exec([
    'api', 'DELETE',
    `/open-apis/im/v1/pins/${messageId}`,
    '--as', 'bot',
  ])
}

// -- Chat Announcements (via description) --

export async function setChatDescription(chatId: string, description: string): Promise<ExecResult> {
  return exec([
    'api', 'PUT',
    `/open-apis/im/v1/chats/${chatId}`,
    '--data', JSON.stringify({ description }),
    '--as', 'bot',
  ])
}

// -- Dissolve Chat --

export async function dissolveChat(chatId: string): Promise<ExecResult> {
  return exec([
    'api', 'DELETE',
    `/open-apis/im/v1/chats/${chatId}`,
    '--as', 'bot',
  ])
}

export async function updateCardKit(
  cardId: string,
  cardJson: object,
  sequence: number,
): Promise<ExecResult> {
  return exec([
    'api', 'PUT',
    `/open-apis/cardkit/v1/cards/${cardId}`,
    '--data', JSON.stringify({ card: { type: 'card_json', data: JSON.stringify(cardJson) }, sequence }),
    '--as', 'bot',
  ])
}

export async function replyCardByCardId(messageId: string, cardId: string): Promise<string | null> {
  const result = await exec([
    'im', '+messages-reply',
    '--message-id', messageId,
    '--msg-type', 'interactive',
    '--content', JSON.stringify({ type: 'card', data: { card_id: cardId } }),
    '--as', 'bot',
  ])
  if (!result.ok) return null
  try {
    return JSON.parse(result.stdout).data?.message_id ?? null
  } catch {
    return null
  }
}

export async function sendCardByCardId(chatId: string, cardId: string): Promise<string | null> {
  const result = await exec([
    'im', '+messages-send',
    '--chat-id', chatId,
    '--msg-type', 'interactive',
    '--content', JSON.stringify({ type: 'card', data: { card_id: cardId } }),
    '--as', 'bot',
  ])
  if (!result.ok) return null
  try {
    return JSON.parse(result.stdout).data?.message_id ?? null
  } catch {
    return null
  }
}

// -- Raw API --

export async function rawApi(
  method: string,
  path: string,
  options: { data?: string; params?: string; as?: string } = {},
): Promise<ExecResult> {
  const args = ['api', method, path]
  if (options.data) args.push('--data', options.data)
  if (options.params) args.push('--params', options.params)
  args.push('--as', options.as ?? 'bot')
  args.push('--format', 'json')
  return exec(args)
}
