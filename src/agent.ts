// Agent SDK integration
// Spawns Python subprocess to run Claude Code Agent via claude-agent-sdk.
// Streams NDJSON chunks back to TypeScript side.

import { spawn } from 'bun'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

export interface AgentRequest {
  message: string
  sessionId?: string
  persona: string
  cwd: string
  permissionMode: string
  model?: string
  forkSession?: boolean
}

export interface AgentChunk {
  type: 'text' | 'tool_use' | 'tool_result' | 'result' | 'error'
  content: string
  sessionId?: string
  lineCount?: number
  isError?: boolean
}

// Path to agent_worker.py relative to this file's package root
const WORKER_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'agent_worker.py')

let pythonPath = 'python3'

export function setPythonPath(p: string): void {
  pythonPath = p
}

export async function* queryAgent(req: AgentRequest): AsyncGenerator<AgentChunk> {
  const requestJson = JSON.stringify({
    message: req.message,
    sessionId: req.sessionId,
    persona: req.persona,
    cwd: req.cwd,
    permissionMode: req.permissionMode,
    model: req.model,
    forkSession: req.forkSession ?? false,
  })

  const proc = spawn([pythonPath, WORKER_PATH], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })

  // Send request via stdin, then close
  proc.stdin.write(requestJson + '\n')
  proc.stdin.end()

  // Read stdout NDJSON stream
  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const chunk = JSON.parse(line) as AgentChunk
          yield chunk
        } catch {
          // non-JSON line
        }
      }
    }
    // Process remaining buffer
    if (buffer.trim()) {
      try {
        yield JSON.parse(buffer) as AgentChunk
      } catch {
        // ignore
      }
    }
  } catch (err) {
    yield { type: 'error', content: `Agent stream error: ${err}` }
  }

  // Capture stderr for diagnostics
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited

  if (exitCode !== 0 && stderr.trim()) {
    yield { type: 'error', content: `Agent process exited with code ${exitCode}: ${stderr.trim()}` }
  }
}
