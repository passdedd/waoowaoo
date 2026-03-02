import { jsonrepair } from 'jsonrepair'

export type AnyObj = Record<string, unknown>

export function readText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function stripMarkdownCodeFence(input: string): string {
  return input
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/, '')
    .replace(/\s*```$/g, '')
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
}

export function repairAndParseJson(jsonText: string): unknown {
  try {
    return JSON.parse(jsonText)
  } catch {
    return JSON.parse(jsonrepair(jsonText))
  }
}

export function parseScreenplayPayload(responseText: string): AnyObj {
  const cleaned = stripMarkdownCodeFence(responseText.trim())
  const firstBrace = cleaned.indexOf('{')
  const lastBrace = cleaned.lastIndexOf('}')
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error('AI returned invalid screenplay JSON')
  }

  const jsonText = cleaned.substring(firstBrace, lastBrace + 1)
  const parsed = repairAndParseJson(jsonText)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('AI returned invalid screenplay JSON object')
  }
  return parsed as AnyObj
}
