/**
 * Reusable promptfoo `javascript` assertions for tool-calling snapshots.
 * Use from a suite config as:
 *
 *   - type: javascript
 *     value: file://../../src/assertions.ts:callsTool
 *     config: { names: [read_post] }
 *
 * `output` is what src/provider.ts returns: { content, tool_calls: [{ name, arguments }], finish_reason }.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface Call {
  name: string;
  arguments: any;
}
interface Output {
  content: string;
  tool_calls: Call[];
  finish_reason?: string;
}
interface Ctx {
  config?: Record<string, any>;
  vars?: Record<string, any>;
}
type Result = { pass: boolean; score: number; reason: string };

const ok = (reason: string): Result => ({ pass: true, score: 1, reason });
const bad = (reason: string): Result => ({ pass: false, score: 0, reason });

/**
 * Hermes routes MCP tools through a generic wrapper such as `tool_call`. Unwrap it so assertions see
 * the real tool name. The wrapper takes either one call ({ name, arguments }) or a batch
 * ({ calls: [{ name, arguments }] }). `wrapper` in assertion config names the wrapper (default "tool_call").
 * MCP names like `mcp__medium_reader__digest_finish` are shortened to `digest_finish`.
 */
export function unwrap(calls: Call[], wrapper = 'tool_call'): Call[] {
  const short = (n: string) => n.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '');
  return calls
    .flatMap((c): Call[] => {
      const a = c.arguments;
      if (c.name !== wrapper || !a || typeof a !== 'object') return [c];
      const inner: any[] = Array.isArray(a.calls) ? a.calls : [a];
      return inner.map((i) => ({ name: i.name ?? i.tool ?? i.tool_name ?? c.name, arguments: i.arguments ?? i.args ?? i.input ?? {} }));
    })
    .map((c) => ({ ...c, name: typeof c.name === 'string' ? short(c.name) : c.name }));
}

export function callsOf(output: Output, ctx?: Ctx): Call[] {
  return unwrap(output.tool_calls ?? [], ctx?.config?.wrapper);
}

/** Messages of the fixture the test replayed. */
export function fixtureMessages(ctx: Ctx): any[] {
  const p = ctx.vars?.fixture;
  if (typeof p !== 'string') return [];
  return JSON.parse(readFileSync(resolve(p), 'utf8')).messages ?? [];
}

/** Tool calls the conversation already made before the snapshot. */
export function priorCalls(ctx: Ctx): Call[] {
  const out: Call[] = [];
  for (const m of fixtureMessages(ctx)) {
    for (const c of m.tool_calls ?? []) {
      let args: any = c.function?.arguments;
      try {
        args = JSON.parse(args);
      } catch {
        /* keep raw */
      }
      out.push({ name: c.function?.name, arguments: args });
    }
  }
  return unwrap(out, ctx.config?.wrapper);
}

/** config: { names: string[] } at least one call to one of these tools. */
export function callsTool(output: Output, ctx: Ctx): Result {
  const names: string[] = ctx.config?.names ?? [];
  const got = callsOf(output, ctx).map((c) => c.name);
  return got.some((n) => names.includes(n)) ? ok(`called ${got.join(', ')}`) : bad(`wanted one of [${names}], got [${got}]`);
}

/** config: { names: string[] } none of these tools may be called. */
export function avoidsTool(output: Output, ctx: Ctx): Result {
  const names: string[] = ctx.config?.names ?? [];
  const hit = callsOf(output, ctx).filter((c) => names.includes(c.name));
  return hit.length ? bad(`called forbidden ${hit.map((c) => c.name)}`) : ok('no forbidden tool called');
}

/** Every tool call's arguments parsed as JSON. */
export function validToolArguments(output: Output): Result {
  const broken = (output.tool_calls ?? []).filter((c) => c.arguments && typeof c.arguments === 'object' && '__unparsed' in c.arguments);
  return broken.length ? bad(`unparseable arguments for ${broken.map((c) => c.name)}`) : ok('all tool arguments are valid JSON');
}

