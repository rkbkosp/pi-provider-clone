## Summary

<!-- What changed and why? -->

## Validation

- [ ] `npm run check`
- [ ] `npm pack --dry-run`
- [ ] Tests added or updated when behavior changed
- [ ] README and CHANGELOG updated when user-visible behavior changed
- [ ] No credentials, private data, generated logs, or local Pi configuration included

## Security and compatibility

- [ ] Credential isolation remains provider-ID scoped
- [ ] The extension does not read or modify Pi credential files
- [ ] Pi core imports remain `"*"` peer dependencies
