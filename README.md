<div align="center">

# Prompt Trials

**Replay the requests your agents really sent against any model, and see which one holds up.**

![Node 26+](https://img.shields.io/badge/node-26%2B-339933?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![promptfoo](https://img.shields.io/badge/built%20on-promptfoo-orange)
![LiteLLM](https://img.shields.io/badge/capture-LiteLLM-informational)
![License: MIT](https://img.shields.io/badge/license-MIT-blue)

[Concepts](#concepts) · [Try it](#try-it-no-model-no-api-key) · [Real models](#run-against-real-models) · [Capture fixtures](#capture-your-own-fixtures) · [Control app](#control-app) · [Configuration](#configuration) · [Assertions](#assertions) · [Tests](#tests) · [Layout](#layout) · [Status](#status-and-ideas)

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
- **Suite**: a folder with a `promptfooconfig.yaml` and its cases, for one kind of job. The repo ships some under
  `suites/`; suites you make in the app live in `user-suites/`.
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

Route the agent through a [LiteLLM](https://docs.litellm.ai/) proxy (or the bundled recording proxy) for a run, then bring the
run in as a **recording**: a folder of the requests it sent and the answers it got. The easiest way is the
[control app](#control-app): its Recordings page lists the proxy's recent runs and imports one with a click. From the
command line:

```
# Option 1: LiteLLM spend logs
LITELLM_URL=http://host:4000 LITELLM_API_KEY=... \
  npm run import-litellm -- --since 2026-01-05T06:00:00Z --until 2026-01-05T07:00:00Z --model my-model --out recordings/job

# Option 2: no LiteLLM, record directly
npm run record -- --upstream http://localhost:11434 --out recordings/job   # then use port 11435

npm run cut -- list recordings/job                                   # conversations and steps
npm run cut -- pick recordings/job/<file>.json fixtures/job/after-first-batch.json
```

LiteLLM needs `store_prompts_in_spend_logs` on and `MAX_STRING_LENGTH_PROMPT_IN_DB` raised
(the default of 2048 characters truncates long messages). The importer reads `proxy_server_request` and
`response` from the spend logs, not the empty `messages` column. A fixture is
`{ messages, tools, reference }`, where `reference` is the answer the original model gave.

Cases built from your recordings go in `suites/<name>/cases.private.yaml` (or, in the app, wherever `PRIVATE_CASES_DIR`
points). Both are gitignored, like `fixtures/` and `recordings/`, because real conversations contain personal data.

## Control app

```
npm run app            # http://127.0.0.1:5180, with promptfoo's viewer proxied on :15500
```

A local web app for the parts of the workflow that are tedious on the command line. It has four areas:

- **New run:** pick a suite, any models from `models.yaml`, repeats and parallelism, and start it. The log streams live and
  the run is kept in `output/runs/`.
- **Runs:** per-model pass rate, average time, tokens (fresh, cached, output) and cost, then a grid with one square per test
  and attempt (failures are striped, so they do not rest on colour alone). Select a square to see what the model actually
  did and why it failed. Filter the list by suite; the choice is remembered. Every run is also stored in promptfoo, and
  "Open in the promptfoo viewer" reuses one browser tab.
- **Recordings:** with `LITELLM_URL` and `LITELLM_API_KEY` set, the page lists the proxy's recent runs (requests close
  together in time, labelled with the skill they invoked), marks the ones already imported, and imports one into a folder
  with a click. Runs you do not care about can be hidden (and shown again), and a recordings folder can be deleted; it is
  copied from the proxy's logs, so it can be imported again. The key needs permission to read spend logs. Open a folder to
  read a conversation step by step and see the answer that was recorded.
- **Cases:** build a case from a recorded step: choose checks from a list, try them against the recorded answer, and save.
  Cases land in the suite's private cases file (the previous version is kept as `.bak`) and the fixture under `fixtures/`.
  Edit or delete them later. A **suite** is a group of cases with a description and checks that apply to all of them. Make
  your own, or copy a shipped one (its cases come along). Your suites live in `user-suites/` outside git, so a redeploy
  keeps them; the suites that ship with the repo stay read-only in the app, so the repo and what the app shows cannot drift
  apart. Deleting a suite moves it to `user-suites/.trash`.

A **GPU guard** warns before a run with a local model when a busy window you configured is active or about to start, or
when Ollama has a different model loaded.

The app is dark by default, with a Light/Dark button and a palette picker in the left rail (five presets or any three
colours of your own). Both choices are remembered per browser. It binds to `127.0.0.1` by default.

### Running it as a container

`docker/Dockerfile` and `docker/compose.example.yaml` run the app and promptfoo's viewer together. Set `TRIALS_AUTH_USER` and
`TRIALS_AUTH_PASSWORD` and both ask for that login (HTTP basic auth, over plain HTTP, so keep it on a network you trust).
The viewer itself only listens on loopback inside the container; the app proxies it behind the same login. Without those
variables there is no login, and the app warns when it listens on anything but localhost.

Persistent state lives in bind-mounted folders (recordings, fixtures, private cases, your suites, run output, promptfoo's
database), plus a read-only `models.yaml` and optional `trials.config.yaml`. `GET /healthz` answers without a login, for
container health checks. Set `LITELLM_URL` and `LITELLM_API_KEY` to enable the import from LiteLLM, and
`SHIPPED_SUITES=hide` to show only your own suites, without the repo's examples.

## Configuration

Settings come from environment variables, or from `trials.config.yaml` (see `trials.config.example.yaml`); a variable wins.

| Variable | Default | What it does |
|---|---|---|
| `HOST`, `PORT` | `127.0.0.1`, `5180` | where the app listens |
| `VIEWER_PORT` | `15500` | the promptfoo viewer behind the app's login; the viewer itself runs on the next port, loopback only |
| `VIEWER=off` | on | do not start the viewer |
| `TRIALS_AUTH_USER`, `TRIALS_AUTH_PASSWORD` | none | require this login (both or neither) |
| `LITELLM_URL`, `LITELLM_API_KEY` | none | where the Recordings page imports runs from |
| `OLLAMA_URL` | none | the GPU guard asks this server which model is loaded |
| `USER_SUITES_DIR` | `user-suites` | suites made in the app |
| `PRIVATE_CASES_DIR` | beside each suite | where each suite's private cases are kept, as `<dir>/<suite>.yaml` |
| `SHIPPED_SUITES=hide` | shown | hide the suites that ship with the repo and their examples |
| `PROMPT_TRIALS_MODELS`, `PROMPT_TRIALS_CONFIG` | `models.yaml`, `trials.config.yaml` | paths to those files |
| `PROMPTFOO_CONFIG_DIR` | `.promptfoo` | where promptfoo keeps its results database |

In `trials.config.yaml` you can also set the folders (`recordingsDir`, `fixturesDir`, `runsDir`, `suitesDir`) and the GPU
guard's `busyWindows` and `lookaheadMinutes`.

## Assertions

Shared checks live in `src/assertions.ts` and are used from a suite's `cases.yaml`:

| Assertion | Catches |
|---|---|
| `onlyOfferedTools` | calling a tool the request never offered, such as `terminal` when the system prompt talks about it but the tool list does not include it |
| `callsTool` / `avoidsTool` | calling `finish` before every batch was read; skipping a required step |
| `validToolArguments` | malformed tool-call JSON, including a `tool_call` wrapper whose `calls` is a string that is not a JSON list |
| `delegatedRefsPreserved` | a model renumbering, inventing or reordering refs when it delegates |
| `noTemplateMarkers` | unexpanded placeholders such as `<the ref>` left in a subagent goal |
| `goalIncludes` | a subagent goal that drops what the subagent cannot look up (the lane id, the covered lists, how to report) |
| `delimitedLines` | plain text for a tool (one record per line, `a \| b \| c`) with the wrong field count, or JSON, code fences, numbering or banned phrases |
| `noRepeatedItems` | adding the same track or item twice |
| `startsWith`, `maxLength` | reply format and length caps |

An MCP wrapper such as `tool_call` (single or batched calls, with `mcp__server__` name prefixes) is unwrapped automatically. Everything else in promptfoo's
assertion library (`not-icontains`, `llm-rubric`, …) works too.

## Tests

```
npm test               # the whole suite runs in a few seconds, with no network and no model
npm run typecheck      # strict TypeScript
npm run audit          # no private addresses, paths, keys or emails in the tracked files (add -- --history for every commit)
```

The tests use Node's built-in runner and fake servers, so nothing leaves your machine. They cover:

- **The checks** (`assertions`, `cost`): every assertion, the `tool_call` wrapper, and the price arithmetic.
- **The provider and registry**: a fake OpenAI-style server checks the request it receives, the tokens and cost it reports (cache reads and writes billed separately), error handling, and the LiteLLM proxy mode.
- **The tools**: the recording proxy (plain and streamed answers), `cut`, and the LiteLLM importer's paging, grouping and "already imported" detection.
- **The app's logic**: suites, cases, run summaries, the GPU guard, login, and the viewer proxy including websocket upgrades.
- **The whole server**: it boots for real and is driven over HTTP, from login to building a case from a recording to a real promptfoo run and cleanup.
- **The frontend**: every script parses, `index.html` only refers to files that exist, and every API path the page calls is a route the server has.

Not covered: what the pages look like and how they behave in a browser. That was checked by hand with a real browser; the
frontend tests only catch the mistakes a build step would.

## Layout

```
src/provider.ts        promptfoo provider: replays a fixture against a model, records tokens/latency/cost
src/registry.ts        models.yaml loader (${ENV} interpolation)       src/cost.ts   price math
src/assertions.ts      reusable checks                                  src/fixture.ts, src/cut.ts   recordings → fixtures
src/litellm.ts         reads runs out of a LiteLLM proxy's spend logs   src/import-litellm.ts, src/record-proxy.ts   capture tools
src/app/               the control app (public/ is its frontend)
docker/                Dockerfile and an example compose file (your own compose.yaml and .env stay untracked)
suites/<name>/         promptfooconfig.yaml, cases.yaml, examples/ (synthetic fixtures)
user-suites/<name>/    suites made in the app (untracked)
test/                  the tests described above
scripts/audit.ts       refuses to publish private addresses, paths, keys, emails
```

## Status and ideas

Working: the provider with per-model pricing, capture from LiteLLM or a recording proxy, three example suites, and the
control app (runs, recordings, cases, suites), which also runs as a container.
Ideas: a relevance-scoring assertion for ranked picks, and a way to tag runs by job so a proxy can report spend per job.


## License

MIT. See [LICENSE](LICENSE).
