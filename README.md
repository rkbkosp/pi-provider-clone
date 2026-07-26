# Pi Provider Clone

[![CI](https://github.com/rkbkosp/pi-provider-clone/actions/workflows/ci.yml/badge.svg)](https://github.com/rkbkosp/pi-provider-clone/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@rkbkosp/pi-provider-clone.svg)](https://www.npmjs.com/package/@rkbkosp/pi-provider-clone)
[![license](https://img.shields.io/npm/l/@rkbkosp/pi-provider-clone.svg)](./LICENSE)

A [Pi](https://github.com/earendil-works/pi) extension that clones an existing model provider under a new provider ID and credential scope.

![Pi Provider Clone preview](https://raw.githubusercontent.com/rkbkosp/pi-provider-clone/main/docs/preview.png)

```text
openai-codex/gpt-5.5
openai-codex-personal/gpt-5.5
openai-codex-work/gpt-5.5
```

Each clone reuses the source provider's authentication flow, API implementation, endpoints, headers, and model definitions. Model IDs, names, capabilities, limits, and pricing stay unchanged; only `model.provider` is rewritten so Pi can store and select credentials independently.

## Why

Pi keys credentials by `providerId`. One provider therefore maps to one stored OAuth session or API key. This extension lets you keep multiple accounts side by side without forking model definitions or implementing custom authentication.

| Goal | How this extension helps |
| --- | --- |
| Personal and work OAuth accounts | Clone once per account, then run `/login` for each clone |
| Multiple API keys for one vendor | Store each key under a separate provider ID |
| Native model selection | `/model` shows the same model under every provider ID |

## Requirements

- Pi `0.81.1` or a compatible newer release
- Node.js `22.19.0` or newer, matching Pi's runtime requirement

## Install

### npm

```bash
pi install npm:@rkbkosp/pi-provider-clone
```

Try it without a persistent install:

```bash
pi -e npm:@rkbkosp/pi-provider-clone
```

### GitHub

```bash
pi install git:github.com/rkbkosp/pi-provider-clone
```

Pin a release when reproducibility matters:

```bash
pi install git:github.com/rkbkosp/pi-provider-clone@v0.1.0
```

### Local checkout

```bash
git clone https://github.com/rkbkosp/pi-provider-clone.git
cd pi-provider-clone
npm ci
pi -e .
```

For a persistent local install, run `pi install .` from the repository root.

## Usage

1. Start Pi with the extension loaded.
2. Run `/clone-provider`.
3. Select a source provider.
4. Enter a target provider ID such as `openai-codex-personal`.
5. Authenticate the clone:

   ```text
   /login openai-codex-personal
   ```

6. Open `/model` and search by provider ID or `provider/modelId`.

Target provider IDs must match:

```regex
^[a-z0-9][a-z0-9._-]*$
```

The target must differ from the source, must not already be registered, and must not be another clone target. Cloning a clone is not supported in v1.

### Delete a clone

Run:

```text
/delete-cloned-provider
```

Select a saved clone and confirm the deletion. The command immediately unregisters a clone owned by this extension and removes its definition from `provider-clones.json`. If the target ID is currently occupied by another provider, only the saved clone definition is deleted; the conflicting provider is left untouched.

Pi credentials are stored separately and are **not** deleted by this command. Run `/logout` and select the clone ID if you also want to remove its saved OAuth session or API key. If the deleted clone was active, use `/model` to select another model before sending the next prompt.

## Storage and privacy

Clone definitions are stored at:

```text
${PI_CODING_AGENT_DIR:-~/.pi/agent}/provider-clones.json
```

The extension writes only `sourceId`, `targetId`, and `createdAt`. It creates the file with mode `0600` where the platform supports POSIX permissions and does not read or modify project files.

The extension does **not**:

- read, copy, log, or persist tokens and API keys;
- read or modify Pi's `auth.json` or `models.json`;
- add telemetry or analytics;
- contact any new network endpoint; or
- execute shell commands.

Credentials remain in Pi's normal credential store under each clone's provider ID. Model requests are delegated to the selected source provider implementation and therefore use that provider's configured endpoint and privacy terms. A source provider's environment-variable credential fallback is also inherited; run `/login <clone-id>` to store a distinct credential.

## Behavior and limitations

- Clones use a static model snapshot rebuilt on Pi startup or `/reload`.
- Source authentication behavior is reused, including environment-variable fallbacks.
- Streaming and tool-call context are bridged so Responses-style item IDs stay paired with the source implementation.
- Clones cannot be cloned again.
- Clones can be deleted with `/delete-cloned-provider`; clone rename is not supported in v1.
- There is no credential copying, account rotation, automatic failover, or telemetry.
- Changes to the source model catalog appear after restart or `/reload`.
- Removing the package does not delete `provider-clones.json`; remove that file manually if you also want to erase saved clone definitions.

## Update and uninstall

```bash
pi update npm:@rkbkosp/pi-provider-clone
pi remove npm:@rkbkosp/pi-provider-clone
```

Pinned npm versions, Git tags, and commits do not drift during normal package updates. Install a new explicit version or ref to move a pinned installation.

## Development

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run check
npm pack --dry-run
```

Pi loads TypeScript extensions directly, so this package has no separate build artifact. The Pi packages imported at runtime are declared as `"*"` peer dependencies and are supplied by Pi; exact development versions are pinned only for repeatable tests.

See [DEV.md](./docs/DEV.md) for design constraints and [CONTRIBUTING.md](./CONTRIBUTING.md) for contribution guidelines.

## Support and security

- Bugs and feature requests: [GitHub Issues](https://github.com/rkbkosp/pi-provider-clone/issues)
- Security vulnerabilities: follow [SECURITY.md](./SECURITY.md) and use a private GitHub Security Advisory
- Release history: [CHANGELOG.md](./CHANGELOG.md)

## License

[MIT](./LICENSE) © 2026 rkbkosp
