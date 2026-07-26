# Contributing

Thanks for helping improve Pi Provider Clone.

## Before opening an issue

- Search existing issues first.
- Include Pi, plugin, Node.js, and operating-system versions.
- Provide minimal reproduction steps and the exact error message.
- Remove API keys, OAuth tokens, cookies, account identifiers, and sensitive prompt or tool output.
- Report vulnerabilities privately as described in [SECURITY.md](./SECURITY.md).

## Development

Requirements: Node.js 22.19.0 or newer and npm.

```bash
git clone https://github.com/rkbkosp/pi-provider-clone.git
cd pi-provider-clone
npm ci
npm run check
npm pack --dry-run
```

Pi executes TypeScript extensions directly, so no compile step or committed build output is required.

## Pull requests

1. Keep changes focused and add tests for behavior changes.
2. Preserve provider credential isolation and never access Pi's credential files directly.
3. Keep Pi core imports as `"*"` peer dependencies; Pi supplies them at runtime.
4. Update README and CHANGELOG when user-visible behavior changes.
5. Ensure `npm run check` and `npm pack --dry-run` pass.
6. Use clear, conventional commit messages when practical.

By contributing, you agree that your contribution is licensed under the project's MIT License.