/** config: { name: string, key: string } values of args[key] (array or scalar) must not repeat earlier calls to `name`. */
export function noRepeatedItems(output: Output, ctx: Ctx): Result {
  const { name, key } = ctx.config ?? {};
  const flat = (v: unknown): string[] => (Array.isArray(v) ? v.flatMap(flat) : v == null ? [] : [JSON.stringify(v)]);
  const seen = new Set(priorCalls(ctx).filter((c) => c.name === name).flatMap((c) => flat(c.arguments?.[key])));
  const dupes = callsOf(output, ctx)
    .filter((c) => c.name === name)
    .flatMap((c) => flat(c.arguments?.[key]))
    .filter((v) => seen.has(v));
  return dupes.length ? bad(`${name}.${key} repeats ${dupes.length} earlier item(s)`) : ok(`${name}.${key} adds nothing already added`);
}

/** config: { pattern: string, flags?: string } the final text content must start with the pattern. */
export function startsWith(output: Output, ctx: Ctx): Result {
  const re = new RegExp('^\\s*(?:' + ctx.config?.pattern + ')', ctx.config?.flags ?? '');
  return re.test(output.content ?? '') ? ok('starts as required') : bad(`reply starts with: ${(output.content ?? '').slice(0, 80)}`);
}

/**
 * Refs (e.g. P1, F3) in delegate_task goals must be exactly the refs the work list showed:
 * no invented refs, none duplicated, each in the order the list gave them.
 * config: { tool?: "delegate_task", refPattern?: regex of a ref, listedIn?: only tool results containing this
 *           text count as the work list (e.g. "digest_begin"), ordered?: false to allow any order (default true),
 *           unique?: false to let a ref appear in several goals (default true) }
 */
export function delegatedRefsPreserved(output: Output, ctx: Ctx): Result {
  const refRe = new RegExp(ctx.config?.refPattern ?? '\\b[PFTY]\\d+\\b', 'g');
  const tool = ctx.config?.tool ?? 'delegate_task';
  const listed = new Set<string>();
  for (const m of fixtureMessages(ctx)) {
    if (m.role !== 'tool' || typeof m.content !== 'string') continue;
    if (ctx.config?.listedIn && !m.content.includes(ctx.config.listedIn)) continue;
    // MCP results arrive as JSON text, so line breaks are the two characters \n and defeat \b.
    for (const r of m.content.replace(/\\n/g, ' ').match(refRe) ?? []) listed.add(r);
  }
  const order = [...listed];
  const used: string[] = [];
  for (const c of callsOf(output, ctx).filter((c) => c.name === tool)) {
    const goals: string[] = c.arguments?.tasks ? c.arguments.tasks.map((t: any) => t.goal ?? '') : [c.arguments?.goal ?? ''];
    for (const g of goals) used.push(...(g.match(refRe) ?? []));
  }
  if (!used.length) return bad(`no refs found in ${tool} goals`);
  const unknown = used.filter((r) => !listed.has(r));
  if (unknown.length) return bad(`refs not in the work list: ${[...new Set(unknown)]}`);
  if (ctx.config?.unique !== false && new Set(used).size !== used.length) return bad('a ref appears in more than one goal');
  if (ctx.config?.ordered === false) return ok(`refs ${used.join(' ')} all in the work list`);
  const idx = used.map((r) => order.indexOf(r));
  const sorted = [...idx].sort((a, b) => a - b);
  return idx.every((v, i) => v === sorted[i]) ? ok(`refs ${used.join(' ')} unchanged`) : bad(`refs reordered: ${used.join(' ')}`);
}

/** config: { max: number } text content length cap, useful for gists. */
export function maxLength(output: Output, ctx: Ctx): Result {
  const max = ctx.config?.max ?? 280;
  const len = (output.content ?? '').length;
  return len <= max ? ok(`${len} chars`) : bad(`${len} chars > ${max}`);
}

/**
 * Goals sent to a subagent must not contain unexpanded placeholders such as `<the ref>` or `{chat id}`,
 * which Hermes's delegate_task rejects. config: { tool?: "delegate_task" }
 */
export function noTemplateMarkers(output: Output, ctx: Ctx): Result {
  const tool = ctx.config?.tool ?? 'delegate_task';
  const marker = /<[A-Za-z][^<>\n]*\s[^<>\n]*>|\{[A-Za-z][^{}\n"]*\s[^{}\n"]*\}/;
  const hits = callsOf(output, ctx)
    .filter((c) => c.name === tool)
    .flatMap((c) => (c.arguments?.tasks ?? [c.arguments]).map((t: any) => `${t?.goal ?? ''}`.match(marker)?.[0]))
    .filter(Boolean);
  return hits.length ? bad(`placeholder left in goal: ${hits[0]}`) : ok('no placeholders in goals');
}
