# Work IQ Tools canvas (POC)

A "quick and dirty" Copilot canvas that lets a user browse **Work IQ**
(Microsoft 365) tools and add one to their current Foundry project. It is **embedded
into the main `foundry-workflow-canvas` extension** (the repo's root `extension.mjs`),
not a separate extension — one extension hosts multiple canvases.

## What it does

1. Lists Work IQ tools available/creatable in the current Foundry project — pulled
   live from the same anonymous Foundry tool catalog the `ai-mlstudio` extension uses
   (`ai.azure.com/.../entities/crossRegion`, entries tagged `workiq`), plus the
   hardcoded **Work IQ Chat** A2A row.
2. Shows current project + signed-in identity (`azd env get-values` + `az account show`).
3. On **Add to project**, hands the intent to the Copilot session
   (`session.send(...)`). The agent then uses the `microsoft-foundry` skill
   (`tool-work-iq`) to create the connection, add it to the agent's toolbox, wire
   `TOOLBOX_ENDPOINT`, cover the Work IQ Entra/consent prerequisites, and clean-restart
   the local agent so it's testable in the Agent Inspector.

The page itself never holds secrets — tokens come from the Azure CLI on demand.

## How it's wired into the extension

`workiq-canvas.mjs` is a library, not a standalone entrypoint. The root `extension.mjs`
imports it and registers the Work IQ canvases alongside the workflow + inspector canvases:

```js
import { createWorkIqCanvases, setWorkIqSession } from "./workiq-canvas/workiq-canvas.mjs";

const session = await joinSession({
  canvases: [
    /* foundry-workflow-canvas */,
    /* foundry-agent-inspector */,
    ...createWorkIqCanvases(createCanvas, { projectRoot: PROJECT_ROOT }),
  ],
});
setWorkIqSession(session); // enables the Add-to-project hand-off
```

- `createWorkIqCanvases(createCanvas, { projectRoot })` returns the canvas objects for
  the ids `foundry-workiq` and `foundry-workiq-v2`. Pass the host extension's resolved
  `PROJECT_ROOT` so azd context resolves to the repo, not this nested file.
- `setWorkIqSession(session)` provides the Copilot session used by `/api/add-tool`.

## When it opens

The canvas (`foundry-workiq`, and `foundry-workiq-v2` for local testing) is opened by
Copilot when the user's prompt mentions integrating their agent with Office /
Microsoft 365 / Teams / Outlook / email / meetings / messages — see the
`microsoft-foundry` skill's Work IQ section.

## Run standalone (without Copilot)

`workiq-canvas.mjs` can still be run directly to preview the page in a browser:

```pwsh
node workiq-canvas/workiq-canvas.mjs
# open the printed http://127.0.0.1:<port>/ URL
```

In standalone mode the catalog list and project banner work; **Add to project**
logs the hand-off prompt to the console instead of sending it to a session.

## Prerequisites

- Node 18+ (uses global `fetch`)
- `az` CLI (`az login`) for identity
- `azd` with an initialized Foundry project for project context
- `@github/copilot-sdk` is provided by the Copilot runtime when run as an extension
