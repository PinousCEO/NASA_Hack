# Mission AI Core

The AI engineering core for a shared MR/Web mission-design workspace. It takes a
natural-language request, works out what is being asked, discovers which capabilities
can do it, assesses feasibility, plans and executes a dependency graph of tasks, and
puts any change to the mission through preview, automated tests and human approval
before publishing a new mission version to every connected client.

## Run it

```bash
npm install
npm run dev        # http://127.0.0.1:8787  (web workspace, REST API, WebSocket, MCP)
npm test           # 80+ tests, including live JPL Horizons and MCP round-trips
npm run typecheck
npm run mcp        # "mission-core" MCP server over stdio (read-only tools)
```

Requires Node 22+. State is stored under `.data/` (delete it to start again from
`config/seed-mission.json`).

**Language model.** Set `ANTHROPIC_API_KEY` to enable model-based request analysis,
multi-tool planning and TypeScript generation (`claude-opus-5-5` by default; override with
`MISSION_AI_MODEL`). Requests use the API's server-side refusal fallback. Without
credentials the system still runs: a rule-based analyser handles common requests, and
anything that needs a model is reported as *requires additional resources* rather than
approximated.

**Network exposure.** The server binds to loopback by default (`HOST`, `PORT` to change).
The API trusts the caller's stated `user: { id, role }`; it does not authenticate. Put it
behind the workspace's real authentication before exposing it to a LAN or headsets.

## How a request flows

```
text ─► inspect state ─► requirement analysis ─► memory lookup ─► planning ─► feasibility
                                                                                  │ proceed?
        publish + broadcast ◄─ approval ◄─ preview + tests ◄─ execution (draft workspace)
```

| Stage | Module | What it does |
|---|---|---|
| Capability registry | `src/registry/` | Structured metadata for every capability (schemas, dependencies, permissions, resources, constraints, availability, version, verification status). Discovery by text, tag, category, permission; health checks; execution statistics; alternatives for failure recovery. |
| Requirement analysis | `src/pipeline/requirements.ts` | Text → operations in ten categories. Asks for clarification only when a required value has no safe default; records every value it assumed. |
| Planning | `src/pipeline/planner.ts` | Operations → task graph. Recipes name the *kind* of capability needed (a `provides` tag) and the registry resolves it; free-form requests are planned by the model from the live catalogue, and its plan is validated. |
| Feasibility | `src/pipeline/feasibility.ts` | Classifies the request (feasible / with modifications / requires additional resources / requires further research / currently unsupported / scientifically unverified) and states the basis of every finding. Engineering findings come from a dry run of the deterministic models. |
| Execution | `src/pipeline/executor.ts` | Parallel where dependencies allow, timeouts, retries with backoff, result validation, fallback to alternative capabilities, cancellation, rollback. |
| Runtime builder | `src/capabilities/`, `src/assets/`, `src/sandbox/` | Parametric GLB generation, glTF→GLB conversion, component and scene changes, model-generated TypeScript validated by a policy scan, a strict type-check against the controlled API, and a run in a QuickJS/WebAssembly sandbox. |
| Preview, approval, deployment | `src/pipeline/proposals.ts`, `src/state/store.ts` | Diff, affected components, recalculated consequences, automated tests, role-gated approval, immutable versions, rollback. |
| Recalculation | `src/state/recalc.ts` | Derived results form a dependency graph; a change recomputes only what is downstream of it. Broadcasts carry the configuration *and* the recalculated results. |
| Research memory | `src/memory/memory.ts` | Append-only records with provenance, model ids, assumptions and verification level; lexical similarity search; training eligibility requires consent, quality review and validated evidence. |
| Observability | request `trace` | Per request: tools selected and why, inputs, outputs, tests, and the approval or rejection with its reason. |

### Evidence levels

Every result carries one of: `independently_verified`, `deterministic_calculation`,
`external_data`, `heuristic`, `model_judgment`, `unverified`. Nothing is promoted
implicitly. Model output stays `model_judgment`; a proposal built on it is flagged, and
the automated tests say what they do and do not establish.

### Safety model

