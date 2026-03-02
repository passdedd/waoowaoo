import { spawn } from 'node:child_process'

const CLI_TIMEOUT_MS = 5 * 60 * 1000

interface ClaudeCliResultEvent {
  type: 'result'
  subtype: string
  cost_usd: number
  duration_ms: number
  is_error: boolean
  result: string
  session_id: string
}

interface ClaudeCliStreamDelta {
  type: string
  delta?: {
    type?: string
    text?: string
    thinking?: string
  }
  result?: string
  is_error?: boolean
  cost_usd?: number
  duration_ms?: number
}

export interface ClaudeCliCompletionResult {
  text: string
  reasoning: string
  costUsd: number
  durationMs: number
}

export interface ClaudeCliStreamCallbacks {
  onTextDelta: (delta: string) => void
  onReasoningDelta: (delta: string) => void
}

export function formatMessagesToPrompt(
  messages: ReadonlyArray<{ role: string; content: string }>,
): string {
  const parts: string[] = []

  for (const msg of messages) {
    if (msg.role === 'system') {
      parts.push(`[System Instructions]\n${msg.content}`)
    } else {
      parts.push(msg.content)
    }
  }

  return parts.join('\n\n')
}

export function buildCliArgs(params: {
  modelId: string
  outputFormat: 'json' | 'stream-json'
}): string[] {
  const args = [
    '-p',
    '--output-format', params.outputFormat,
    '--max-turns', '1',
    '--model', params.modelId,
  ]
  if (params.outputFormat === 'stream-json') {
    args.push('--verbose')
  }
  return args
}

export function parseJsonResult(stdout: string): ClaudeCliResultEvent {
  const trimmed = stdout.trim()
  if (!trimmed) {
    throw new Error('CLAUDE_CLI_EMPTY_RESPONSE: claude returned empty output')
  }

  const lines = trimmed.split('\n')
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>
      if (parsed.type === 'result' && typeof parsed.result === 'string') {
        return parsed as unknown as ClaudeCliResultEvent
      }
    } catch {
      continue
    }
  }

  const parsed = JSON.parse(trimmed) as Record<string, unknown>
  if (typeof parsed.result === 'string') {
    return parsed as unknown as ClaudeCliResultEvent
  }

  throw new Error('CLAUDE_CLI_PARSE_ERROR: unable to extract result from claude output')
}

function handleSpawnError(error: Error): Error {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
    return new Error('CLAUDE_CLI_NOT_FOUND: claude command not found, please install Claude Code CLI')
  }
  return new Error(`CLAUDE_CLI_SPAWN_ERROR: ${error.message}`)
}

export function executeClaudeCliCompletion(
  modelId: string,
  messages: ReadonlyArray<{ role: string; content: string }>,
): Promise<ClaudeCliCompletionResult> {
  const prompt = formatMessagesToPrompt(messages)
  const args = buildCliArgs({ modelId, outputFormat: 'json' })

  return new Promise<ClaudeCliCompletionResult>((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let settled = false

    const proc = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
    })

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true
        proc.kill('SIGTERM')
        reject(new Error(`CLAUDE_CLI_TIMEOUT: claude did not respond within ${CLI_TIMEOUT_MS}ms`))
      }
    }, CLI_TIMEOUT_MS)

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

    proc.on('error', (error: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(handleSpawnError(error))
    })

    proc.on('close', (code: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)

      if (code !== 0) {
        reject(new Error(
          `CLAUDE_CLI_EXIT_ERROR: exit code ${code ?? 'null'}: ${stderr.trim() || stdout.trim() || 'no output'}`,
        ))
        return
      }

      try {
        const result = parseJsonResult(stdout)
        if (result.is_error) {
          reject(new Error(`CLAUDE_CLI_ERROR: ${result.result}`))
          return
        }
        resolve({
          text: result.result || '',
          reasoning: '',
          costUsd: result.cost_usd ?? 0,
          durationMs: result.duration_ms ?? 0,
        })
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })

    proc.stdin.write(prompt)
    proc.stdin.end()
  })
}

function processStreamDelta(
  event: ClaudeCliStreamDelta,
  state: { fullText: string; fullReasoning: string; costUsd: number; durationMs: number },
  callbacks: ClaudeCliStreamCallbacks,
): void {
  if (event.type === 'content_block_delta') {
    if (event.delta?.type === 'text_delta' && event.delta.text) {
      state.fullText += event.delta.text
      callbacks.onTextDelta(event.delta.text)
    }
    if (event.delta?.type === 'thinking_delta') {
      const thinkingDelta = event.delta.thinking || event.delta.text || ''
      if (thinkingDelta) {
        state.fullReasoning += thinkingDelta
        callbacks.onReasoningDelta(thinkingDelta)
      }
    }
  }

  if (event.type === 'result') {
    if (typeof event.cost_usd === 'number') state.costUsd = event.cost_usd
    if (typeof event.duration_ms === 'number') state.durationMs = event.duration_ms
    if (!state.fullText && typeof event.result === 'string' && event.result) {
      state.fullText = event.result
      callbacks.onTextDelta(event.result)
    }
  }
}

function tryParseStreamLine(
  line: string,
  state: { fullText: string; fullReasoning: string; costUsd: number; durationMs: number },
  callbacks: ClaudeCliStreamCallbacks,
): void {
  const trimmed = line.trim()
  if (!trimmed) return
  try {
    const event = JSON.parse(trimmed) as ClaudeCliStreamDelta
    processStreamDelta(event, state, callbacks)
  } catch {
    // Non-JSON line, skip
  }
}

export function executeClaudeCliStream(
  modelId: string,
  messages: ReadonlyArray<{ role: string; content: string }>,
  callbacks: ClaudeCliStreamCallbacks,
): Promise<ClaudeCliCompletionResult> {
  const prompt = formatMessagesToPrompt(messages)
  const args = buildCliArgs({ modelId, outputFormat: 'stream-json' })

  return new Promise<ClaudeCliCompletionResult>((resolve, reject) => {
    let stderr = ''
    let buffer = ''
    let settled = false
    const state = { fullText: '', fullReasoning: '', costUsd: 0, durationMs: 0 }

    const proc = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
    })

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true
        proc.kill('SIGTERM')
        reject(new Error(`CLAUDE_CLI_TIMEOUT: claude did not respond within ${CLI_TIMEOUT_MS}ms`))
      }
    }, CLI_TIMEOUT_MS)

    proc.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) {
        tryParseStreamLine(line, state, callbacks)
      }
    })

    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

    proc.on('error', (error: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(handleSpawnError(error))
    })

    proc.on('close', (code: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)

      if (buffer.trim()) {
        tryParseStreamLine(buffer, state, callbacks)
      }

      if (code !== 0) {
        reject(new Error(
          `CLAUDE_CLI_EXIT_ERROR: exit code ${code ?? 'null'}: ${stderr.trim() || 'no output'}`,
        ))
        return
      }

      if (!state.fullText) {
        reject(new Error('CLAUDE_CLI_EMPTY_RESPONSE: claude stream produced no text output'))
        return
      }

      resolve({
        text: state.fullText,
        reasoning: state.fullReasoning,
        costUsd: state.costUsd,
        durationMs: state.durationMs,
      })
    })

    proc.stdin.write(prompt)
    proc.stdin.end()
  })
}
