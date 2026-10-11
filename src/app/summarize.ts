/** Turns promptfoo's results JSON into what the app shows: per-model totals and a test-by-model grid. */

export interface Cell {
  success: boolean;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cost: number;
  /** Why it failed: the failing assertions' reasons, or the provider error. */
  reason?: string;
  /** What the model did, shortened for display. */
  output?: string;
}

export interface ModelTotals {
  label: string;
  passed: number;
  failed: number;
  total: number;
  avgLatencyMs: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cost: number;
}

export interface Summary {
  evalId?: string;
  models: ModelTotals[];
  tests: { description: string; fixture?: string; cells: Record<string, Cell[]> }[];
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

function describeOutput(output: unknown): string {
  if (output && typeof output === 'object') {
    const o = output as { content?: string; tool_calls?: { name: string; arguments: unknown }[] };
    const calls = (o.tool_calls ?? []).map((c) => `${c.name}(${clip(JSON.stringify(c.arguments), 900)})`);
    return [o.content ? clip(o.content, 700) : '', ...calls].filter(Boolean).join('\n');
  }
  return clip(String(output ?? ''), 900);
}

export function summarize(results: any): Summary {
  const rows: any[] = results?.results?.results ?? [];
  const labels: string[] = [];
  // --repeat makes promptfoo emit each test several times under different indexes; group the repeats back together.
  const tests = new Map<string, Summary['tests'][number]>();
  for (const r of rows) {
    const label: string = r.provider?.label ?? r.provider?.id ?? 'model';
    if (!labels.includes(label)) labels.push(label);
    const description: string = r.testCase?.description ?? `test ${r.testIdx + 1}`;
    const fixture: string | undefined = r.vars?.fixture ?? r.testCase?.vars?.fixture;
    const key = `${description}\u0000${fixture ?? ''}`;
    const t: Summary['tests'][number] = tests.get(key) ?? { description, fixture, cells: {} };
    tests.set(key, t);
    const usage = r.response?.tokenUsage ?? r.tokenUsage ?? {};
    const failed = (r.gradingResult?.componentResults ?? []).filter((c: any) => !c.pass).map((c: any) => c.reason);
    (t.cells[label] ??= []).push({
      success: Boolean(r.success),
      latencyMs: r.latencyMs ?? r.response?.latencyMs ?? 0,
      promptTokens: usage.prompt ?? 0,
      completionTokens: usage.completion ?? 0,
      cachedTokens: usage.cached ?? 0,
      cost: r.cost ?? r.response?.cost ?? 0,
      reason: r.success ? undefined : (failed.join('; ') || r.error || r.failureReason?.toString()),
      output: describeOutput(r.response?.output),
    });
  }
  const models: ModelTotals[] = labels.map((label) => {
    const cells = [...tests.values()].flatMap((t) => t.cells[label] ?? []);
    const sum = (f: (c: Cell) => number) => cells.reduce((a, c) => a + f(c), 0);
    return {
      label,
      passed: cells.filter((c) => c.success).length,
      failed: cells.filter((c) => !c.success).length,
      total: cells.length,
      avgLatencyMs: cells.length ? Math.round(sum((c) => c.latencyMs) / cells.length) : 0,
      promptTokens: sum((c) => c.promptTokens),
      completionTokens: sum((c) => c.completionTokens),
      cachedTokens: sum((c) => c.cachedTokens),
      cost: sum((c) => c.cost),
    };
  });
  return { evalId: results?.evalId, models, tests: [...tests.values()] };
}
