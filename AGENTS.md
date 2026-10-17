# Notes for agents

Things that surprised earlier agents in this project.

- **LiteLLM spend logs can silently lose requests.** For a local model routed through LiteLLM's `openai/` provider to an
  Ollama `/v1` endpoint, the spend log's `request_id` is the backend's response id, `chatcmpl-<0..998>`. That is about
  1000 possible ids, and the id is the table's primary key, so as the table fills, new requests collide with old rows and
  are not stored (about half were missing by day 8 of one deployment). Models routed through `ollama_chat/` or hosted
  providers get unique ids and are not affected. Signs: a conversation whose message count jumps by more than its own
  answer plus tool results between two logged requests, and `request_id`s that are all short `chatcmpl-NNN` values.
  Recordings imported with `import-litellm` or the app are then incomplete, and the missing steps cannot be recovered
  from the proxy. The later requests of a conversation still carry the earlier turns in their `messages`, so a missing
  step's input can be rebuilt by truncating a later request. `record-proxy` does not have this problem. The fix is to
  read the proxy's S3 request logs instead (`S3_LOGS_BUCKET`, see `src/s3-logs.ts` and the README): object names carry the
  start time to the microsecond. On the proxy, `s3_callback_params` must come *before* `success_callback` in
  `config.yaml`; set through the admin API or the database (whose JSON does not keep key order) the logger is built
  without its bucket and uploads go to `none.s3.none.amazonaws.com`.
- **Fixture paths in a suite's cases are relative to the repo root**, not to the suite folder, so run
  `npx promptfoo eval -c suites/<name>/promptfooconfig.yaml` from the root.
