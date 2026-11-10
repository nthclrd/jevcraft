# layacraft

Autonomous, adaptive Minecraft bot. Give it a goal in plain language ("Find diamond", "build a cute house") or talk to it
in the game chat. **Laya** (an open-source, local System 1 decision engine) makes every fast decision; an **LLM** plans,
designs structures, answers players and recovers when stuck. Game rules come from game data, world knowledge is learned.
Built on mineflayer, and it joins a server on any machine it can reach.

```
            goal / player chat
                    │
    ┌───────────────▼───────────────┐  rare: plan, blueprint design, chat, recovery, world facts
    │  STRATEGIST (LLM, System 2)   │  milestones with machine-checkable completion
    └───────────────┬───────────────┘
                    │ current milestone
    ┌───────────────▼───────────────┐  every step, from game data + what the bot has seen:
    │  ACQUISITION PLANNER (code)   │  cheapest chain to obtain anything (craft / smelt / mine with the right
    │                               │  tool / kill), materials for structures, what is doable right now
    └───────────────┬───────────────┘
    ┌───────────────▼───────────────┐  one request per step (fan-out): skill + target per skill + danger score
    │  TACTICIAN (Laya, System 1)   │  local, single forward pass, calibrated choice/score/yes-no answers
    └───────────────┬───────────────┘
    ┌───────────────▼───────────────┐  MINE CRAFT SMELT EXPLORE DIG_DOWN STRIP_MINE HUNT GOTO SHELTER SURFACE BUILD
    │  SKILLS (code)                │  deterministic, abortable, watchdog, opportunity lookout
    └───────────────┬───────────────┘
    ┌───────────────▼───────────────┐  lava, drowning, fight/flee, urgent eating; preempts any skill
    │  REFLEXES (code, 4 Hz)        │
    └───────────────────────────────┘
```

## Decision engine: Laya

