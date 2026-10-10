# prompt-trials

Run recorded chat snapshots (messages + tool schemas) against candidate models and compare
pass rate, tokens, latency and cost. Built on [promptfoo](https://www.promptfoo.dev/) with a
small custom provider; `promptfoo view` is the web UI.

## Setup

    npm install
    cp models.example.yaml models.yaml     # endpoints, keys (by env var name), prices per Mtok
    npx promptfoo eval -c suites/smoke/promptfooconfig.yaml --no-cache
    npm run view

- A **suite** is a folder under `suites/` with a `promptfooconfig.yaml` and its cases.
- A **case** is a fixture JSON `{ messages, tools?, tool_choice? }`, referenced from a test as
  `vars: { fixture: path }` (relative to the repo root, so run promptfoo from there).
- Provider path in a suite config is relative to that config: `file://../../src/provider.ts`.
- Cost comes from the prices in `models.yaml` (input, output, cache read, cache write), or from a
  LiteLLM proxy's `x-litellm-response-cost` header when `litellm.baseUrl` is set.
- `fixtures/` and `models.yaml` are gitignored: real fixtures contain personal reading history.

## Getting fixtures

Two ways to capture the exact requests an agent sends (messages incl. system prompt, and tools):

1. **LiteLLM spend logs** (preferred if you already run a LiteLLM proxy). Point the agent at the
   proxy for one run, then:

       LITELLM_URL=http://host:4000 LITELLM_API_KEY=... \
         npm run import-litellm -- --since 2026-10-10T06:00:00Z --model qwen --out recordings/medium

   The proxy needs `store_prompts_in_spend_logs` on, and `MAX_STRING_LENGTH_PROMPT_IN_DB` raised
   (default 2048 truncates long messages; use e.g. 500000). Read `proxy_server_request` and
   `response`, not the empty `messages` column. Rows appear up to a minute after the call.
2. **Recording proxy** (no LiteLLM): `npm run record -- --upstream http://localhost:11434 --out recordings/medium`
   and point the agent at port 11435.

Then `npm run cut -- list recordings/medium` and
`npm run cut -- pick recordings/medium/<file>.json fixtures/medium-digest/<name>.json`.
Each request an agent makes carries the whole conversation so far, so every recorded request is a
snapshot at a decision point; the recorded answer is kept as `reference`.
