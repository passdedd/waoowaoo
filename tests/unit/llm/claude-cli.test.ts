import { describe, expect, it } from 'vitest'
import {
  formatMessagesToPrompt,
  buildCliArgs,
  parseJsonResult,
} from '@/lib/llm/providers/claude-cli'

describe('llm/providers/claude-cli', () => {
  describe('formatMessagesToPrompt', () => {
    it('wraps system messages with [System Instructions] prefix', () => {
      const result = formatMessagesToPrompt([
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hello world' },
      ])
      expect(result).toBe('[System Instructions]\nYou are a helpful assistant.\n\nHello world')
    })

    it('joins multiple system messages each with prefix', () => {
      const result = formatMessagesToPrompt([
        { role: 'system', content: 'Rule 1' },
        { role: 'system', content: 'Rule 2' },
        { role: 'user', content: 'Do something' },
      ])
      expect(result).toBe('[System Instructions]\nRule 1\n\n[System Instructions]\nRule 2\n\nDo something')
    })

    it('returns just user content when no system messages', () => {
      const result = formatMessagesToPrompt([
        { role: 'user', content: 'Just a question' },
      ])
      expect(result).toBe('Just a question')
    })

    it('joins multiple non-system messages with double newline', () => {
      const result = formatMessagesToPrompt([
        { role: 'user', content: 'First message' },
        { role: 'assistant', content: 'Response' },
        { role: 'user', content: 'Follow up' },
      ])
      expect(result).toBe('First message\n\nResponse\n\nFollow up')
    })
  })

  describe('buildCliArgs', () => {
    it('builds args for json output format', () => {
      const args = buildCliArgs({
        modelId: 'sonnet',
        outputFormat: 'json',
      })
      expect(args).toEqual([
        '-p',
        '--output-format', 'json',
        '--max-turns', '1',
        '--model', 'sonnet',
      ])
    })

    it('builds args for stream-json output format with --verbose', () => {
      const args = buildCliArgs({
        modelId: 'claude-sonnet-4-20250514',
        outputFormat: 'stream-json',
      })
      expect(args).toEqual([
        '-p',
        '--output-format', 'stream-json',
        '--max-turns', '1',
        '--model', 'claude-sonnet-4-20250514',
        '--verbose',
      ])
    })
  })

  describe('parseJsonResult', () => {
    it('parses single-line JSON result', () => {
      const stdout = JSON.stringify({
        type: 'result',
        subtype: 'success',
        cost_usd: 0.003,
        duration_ms: 1200,
        is_error: false,
        result: 'Hello from Claude',
        session_id: 'sess_123',
      })
      const parsed = parseJsonResult(stdout)
      expect(parsed.type).toBe('result')
      expect(parsed.result).toBe('Hello from Claude')
      expect(parsed.cost_usd).toBe(0.003)
      expect(parsed.duration_ms).toBe(1200)
      expect(parsed.is_error).toBe(false)
    })

    it('extracts result event from multi-line stream output', () => {
      const lines = [
        JSON.stringify({ type: 'assistant', message: { type: 'message' } }),
        JSON.stringify({ type: 'content_block_start', index: 0 }),
        JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } }),
        JSON.stringify({ type: 'content_block_stop', index: 0 }),
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          cost_usd: 0.001,
          duration_ms: 500,
          is_error: false,
          result: 'Hi there',
          session_id: 'sess_456',
        }),
      ]
      const parsed = parseJsonResult(lines.join('\n'))
      expect(parsed.result).toBe('Hi there')
      expect(parsed.cost_usd).toBe(0.001)
    })

    it('throws on empty output', () => {
      expect(() => parseJsonResult('')).toThrow('CLAUDE_CLI_EMPTY_RESPONSE')
      expect(() => parseJsonResult('   ')).toThrow('CLAUDE_CLI_EMPTY_RESPONSE')
    })

    it('throws when no result event found', () => {
      const stdout = JSON.stringify({ type: 'error', message: 'something went wrong' })
      expect(() => parseJsonResult(stdout)).toThrow('CLAUDE_CLI_PARSE_ERROR')
    })

    it('handles result with is_error true', () => {
      const stdout = JSON.stringify({
        type: 'result',
        subtype: 'error',
        cost_usd: 0,
        duration_ms: 100,
        is_error: true,
        result: 'Rate limit exceeded',
        session_id: 'sess_789',
      })
      const parsed = parseJsonResult(stdout)
      expect(parsed.is_error).toBe(true)
      expect(parsed.result).toBe('Rate limit exceeded')
    })
  })
})
