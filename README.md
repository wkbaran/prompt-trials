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