Capabilities cannot modify the shared mission. They write to a per-request **draft
workspace**; a failed or cancelled plan discards it. Scripts and assets can only be added
through their validating capabilities. Generated code never runs in the host process:
it executes in QuickJS compiled to WebAssembly with time and memory limits, no Node, no
network, and a five-function API through which it can read state, run calculations and
*propose* changes. (QuickJS was chosen over Lua because generated modules are TypeScript.)

## Capabilities

21 are registered; `GET /api/capabilities` is the source of truth.

- **Mission state** — `mission.inspect`, `mission.propose_patch`, `mission.add_component`, `mission.attach_script`, `script.run`, `memory.search`
- **Scientific calculation** — `science.orbit.elements`, `science.orbit.hohmann`, `science.ephemeris.sun`, `science.power.budget`, `science.comms.link_budget`, `science.rover.mobility`, `science.terrain.slope_analysis`
- **Simulation** — `simulation.power_timeline`
- **Assets** — `asset.generate_parametric`, `asset.gltf_to_glb`
- **Code** — `code.generate_module` (needs a model), `code.validate_module`
- **External data** — `data.horizons.vectors` (NASA/JPL Horizons, live)
- **Planned, not implemented** — `asset.text_to_3d`, `data.terrain.dem`. They are listed so the gap is visible; they cannot be selected or executed.

### Adding capabilities

In-process: `defineCapability({...})` with zod input/output schemas and register it in
`src/app.ts`. External: add an MCP server to `config/mcp-servers.json`; its tools are
discovered from the server and registered automatically.

```json
{
  "servers": [
    {
      "name": "terrain",
      "transport": { "type": "stdio", "command": "node", "args": ["path/to/server.js"] },
      "provides": { "get_dem": ["data.terrain.dem"] },
      "outputVerification": "external_data"
    },
    { "name": "remote", "transport": { "type": "http", "url": "https://example.org/mcp" } }
  ]
}
```

`provides` maps a tool to the tags recipes look for; without it the tool is still
available to the model planner. External output is `unverified` unless configured otherwise.

## Interfaces

**REST** (`/api`): `capabilities` (search, describe, `:id/execute`, `refresh`) ·
`mission` (current, `versions`, `rollback`) · `requests` (submit, get, `trace`,
`clarify`, `cancel`) · `proposals` (get, `approve`, `reject`) · `memory` (`search`, add,
`:id/review`, `training-eligible`) · `health`.

**WebSocket** (`/ws`): `mission.snapshot` on connect, then `mission.version_published`
(config + derived results + which nodes were recalculated), `request.updated`,
`proposal.created`, `capability.changed`. An MR client consumes the same messages as the
web client and loads assets from `/assets/*.glb`.

**MCP** (`/mcp`, Streamable HTTP; or stdio): discovery tools, every read-only capability,
and `mission_request` / `request_trace`. Approval is not exposed over MCP.

Roles: `viewer` (read), `engineer` (request changes, approve minor ones), `lead`
(approve significant changes, roll back, quality-review memory).

## Scientific models and their limits

Two-body orbits; analytic Sun/planet positions from JPL's approximate Keplerian elements
(cross-checked against Horizons in the test suite: within 3 arcminutes and 5×10⁻⁴ AU);
cylindrical-shadow eclipse at the solar beta angle; orbit-average power budget;
standard RF link equation; rigid-wheel rover statics. Each result lists its assumptions.
Not modelled: orbital perturbations, thermal, radiation, soil mechanics, attitude.
Beta angle is exact for Earth, approximate for the Moon, and worst-case for Mars.

## Status

- Verified here: the full pipeline without a model, sandbox isolation, GLB output
  (loads in three.js), HTTP/WebSocket broadcast, MCP in both directions, Horizons.
- **Not exercised against the live API:** the model-driven paths. They are type-checked
  against the SDK and tested with a scripted stand-in, but no credentials were available.
- **Not built:** an MR client (the web client and the WebSocket protocol are), real
  authentication, generative text-to-3D, terrain DEM retrieval.
- Proposals awaiting approval live in memory and are lost on restart; versions, request
  traces and research memory are persisted.
