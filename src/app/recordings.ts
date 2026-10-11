import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { unwrap } from '../assertions.ts';
import { answerSummary, groupConversations, readRecording, safeParse, text, toFixture, type Recording } from '../fixture.ts';
import type { AppConfig } from './config.ts';
import { fixturePath } from './cases.ts';

const SAFE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function dirOf(cfg: AppConfig, dir: string): string {
  if (!SAFE.test(dir)) throw new Error('bad recording directory');
  const p = join(cfg.recordingsDir, dir);
  if (!existsSync(p)) throw new Error(`no recordings in ${p}`);
  return p;
}

export function listRecordingDirs(cfg: AppConfig) {
  if (!existsSync(cfg.recordingsDir)) return [];
  return readdirSync(cfg.recordingsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ name: d.name, files: readdirSync(join(cfg.recordingsDir, d.name)).filter((f) => f.endsWith('.json')).length }))
    .sort((a, b) => b.name.localeCompare(a.name));
}

export function conversations(cfg: AppConfig, dir: string) {
  const out = [];
  for (const [key, steps] of groupConversations(dirOf(cfg, dir))) {
    out.push({
      key,
      steps: steps.map(({ file, rec }) => ({
        file,
        messages: rec.request.messages.length,
        ms: rec.latencyMs,
        answer: answerSummary(rec, 90),
        promptTokens: (rec.response.usage as { prompt_tokens?: number } | undefined)?.prompt_tokens,
      })),
    });
  }
  return out;
}

const SHOWN = 12000;

/** One recorded request for display: message text is shortened, and the tool names a case can mention are collected. */
export function stepDetail(cfg: AppConfig, dir: string, file: string) {
  if (!SAFE.test(file)) throw new Error('bad recording file');
  const rec: Recording = readRecording(join(dirOf(cfg, dir), file));
  const tools = new Set<string>((rec.request.tools ?? []).map((t) => t.function?.name).filter(Boolean));
  const asCall = (c: { function: { name: string; arguments: string } }) => ({ name: c.function.name, arguments: safeParse(c.function.arguments) });
  const seen: { name: string; arguments: unknown }[] = [];
  for (const m of rec.request.messages) for (const c of m.tool_calls ?? []) seen.push(asCall(c));
  const answerCalls = (rec.response.message?.tool_calls ?? []).map(asCall);
  for (const c of unwrap([...seen, ...answerCalls])) tools.add(c.name);
  const messages = rec.request.messages.map((m) => {
    const t = text(m.content);
    return {
      role: m.role,
      content: t.length > SHOWN ? t.slice(0, SHOWN) : t,
      chars: t.length,
      toolCalls: (m.tool_calls ?? []).map((c) => `${c.function.name} ${c.function.arguments.slice(0, 600)}`),
    };
  });
  const answer = rec.response.message;
  return {
    file,
    model: rec.request.model,
    latencyMs: rec.latencyMs,
    usage: rec.response.usage,
    messages,
    tools: [...tools].sort(),
    answer: { content: text(answer?.content), toolCalls: unwrap(answerCalls) },
    shown: SHOWN,
  };
}

/** Writes the fixture for a recorded step and returns its path. */
export function cutFixture(cfg: AppConfig, dir: string, file: string, suite: string, name: string): string {
  if (!SAFE.test(file)) throw new Error('bad recording file');
  const rec = readRecording(join(dirOf(cfg, dir), file));
  const path = fixturePath(cfg, suite, name);
  writeFileSync(path, JSON.stringify(toFixture(rec, file), null, 2));
  return path;
}

/** Removes a recordings folder. Fixtures and cases made from it are separate copies and stay. */
export function deleteRecordingDir(cfg: AppConfig, dir: string): number {
  const path = dirOf(cfg, dir);
  const files = readdirSync(path).filter((f) => f.endsWith('.json')).length;
  rmSync(path, { recursive: true });
  return files;
}