[Laya](https://github.com/NandhaKishorM/laya) answers typed questions in a single forward pass: a `choice` picks one of
several options with probabilities, a `score` places the state on an ordinal scale, and a `noul` gives the probability
that a statement is true. Its `laya-serve` exposes the same `POST /v1/systemone` wire protocol as the hosted Jev API, so
the tactician's requests are unchanged — but the model runs on your own hardware: Apache-2.0 weights, no API key, no
per-token bill, nothing sent to a third party.

The tactician still builds the action space in code and sends one request per step: a `skill` head, a speculative
`target_<skill>` head for every offered skill, and a `danger` score. Laya only picks among options the plan says are
executable; every answer is validated against those options before anything runs.

## Principles

- **Code verifies, models choose.** Milestones complete when a predicate is true (`have diamond 1`, `at_or_below_y -58`,
  `near_block`, `built house`), never because a model says so.
- **Nothing game-specific is hard-coded.** Recipes, block drops, harvest tools, food and mob categories come from the
  game registry. Where blocks generate and what smelting produces are asked once from the LLM, validated against the
  registry, cached, then corrected by observation.
- **It learns from its own experience** (`memory/`): the heights and biomes where each block was actually seen, the real
  yield of every block it breaks (loot tables are often wrong), how often each creature appears, each skill's success
  rate, remembered places per world (hashed seed), death causes, and strategist lessons.
- **Laya only picks among valid options.** The action space is rebuilt every step. The model never sees coordinates or
  does arithmetic; counts, recipe trees and depths are computed in code. EXPLORE options describe each heading (biomes,
  water, trees, animals, open caves, explored or not). A Laya *score* question rates danger; the code enforces a safety
  action when it is high.
- **Escalation, not loops.** Low confidence asks the LLM in the background; `STUCK`, repeated failures or no progress ask
  it in the foreground; a step no skill can act on is reported in chat and skipped.
- **Fair perception by default**: only blocks touching open space and close or in line of sight. `--xray` reads chunks.
- **Creative mode is detected**: items are spawned on demand, no gathering, no survival concerns.

## Run

Needs Node.js 20+ and, for the decision engine, Python 3.10+ (or a `laya-serve` reachable over HTTP). The Laya CPU
quickstart wants roughly 8 GB of RAM and 10 GB of free disk for the checkpoint.

```bash
# 0. get the code and dependencies (skip the clone if you already have a checkout)
git clone https://github.com/ProCoda/layacraft.git
cd layacraft
npm ci

# 1. decision engine, local and free: first run creates .venv and installs laya[serve]
npm run laya

# 2. bot, in another terminal
npm start -- --goal "Find diamond"

# optional: a Paper test server on this machine (accepts the Minecraft EULA)
./scripts/setup-server.sh && npm run server
```

If you are trying an unmerged pull request, check out its branch in your clone instead of `main`:
`git fetch origin`, then `git switch --track origin/<branch>`. `npm ci` installs exactly the dependencies in
`package-lock.json` for that branch.

`npm run laya` serves `LAYA_MODELS=english` on `127.0.0.1:8000`. Override it as needed:

```bash
LAYA_DEVICE=cuda npm run laya                       # NVIDIA GPU
LAYA_MODELS=english,multilingual npm run laya       # also handles non-English player chat
LAYA_HOST=0.0.0.0 LAYA_API_KEY=long-secret npm run laya   # serve another machine on the LAN
```

If you prefer to manage it yourself, any equivalent works: `pip install "laya[serve]" && laya-serve` (or Laya's Docker
image). Then set `LAYA_URL`, and `LAYA_API_KEY` when the server requires a bearer token.

The strategist needs an LLM. The default provider is the local `claude` CLI (your Claude subscription); set
`LLM_PROVIDER`/`LLM_API_KEY` for Anthropic or any OpenAI-compatible endpoint. See the table below.

Connect a 1.21.4 client to the server to watch. In the game chat, any sentence is an instruction the bot answers and
acts on ("go get your stuff back", "build me a tower instead"). Commands: `!goal <text>`, `!stop`, `!status`, `!plan`,
`!usage`.

## Joining a server on another machine

The bot is an ordinary Minecraft Java client, so it can join any server it can reach over the network.

```bash
npm start -- --host play.example.com --goal "Find diamond"
npm start -- --host 192.168.1.20:25566 --goal "Find diamond"
MC_HOST=mc.example.net MC_PORT=25566 MC_AUTH=microsoft MC_USER=you@example.com npm start
```

`--host` / `MC_HOST` accepts `host`, `host:port`, `[ipv6]:port` and bare IPv6 addresses. A hostname on the default port
uses the server's `_minecraft._tcp` SRV record, so proxies and hostnames work without extra flags. `--port` / `MC_PORT`
overrides a port embedded in the address. On the server side the port (usually TCP 25565) must be open in its firewall,
the server must listen on a reachable interface (`server-ip=0.0.0.0`), and it must be port-forwarded if it is behind NAT.
`scripts/setup-server.sh` binds to `127.0.0.1` by default; run it on the server machine with `SERVER_IP=0.0.0.0` to make
it reachable, plus `ONLINE_MODE=true` if players should sign in with real Minecraft accounts.

### Authentication

| Scenario | Setting |
| --- | --- |
| Open server (`online-mode=false`) | `MC_AUTH=offline` (default); `MC_USER` is any name |
| Real Mojang/Microsoft accounts (`online-mode=true`) | `MC_AUTH=microsoft`, `MC_USER` = the Microsoft account identifier (email); the in-game name comes from the account profile |
| Login/register plugin (AuthMe and friends) | `MC_PASSWORD=secret`, or `MC_REGISTER=true`, or a custom `MC_AUTH_COMMAND` |

With `microsoft` auth the first run prints a device-code link to sign in once; the token is cached in the Minecraft
folder's `nmp-cache`, so later runs are silent. Opening an offline-mode server to the internet lets anyone claim any
username — only do that behind a whitelist, a proxy or a login plugin. `MC_AUTH_COMMAND` may use `{username}` and
`{password}`; keep secrets in the environment (`.env` is ignored), never in a tracked config file.

### Drops and restarts

A remote server restarts, kicks and drops idle connections. Unless `MC_RECONNECT=false`, the bot reconnects with
exponential backoff (3 s doubling to 60 s) and resumes a goal that was still running; a goal that already completed is
not restarted. In-game death is handled by respawning, not by reconnecting. `MC_RECONNECT_DELAY` sets the first retry,
in seconds.

### Where the decision engine runs

By default Laya is on the bot's machine (`http://127.0.0.1:8000`), which needs no network exposure. To put it on
another machine on the LAN, start it with `LAYA_HOST=0.0.0.0 LAYA_API_KEY=<secret>` and give the bot
`LAYA_URL=http://<that-machine>:8000 LAYA_API_KEY=<secret>`. Never expose `laya-serve` without the key.

## Configuration

| Env / flag | Default | Meaning |
| --- | --- | --- |
| `LAYA_URL` | `http://127.0.0.1:8000` | `laya-serve` base URL (local or LAN) |
| `LAYA_MODEL` | `auto` | `auto` lets the router choose per request; or `english`, `multilingual`, `typed-decisions` |
| `LAYA_API_KEY` | — | bearer token when `laya-serve` was started with `LAYA_API_KEY` |
| `LAYA_ADVISE_BELOW` | `0.45` | confidence below which background LLM advice is requested |
| `LAYA_TIMEOUT_MS` | `30000` | per-decision HTTP timeout |
| `LLM_PROVIDER` | auto | `claude-cli` (local `claude` CLI, uses your Claude subscription), `anthropic` (`ANTHROPIC_API_KEY`), `openai` (any OpenAI-compatible endpoint: `LLM_API_KEY`, `LLM_BASE_URL`) |
| `LLM_MODEL` | provider default | e.g. `sonnet`, `claude-sonnet-5` |
| `--host` / `MC_HOST` | `localhost` | `host`, `host:port`, `[ipv6]:port` |
| `--port` / `MC_PORT` | port in the host, else `25565` | server port |
| `--user` / `MC_USER` | `Laya` | bot username (Microsoft account identifier with `MC_AUTH=microsoft`) |
| `MC_AUTH` | `offline` | `offline` or `microsoft` |
| `MC_PASSWORD` | — | send `/login <password>` after spawn |
| `MC_REGISTER` | off | send `/register <password> <password>` instead |
| `MC_AUTH_COMMAND` | — | custom login command; `{username}` and `{password}` are substituted |
| `MC_RECONNECT` | on | reconnect with backoff after a kick or drop |
| `MC_RECONNECT_DELAY` | `3` | first retry in seconds; doubles to 60 |
| `--version` / `MC_VERSION` | auto | protocol version |
| `--xray` / `PERCEPTION=xray` | off | omniscient block perception |

Helpers: `npx tsx scripts/say.ts "!goal ..."` sends a chat line as a throwaway player (honours `MC_HOST`/`MC_PORT`),
`npx tsx scripts/rcon.ts "time set day"` talks to the **local** test server's RCON, and
`npx tsx scripts/trial.ts <seed> [minutes] [goal]` runs an unattended trial on a fresh local world and prints a summary.

Cost: Laya is free and local. The strategist is the only paid part (or your Claude subscription with `claude-cli`).
`!usage` and the shutdown log print decision counts, decision tokens and actual LLM usage.

## Layout

| Path | Job |
| --- | --- |
| `src/index.ts` | Connect (local or remote), authenticate, reconnect with backoff, wire the layers together |
| `src/brain/agent.ts` | Orchestrator loop: escalation, watchdog, opportunity lookout, deaths, hunger, chat instructions |
| `src/brain/tactician.ts` | Needs from the planner, dynamic action space, the Laya request (incl. danger score) |
| `src/brain/strategist.ts` | LLM prompts: plan, recovery, world facts, blueprint design, chat instructions |
| `src/brain/plan.ts`, `reflex.ts`, `laya.ts`, `llm.ts` | Predicates, survival reflexes, local decision client, model clients |
| `src/world/acquire.ts` | Generic acquisition planner (reusable tools/stations counted once) |
| `src/world/knowledge.ts` | Learned world knowledge shared across worlds |
| `src/world/blueprint.ts` | Structure expansion, site choice, progress and bill of materials |
| `src/world/directions.ts`, `perception.ts`, `memory.ts`, `crafting.ts`, `creative.ts` | Senses, per-world memory, craft execution plans, creative mode |
| `src/skills/` | Skill library; `craft-window.ts` = acknowledged crafting clicks |
| `src/address.ts`, `config.ts` | Server address parsing (`host:port`, IPv6, SRV-compatible) and configuration |
| `scripts/laya-serve.sh` | Local Laya server: project venv, `laya[serve]`, English checkpoint |

Two mineflayer issues on 1.21 are worked around: a single global window `stateId` (tracked per window in
`protocol-fixes.ts`) and fire-and-forget crafting clicks that silently produce nothing (replaced by acknowledged clicks).

## Status

Early and experimental. Tool progression (wood → stone → iron → diamond depth) works across seeds; survival at night
and long-distance travel remain the weak points. Building and creative mode are new.

Laya answers this bot's action-space questions zero-shot: its checkpoints are trained for typed decisions in general,
not Minecraft, and their own benchmarks name choices with 20+ options as the weakest case. The tactician keeps each
target head at 32 options and lists the plan's next step first to stay inside that, but expect weaker target choice
than a purpose-tuned model. `LAYA_MODEL=typed-decisions` is the closest general-purpose checkpoint, and fine-tuning on a
few hundred logged decisions (Laya's documented path, no paid API) is the way to make it strong here.

## Tests

```bash
npm run typecheck
npm test        # offline: acquisition planner, recipes, plan validation, blueprints, addresses, Laya protocol
```
