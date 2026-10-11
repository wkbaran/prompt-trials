<div align="center">

# Prompt Trials

**Replay the requests your agents really sent against any model, and see which one holds up.**

![Node 26+](https://img.shields.io/badge/node-26%2B-339933?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![promptfoo](https://img.shields.io/badge/built%20on-promptfoo-orange)
![LiteLLM](https://img.shields.io/badge/capture-LiteLLM-informational)
![License: MIT](https://img.shields.io/badge/license-MIT-blue)

[Concepts](#concepts) · [Try it](#try-it-no-model-no-api-key) · [Real models](#run-against-real-models) · [Capture fixtures](#capture-your-own-fixtures) · [Control app](#control-app) · [Assertions](#assertions) · [Layout](#layout) · [Status](#status-and-ideas)

</div>

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

## Concepts

- **Fixture**: one frozen moment of an agent run, saved as a JSON file. It holds everything the
  model saw at that point: the `messages` so far (system prompt, user request, earlier tool calls
  and their results) and the `tools` it could call. It also keeps a `reference`, the answer the
  original model gave next. Replaying a fixture against another model asks: *given exactly this
  situation, what would you do next?* Fixtures are copied from real requests, so they are not
  committed (they hold personal data); the repo ships synthetic examples instead.
- **Case**: a fixture plus the assertions that decide whether the next step is right (a promptfoo
  "test").
- **Suite**: a folder under `suites/` with a `promptfooconfig.yaml` and its cases, for one kind of
  job.
- **Provider**: what sends the fixture to a model (`src/provider.ts`) and reports tokens, latency
  and cost. `@reference` replays the stored answer with no model at all.
- **Assertion**: a check on the model's next step, such as which tool it called, with which
  arguments, or how its reply starts.

A trimmed fixture:

```json
{
  "messages": [
    { "role": "system", "content": "You run a daily digest. Never finish while ranked posts are unread." },
    { "role": "user", "content": "Run today's digest." },
    { "role": "assistant", "content": null, "tool_calls": [{ "id": "call_1", "type": "function",
        "function": { "name": "digest_begin", "arguments": "{}" } }] },
    { "role": "tool", "tool_call_id": "call_1", "content": "Work list: T1 (94) …  Y1 (88) …" }
  ],
  "tools": [{ "type": "function", "function": { "name": "read_post", "parameters": { "...": "..." } } }],
  "reference": { "message": { "role": "assistant", "tool_calls": [ { "function": { "name": "read_post", "arguments": "{\"ref\":\"T1\"}" } } ] } }
}
```

## Built on promptfoo

[promptfoo](https://www.promptfoo.dev/docs/intro/) does the heavy lifting: it runs the matrix of
cases and models, stores results, and serves the web viewer (`npm run view`). This repo adds the
parts it doesn't have: a provider that replays recorded tool-calling conversations with per-model
pricing (including cache reads and writes), the importers that turn agent runs into fixtures, and
a library of agent-specific assertions.

If you know promptfoo, the mapping is direct: a suite's `promptfooconfig.yaml` is a
[config file](https://www.promptfoo.dev/docs/configuration/guide/), `cases.yaml` holds its
[test cases](https://www.promptfoo.dev/docs/configuration/test-cases/) (each with a `fixture`
variable), `src/provider.ts` is a [custom provider](https://www.promptfoo.dev/docs/providers/custom-api/),
and the checks in `src/assertions.ts` are
[JavaScript assertions](https://www.promptfoo.dev/docs/configuration/expected-outputs/javascript/)
that sit alongside promptfoo's [built-in ones](https://www.promptfoo.dev/docs/configuration/expected-outputs/).
Flags such as `--repeat` and `--max-concurrency` are listed in the
[command-line reference](https://www.promptfoo.dev/docs/usage/command-line/). Tool definitions in a
fixture use the OpenAI chat format; see promptfoo's
[tools documentation](https://www.promptfoo.dev/docs/configuration/tools/).

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

## Control app

```
npm run app            # http://127.0.0.1:5180, with promptfoo's viewer on :15500
```

A small local web app for the parts of the workflow that are tedious on the command line:

- **New run:** pick a suite, any models from `models.yaml`, repeats and parallelism, and start it. The log streams live and
  the run is kept in `output/runs/`.
- **Runs:** per-model pass rate, average time, tokens (fresh, cached, output) and cost, then a grid with one square per test
  and attempt. Select a square to see what the model actually did and why it failed. Every run is also stored in
  promptfoo, so its own viewer is one click away.
- **GPU guard:** a run with a local model warns when a configured busy window is active or about to start, or when Ollama
  has a different model loaded. Copy `trials.config.example.yaml` to `trials.config.yaml` to describe your windows.
- **Recordings and cases:** browse imported conversations, open a step, read the conversation and the answer that was
  recorded, then build a case from it: choose assertions from a list, try them against the recorded answer, and save.
  Cases land in the suite's `cases.private.yaml` (the previous version is kept as `.bak`) and fixtures under `fixtures/`.
  Existing private cases can be edited or deleted; the shipped examples are read-only.

It binds to `127.0.0.1` by default (`HOST`, `PORT` and `VIEWER_PORT` change that).

### Running it as a container

`Dockerfile` and `compose.example.yaml` run the app and promptfoo's viewer together. Set `TRIALS_AUTH_USER` and
`TRIALS_AUTH_PASSWORD` and both ask for that login (HTTP basic auth, over plain HTTP, so keep it on a network you trust).
The viewer itself only listens on loopback inside the container; the app proxies it behind the same login. Without those
variables there is no login, and the app warns when it listens on anything but localhost.

Persistent state lives in bind-mounted folders (recordings, fixtures, private cases, run output, promptfoo's database),
plus a read-only `models.yaml` and optional `trials.config.yaml`. Private cases are kept as `<PRIVATE_CASES_DIR>/<suite>.yaml`
instead of inside the suite folder. `GET /healthz` answers without a login, for container health checks.

## Assertions

Shared checks live in `src/assertions.ts` and are used from a suite's `cases.yaml`:

| Assertion | Catches |
|---|---|
| `callsTool` / `avoidsTool` | calling `finish` before every batch was read; skipping a required step |
| `validToolArguments` | malformed tool-call JSON |
| `delegatedRefsPreserved` | a model renumbering, inventing or reordering refs when it delegates |
| `noTemplateMarkers` | unexpanded placeholders such as `<the ref>` left in a subagent goal |
| `noRepeatedItems` | adding the same track or item twice |
| `startsWith`, `maxLength` | reply format and length caps |

An MCP wrapper such as `tool_call` (single or batched calls, with `mcp__server__` name prefixes) is unwrapped automatically. Everything else in promptfoo's
assertion library (`not-icontains`, `llm-rubric`, …) works too.

## Layout

```
src/provider.ts        promptfoo provider: replays a fixture against a model, records tokens/latency/cost
src/registry.ts        models.yaml loader (${ENV} interpolation)       src/cost.ts   price math
src/assertions.ts      reusable checks                                  src/cut.ts    recordings → fixtures
src/app/               control app: run launcher, results, case builder (public/ is its frontend)
src/import-litellm.ts  LiteLLM spend logs → recordings                  src/record-proxy.ts   pass-through recorder
suites/<name>/         promptfooconfig.yaml, cases.yaml, examples/ (synthetic fixtures)
scripts/audit.ts       refuses to publish private addresses, paths, keys, emails
```

## Status and ideas

Working: provider with per-model pricing, capture from LiteLLM or a proxy, three example suites.
Working: a control app for launching runs and building cases from recordings.
Planned: deployment as a container, a relevance-scoring assertion for ranked picks.

`npm run audit` (and `-- --history`) scans tracked files and git history for LAN addresses,
home paths, key-like strings and personal emails. Run it before pushing.

## License

MIT. See [LICENSE](LICENSE).
