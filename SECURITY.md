# Security Policy

## Supported versions

Until the project reaches 1.0, only the latest published version receives security fixes.

## Report a vulnerability

Do not open a public issue for a suspected vulnerability.

1. Open a private report through [GitHub Security Advisories](https://github.com/rkbkosp/pi-provider-clone/security/advisories/new).
2. Describe the affected version, impact, and reproduction steps.
3. Remove API keys, OAuth tokens, cookies, user data, and unredacted logs from the report.

You should receive an acknowledgement within seven days. Please allow time to investigate and publish a coordinated fix before disclosing the issue publicly.

## Security model

Pi extensions run with the user's full operating-system permissions. Review the source before installing this or any other Pi package.

This extension writes clone metadata to `${PI_CODING_AGENT_DIR:-~/.pi/agent}/provider-clones.json`. It does not read or write Pi credentials, execute shell commands, add telemetry, or introduce network destinations. Requests made through a clone are delegated to the selected source provider.
