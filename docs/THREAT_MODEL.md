# Threat model of labre-mcp

- Status: **draft to validate.** Written from the code and `docs/architecture/` on 2026-11-10, without a workshop. Open questions are at the end; until they are answered the weekly pentester agent of the usine plugin does not run against this server.
- Readers: the weekly pentester agent (skill `hebdo`, pass `exterieur pentest`), the reviewers of a PR touching `src/core/transport/*auth*`, a human taking over.
- This file says where the barriers are and what an attacker would try. It replaces no ADR.

## 1. What we protect

| Asset                 | Where it lives                                                            | Why it matters                              |
| --------------------- | ------------------------------------------------------------------------- | ------------------------------------------- |
| LLM provider keys     | Daemon environment only; `llm.config.json` names the variables            | A leaked key is billed to its owner         |
| The caller's identity | Supabase JWT, OIDC JWT or static `lab_` key, one door each (`LABRE_AUTH`) | A tool call runs on behalf of this identity |
| Run artefacts         | JSON files under `~/.labre-mcp/runs/`, per project                        | They carry the user's strategic maps        |
| The ops secret        | `LABRE_MCP_ADMIN_TOKEN`, shared with the Labre admin console              | It opens `GET /config/llm`                  |
| LLM quota             | Every real strategy calls a provider                                      | An open endpoint is a free LLM proxy        |

## 2. Who attacks

1. **An anonymous caller** of the hosted endpoint (`POST /mcp`, the well-known routes, `/config/llm`).
2. **An authenticated caller** who wants another user's artefacts, or more quota than theirs.
3. **Hostile content**: a map, a component name or a document passed as a tool argument that carries instructions for the LLM behind a strategy.
4. **A local process** on the machine that runs the daemon on loopback.
5. **The supply chain**: an npm package, a shipped recipe or a prompt file altered upstream.

## 3. Barriers

| Barrier                                               | Rule                                                                                                                                               | Source                              |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Auth doors are named, never implicit                  | `LABRE_AUTH` lists the accepted credential families; an unknown entry fails the boot                                                               | `src/core/transport/auth-modes.mts` |
| Loopback by default                                   | `LABRE_HTTP_HOST` defaults to `127.0.0.1`; nothing refuses a boot with no auth door on a public interface, so the deployment must set `LABRE_AUTH` | `docs/architecture/transport.md`    |
| The ops endpoint is opt-in and never returns a secret | `503` when the token is unset, `401` on mismatch, `hasKey` booleans only                                                                           | `docs/architecture/transport.md`    |
| Zod schemas are the runtime contract                  | Every tool input is parsed before use                                                                                                              | `AGENT.md`, rule 8                  |
| The server holds no privileged Labre credential       | It never reads a Labre workspace on its own authority                                                                                              | labre `CLAUDE.md`                   |

## 4. Surfaces and scenarios to try

One surface per week, in turn, against the staging deployment only.

### S1. Authentication doors

- A `tools/call` with no credential at all must fail on the hosted endpoint.
- An expired JWT, a JWT signed by another issuer, a JWT with the wrong audience, a revoked `lab_` key.
- A credential of one family presented when only another door is open.
- `tools/list` and `initialize` without a credential: do they disclose more than the server name?

### S2. Isolation between callers

- The request context (`_context`) is supplied by the caller and is not bound to the authenticated identity: no field of it may steer where the server reads or writes. Try a path-like project identity, an artefact directory and a project root chosen by the caller.
- No tool gives a caller back an artefact written for another caller.
- `runBenchmarkScenario` reachable by a caller outside `LABRE_BENCHMARK_USERS`.

### S3. Prompt injection through tool arguments

- A component name or a map text instructs the strategy's LLM to reveal its system prompt, its provider key, or another caller's data.
- An injected instruction makes `runCommand` or `runRecipe` invoke a strategy the caller did not ask for.
- The JSON-labre envelope returned to the host carries markup the Labre app would render as active content.

### S4. Ops endpoint and error surface

- `GET /config/llm` without the token, with a wrong token, and with a token of the right length (timing).
- An error response echoes a header, an environment value, a stack trace or a provider error containing a key.

### S5. Resource abuse

- One authenticated caller loops a recipe that fans out to many LLM calls. The ceiling is the caller's hourly Labre AI budget (`src/lib/llm/quota-guard.mts`): check that the run is refused once it is spent.
- The guard only bites where a caller JWT exists and fails open: check what bounds a `lab_` API-key caller, and that an unreachable budget answer cannot be provoked by the caller.
- A very large tool argument, a deeply nested JSON-RPC body.

## 5. Rules of engagement

- Target: the staging deployment only, with test credentials. Never production, never a real user's key.
- Forbidden: denial of service, load testing, brute force, any target outside the staging host. S5 is tested with a handful of calls, enough to see whether a ceiling exists.
- Minimal proof: stop at the first read or write that should not pass.
- A proven flaw becomes a `securite` issue and an immediate message to the owner.

## 6. Answered by the owner (2026-11-10)

- The hosted deployment is called by the Labre app (`app.labre.cc`), by its admin console (`admin.labre.cc`, the ops endpoint) and, soon, by the workspace connector (`workspace-mcp.labre.cc`). The same order of sensitivity as Labre applies: payment data, personal data, what users write or draw, configuration, admin data, secrets.
- A per-caller quota on LLM spend exists (S5).

## 7. Still open

1. Which auth doors (`LABRE_AUTH`) are set on the hosted deployment, and is a daemon with no door ever bound to a public interface?
2. Every tool run writes a JSON file of the run, the user's map included, on the server's disk (section 1, run artefacts), and no tool reads it back. On the hosted deployment: keep them, for how long, or stop writing them?
3. The staging host to allow from the cloud environment, and two test credentials in `LABRE_MCP_STAGING_URL`, `LABRE_MCP_TEST_KEY_1` and `LABRE_MCP_TEST_KEY_2`.
