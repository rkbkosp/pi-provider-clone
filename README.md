# Pi Provider Clone

A [Pi](https://github.com/earendil-works/pi) extension that clones an existing model provider under a new provider ID. Each clone gets its own credential-storage key while reusing the source provider's authentication flow, API implementation, endpoints, headers, and model definitions.

```text
openai-codex/gpt-5.5
openai-codex-personal/gpt-5.5
openai-codex-work/gpt-5.5
```

Model IDs, names, capabilities, limits, and pricing stay unchanged. Only `model.provider` is rewritten so Pi stores and selects credentials independently per clone.

## Why

Pi keys credentials by `providerId`. One provider therefore maps to one stored OAuth session or API key. This extension lets you keep multiple accounts side by side without forking models or writing custom auth:

| Goal | How this extension helps |
| --- | --- |
| Personal + work OAuth on the same provider | Clone once per account, then `/login` each clone |
| Multiple API keys for the same vendor | Each clone stores its own key under a new provider ID |
| Pick models in the native UI | `/model` shows `modelId [providerId]` for every clone |

## Requirements

- Pi `0.81.1` or a compatible newer version
- Node.js `22.19.0` or newer

## Install

### Local development

```bash
git clone <this-repo>
cd pi-provider-clone
npm install
pi -e .
```

### Persistent Pi package

```bash
pi install /absolute/path/to/pi-provider-clone
```

### Global extension directory

Copy or symlink the project so Pi discovers `index.ts` as:

```text
~/.pi/agent/extensions/provider-clone/index.ts
```

## Usage

1. Start Pi with the extension loaded.
2. Run:

   ```text
   /clone-provider
   ```

3. Select a source provider.
4. Enter a target provider ID such as `openai-codex-personal`.
5. Authenticate the clone:

   ```text
   /login openai-codex-personal
   ```

6. Open `/model` and search by provider ID or `provider/modelId`.

### Provider ID rules

Target IDs must match:

```regex
^[a-z0-9][a-z0-9._-]*$
```

They must also be different from the source ID, not already registered, and not themselves a previous clone target (clones of clones are not supported in v1).

### Storage

Clone definitions live in:

```text
${PI_CODING_AGENT_DIR:-~/.pi/agent}/provider-clones.json
```

The file stores only:

- `sourceId`
- `targetId`
- `createdAt`

Tokens and API keys are never copied or written there. Credentials remain in Pi's normal auth store under the clone's provider ID.

## Behavior

- Clones use a **static model snapshot** rebuilt on Pi startup or `/reload`.
- Source authentication behavior is reused, including any source environment-variable fallback.
- Run `/login <clone-id>` when you want a credential distinct from the source provider.
- On reload/shutdown (non-quit), registered clones are unloaded so the next session can restore them cleanly from disk.
- Streaming and tool-call context are bridged so Responses-style item IDs stay paired with the source provider implementation.

## Limitations (v1)

- Clones cannot be cloned again.
- No built-in clone deletion or rename UI.
- No credential copying, account rotation, or automatic failover.
- Source model catalog changes apply only after restart or `/reload`.

## Project layout

```text
.
├── index.ts              # Extension entry: command + session restore/unload
├── clone-provider.ts     # Provider cloning and restore helpers
├── stream-bridge.ts      # Stream/context bridging for cloned providers
├── persistence.ts        # Load/save provider-clones.json
├── validation.ts         # Target provider ID validation
├── types.ts              # Shared TypeScript types
├── test/                 # Vitest unit tests
├── DEV.md                # Design notes and Pi behavior research
├── package.json          # Pi package metadata (extensions: ./index.ts)
└── tsconfig.json
```

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run check       # typecheck + test
```

Peer packages (provided by Pi at runtime):

- `@earendil-works/pi-ai`
- `@earendil-works/pi-coding-agent`

Dev pins in this repo target Pi `0.81.1`.

## Manual acceptance checklist

### API-key provider

1. Create a clone.
2. Run `/login <clone-id>` and save a different key from the source.
3. Confirm `/model` shows the same model ID under both provider IDs.
4. Send a normal prompt through each provider.
5. Run `/logout <clone-id>` and verify source authentication remains available.

### OpenAI Codex OAuth

1. Log into `openai-codex` with account A.
2. Clone it twice and log into each clone with separate accounts.
3. For each provider, test a normal conversation, a tool call, the tool result continuation, and a later turn referring to that tool call.
4. Switch within one session: source → clone A → clone B → source.
5. Confirm no Responses item-ID / function-call pairing errors occur and saved assistant messages retain the selected target provider ID.
6. Log out one clone and verify the other provider credentials are unaffected.
7. Restart Pi and run `/reload`; confirm all clones are restored from the current source model catalog.

## Design notes

See [DEV.md](./DEV.md) for the full design background, confirmed Pi behavior, and implementation constraints.

## License

Private / unlicensed unless otherwise stated by the repository owner.
