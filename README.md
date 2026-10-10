# prompt-trials

Test candidate models against **real requests your agents already sent**, and compare pass rate,
tokens, latency and cost side by side.

Swapping the model under a scheduled LLM agent is risky: the failures that matter (an agent that
finishes early, renumbers things when it delegates, or adds the same item twice) only show up
in the middle of a long tool-calling conversation. `prompt-trials` captures real conversations,
cuts them at the decision points where things went wrong, and replays each one against any model.
Deterministic assertions check the next step. Results open in [promptfoo](https://www.promptfoo.dev/)'s
web viewer.

```
 agent ──► LiteLLM / recording proxy ──► model           (capture once, from a real run)
              │
              ▼  import-litellm / record-proxy
        recordings/*.json  ──►  cut  ──►  fixtures  (messages + tools + the answer it gave)
                                              │
        suite = fixtures + assertions         ▼
        promptfoo eval ──► provider.ts ──► model A, model B, …  ──►  pass rate, tokens, time, cost
```

Each request an agent sends carries the whole conversation so far, so every recorded request is
already a snapshot at a decision point. No special tracing is needed.

## Try it (no model, no API key)

```
npm install
npm run check          # runs the three example suites against their stored reference answers
npm run view           # promptfoo's web viewer for the results
```

The example suites (`suites/medium-digest`, `suites/substack-digest`, `suites/spotify-lane`) use
**synthetic** fixtures: invented posts, tracks and refs. The `@reference` provider replays the
answer stored in each fixture, so you can see what the assertions check before pointing them at a
real model.

## Run against real models

```
cp models.example.yaml models.yaml      # endpoints, key env var names, prices (gitignored)
```

`models.yaml` describes each model once:

```yaml
models:
  qwen3.8-local:
    apiBaseUrl: ${OLLAMA_URL}/v1
    model: qwen3.8-27b-ctx96k
    price: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }   # USD per million tokens
    params: { temperature: 0.6 }
```

Add the model to a suite's `providers:` (see the commented line in each
`promptfooconfig.yaml`) and run `npm run eval -- suites/medium-digest/promptfooconfig.yaml`.
Use `--repeat 3` to see variance (local models vary a lot). Per test the viewer shows latency,
prompt/completion/cached tokens and cost. Cost is computed from your prices: fresh input, output,
cache reads and cache writes are billed separately. If you route everything through a
[LiteLLM](https://docs.litellm.ai/) proxy, set `litellm.baseUrl` and its per-call cost is used
instead.

## Capture your own fixtures

Point the agent at a LiteLLM proxy (or the bundled recording proxy) for one run, then:

```
# Option 1: LiteLLM spend logs
LITELLM_URL=http://host:4000 LITELLM_API_KEY=... \
  npm run import-litellm -- --since 2026-01-05T06:00:00Z --model my-model --out recordings/job

# Option 2: no LiteLLM, record directly
npm run record -- --upstream http://localhost:11434 --out recordings/job   # then use port 11435

npm run cut -- list recordings/job                                   # conversations and steps
npm run cut -- pick recordings/job/<file>.json fixtures/job/after-first-batch.json
```

LiteLLM needs `store_prompts_in_spend_logs` on and `MAX_STRING_LENGTH_PROMPT_IN_DB` raised
(the default of 2048 characters truncates long messages). Read `proxy_server_request` and
`response` from the spend logs, not the empty `messages` column. A fixture is
`{ messages, tools, reference }`, where `reference` is the answer the original model gave.

Put cases built from your recordings in `suites/<name>/cases.private.yaml`. It is gitignored,
like `fixtures/` and `recordings/`, because real conversations contain personal data.

## Assertions

Shared checks live in `src/assertions.ts` and are used from a suite's `cases.yaml`:

| Assertion | Catches |
|---|---|
| `callsTool` / `avoidsTool` | calling `finish` before every batch was read; skipping a required step |
| `validToolArguments` | malformed tool-call JSON |
| `delegatedRefsPreserved` | a model renumbering or reordering items when it delegates |
| `noRepeatedItems` | adding the same track or item twice |
| `startsWith`, `maxLength` | reply format and length caps |

An MCP wrapper such as `tool_call` is unwrapped automatically. Everything else in promptfoo's
assertion library (`not-icontains`, `llm-rubric`, …) works too.

## Layout

```
src/provider.ts        promptfoo provider: replays a fixture against a model, records tokens/latency/cost
src/registry.ts        models.yaml loader (${ENV} interpolation)       src/cost.ts   price math
src/assertions.ts      reusable checks                                  src/cut.ts    recordings → fixtures
src/import-litellm.ts  LiteLLM spend logs → recordings                  src/record-proxy.ts   pass-through recorder
suites/<name>/         promptfooconfig.yaml, cases.yaml, examples/ (synthetic fixtures)
scripts/audit.ts       refuses to publish private addresses, paths, keys, emails
```

## Status and ideas

Working: provider with per-model pricing, capture from LiteLLM or a proxy, three example suites.
Planned: a small control app for running suites and building cases from recordings, deployment
as a container, a relevance-scoring assertion for ranked picks.

`npm run audit` (and `-- --history`) scans tracked files and git history for LAN addresses,
home paths, key-like strings and personal emails. Run it before pushing.

## License

MIT. See [LICENSE](LICENSE).
