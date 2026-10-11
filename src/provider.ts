import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { computeCost } from './cost.ts';
import { getModel, loadRegistry } from './registry.ts';

/**
 * Promptfoo custom provider. Sends a recorded chat conversation (fixture) to one
 * model from models.yaml and reports tokens, latency and cost per call.
 *
 * Provider config:   { model: "<key in models.yaml>" }   or   { model: "@reference" }
 *                    "@reference" needs no model or models.yaml: it returns the answer stored in the
 *                    fixture, so a suite's assertions can be checked (and demoed) offline.
 * Test vars:         { fixture: "path/to/fixture.json" }   (relative to the working directory)
 * Fixture file:      { messages: [...], tools?: [...], tool_choice?: ... }
 */

interface ProviderOptions {
  id?: string;
  config?: { model?: string; params?: Record<string, unknown> };
}

interface CallContext {
  vars?: Record<string, unknown>;
}

interface Fixture {
  messages: unknown[];
  tools?: unknown[];
  tool_choice?: unknown;
  /** The answer recorded with the snapshot; `model: "@reference"` replays it instead of calling a model. */
  reference?: { message?: { content?: string | null; tool_calls?: ToolCall[] }; finish_reason?: string; usage?: Usage };
}

interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface ToolCall {
  id?: string;
  function: { name: string; arguments: string };
}

export default class PromptTrialsProvider {
  private readonly modelKey: string;
  private readonly extraParams: Record<string, unknown>;

  constructor(options: ProviderOptions = {}) {
    const model = options.config?.model;
    if (!model) throw new Error('provider config needs `model: <key in models.yaml>`');
    this.modelKey = model;
    this.extraParams = options.config?.params ?? {};
  }

  id(): string {
    return `prompt-trials:${this.modelKey}`;
  }

  async callApi(_prompt: string, context?: CallContext) {
    const fixturePath = context?.vars?.fixture;
    if (typeof fixturePath !== 'string') return { error: 'test needs a `fixture` var (path to a fixture JSON)' };

    let fixture: Fixture;
    try {
      fixture = JSON.parse(readFileSync(resolve(fixturePath), 'utf8')) as Fixture;
    } catch (e) {
      return { error: `cannot read fixture ${fixturePath}: ${(e as Error).message}` };
    }

    if (this.modelKey === '@reference') {
      const ref = fixture.reference;
      if (!ref?.message) return { error: `fixture ${fixturePath} has no reference answer` };
      return {
        output: {
          content: ref.message.content ?? '',
          tool_calls: (ref.message.tool_calls ?? []).map((c) => ({ name: c.function.name, arguments: safeParse(c.function.arguments) })),
          finish_reason: ref.finish_reason,
        },
        tokenUsage: {
          prompt: ref.usage?.prompt_tokens ?? 0,
          completion: ref.usage?.completion_tokens ?? 0,
          total: ref.usage?.total_tokens ?? 0,
          numRequests: 0,
        },
        cost: 0,
        latencyMs: 0,
        metadata: { model: '@reference' },
      };
    }

    const entry = getModel(this.modelKey);
    const proxy = loadRegistry().litellm;
    const viaProxy = Boolean(proxy?.baseUrl);
    const baseUrl = (viaProxy ? proxy!.baseUrl! : entry.apiBaseUrl).replace(/\/$/, '');
    const keyEnv = viaProxy ? proxy!.apiKeyEnv : entry.apiKeyEnv;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (keyEnv) {
      const key = process.env[keyEnv];
      if (!key) return { error: `env var ${keyEnv} is not set` };
      headers.authorization = `Bearer ${key}`;
    }

    const body: Record<string, unknown> = {
      model: entry.model,
      messages: fixture.messages,
      ...(fixture.tools ? { tools: fixture.tools } : {}),
      ...(fixture.tool_choice ? { tool_choice: fixture.tool_choice } : {}),
      ...entry.params,
      ...this.extraParams,
      stream: false,
    };

    const started = performance.now();
    let res: Response;
    try {
      res = await fetch(`${baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) });
    } catch (e) {
      return { error: `request failed: ${(e as Error).message}`, latencyMs: Math.round(performance.now() - started) };
    }
    const text = await res.text();
    const latencyMs = Math.round(performance.now() - started);
    if (!res.ok) return { error: `HTTP ${res.status}: ${text.slice(0, 500)}`, latencyMs };

    const json = JSON.parse(text) as {
      choices?: { message?: { content?: string | null; tool_calls?: ToolCall[]; reasoning?: string; reasoning_content?: string }; finish_reason?: string }[];
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
        completion_tokens_details?: { reasoning_tokens?: number };
      };
    };
    const choice = json.choices?.[0];
    const message = choice?.message;
    const u = json.usage ?? {};
    const promptTokens = u.prompt_tokens ?? 0;
    const completionTokens = u.completion_tokens ?? 0;
    const cacheReadTokens = u.prompt_tokens_details?.cached_tokens ?? u.cache_read_input_tokens ?? 0;
    const cacheWriteTokens = u.prompt_tokens_details?.cache_write_tokens ?? u.cache_creation_input_tokens ?? 0;

    const proxyCost = Number(res.headers.get('x-litellm-response-cost'));
    const cost =
      viaProxy && Number.isFinite(proxyCost) && res.headers.has('x-litellm-response-cost')
        ? proxyCost
        : computeCost(entry.price, { promptTokens, completionTokens, cacheReadTokens, cacheWriteTokens });

    const toolCalls = (message?.tool_calls ?? []).map((c) => ({
      name: c.function.name,
      arguments: safeParse(c.function.arguments),
    }));

    return {
      output: {
        content: message?.content ?? '',
        tool_calls: toolCalls,
        finish_reason: choice?.finish_reason,
      },
      tokenUsage: {
        prompt: promptTokens,
        completion: completionTokens,
        cached: cacheReadTokens,
        total: u.total_tokens ?? promptTokens + completionTokens,
        numRequests: 1,
        completionDetails: {
          reasoning: u.completion_tokens_details?.reasoning_tokens,
          cacheReadInputTokens: cacheReadTokens,
          cacheCreationInputTokens: cacheWriteTokens,
        },
      },
      cost,
      latencyMs,
      metadata: {
        model: this.modelKey,
        cost_source: viaProxy ? 'litellm-or-registry' : 'registry',
        reasoning: message?.reasoning ?? message?.reasoning_content,
      },
    };
  }
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return { __unparsed: s };
  }
}
