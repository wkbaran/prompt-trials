/** Recordings (from record-proxy or import-litellm) and the fixtures cut from them. Shared by the CLI and the app. */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ToolCallRec {
  id?: string;
  function: { name: string; arguments: string };
}

export interface Recording {
  recordedAt: string;
  latencyMs: number;
  request: { model?: string; messages: { role: string; content?: unknown; tool_calls?: ToolCallRec[] }[]; tools?: any[]; tool_choice?: unknown };
  response: { message?: { content?: string | null; tool_calls?: ToolCallRec[] }; finish_reason?: string; usage?: unknown };
}

export interface Fixture {
  messages: Recording['request']['messages'];
  tools?: any[];
  tool_choice?: unknown;
  reference: Record<string, unknown>;
  source?: string;
}

export function text(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? p : ((p as { text?: string }).text ?? ''))).join('');
  return '';
}

/** One-line description of what the recorded model answered. */
export function answerSummary(rec: Recording, max = 60): string {
  const m = rec.response.message;
  return m?.tool_calls?.length
    ? 'tool_calls: ' + m.tool_calls.map((c) => c.function.name).join(', ')
    : 'text: ' + text(m?.content).slice(0, max).replace(/\s+/g, ' ');
}

/** Conversations are grouped by the start of their first user message. */
export function conversationKey(rec: Recording): string {
  const firstUser = rec.request.messages.find((m) => m.role === 'user');
  return text(firstUser?.content).slice(0, 80).replace(/\s+/g, ' ') || '(no user message)';
}

export function readRecording(path: string): Recording {
  return JSON.parse(readFileSync(path, 'utf8')) as Recording;
}

export function listRecordingFiles(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
}

export function toFixture(rec: Recording, source: string): Fixture {
  return {
    messages: rec.request.messages,
    ...(rec.request.tools ? { tools: rec.request.tools } : {}),
    ...(rec.request.tool_choice ? { tool_choice: rec.request.tool_choice } : {}),
    reference: { model: rec.request.model, ...rec.response },
    source,
  };
}

export function groupConversations(dir: string): Map<string, { file: string; rec: Recording }[]> {
  const groups = new Map<string, { file: string; rec: Recording }[]>();
  for (const file of listRecordingFiles(dir)) {
    const rec = readRecording(join(dir, file));
    const key = conversationKey(rec);
    groups.set(key, [...(groups.get(key) ?? []), { file, rec }]);
  }
  return groups;
}

export function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return { __unparsed: s };
  }
}

/** The provider's output shape for a recorded answer; what assertions receive. */
export function outputFromReference(reference: any): { content: string; tool_calls: { name: string; arguments: unknown }[]; finish_reason?: string } {
  const m = reference?.message ?? {};
  return {
    content: m.content ?? '',
    tool_calls: (m.tool_calls ?? []).map((c: ToolCallRec) => ({ name: c.function.name, arguments: safeParse(c.function.arguments) })),
    finish_reason: reference?.finish_reason,
  };
}
