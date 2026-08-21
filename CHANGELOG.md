# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Cancel in-flight clone/delete commands during session replacement and make clone-store persistence abortable so stale command contexts cannot resume after `/reload`, `/new`, `/resume`, or `/fork` and commit state into a replacement runtime.
- Restore an active native clone when Pi 0.84.x replaces it with an incomplete named runtime overlay, preventing OAuth clones from failing with `Provider is not configured` while leaving complete foreign providers untouched.

## [0.2.1] - 2026-08-09

### Changed

- Updated `typescript-eslint` from 8.65.0 to 8.66.0 for development linting and type-aware ESLint tooling.
- Updated the pinned CodeQL GitHub Actions from 4.37.4 to 4.37.6.

## [0.2.0] - 2026-08-08

### Added

- `/delete-cloned-provider` command for safely unregistering and removing saved provider clones while leaving Pi-managed credentials untouched.

### Changed

- Updated development and compatibility validation to Pi 0.84.1 while retaining Pi 0.82.1 as the minimum supported version.
- Grouped future `@earendil-works/pi-*` Dependabot updates so related Pi packages advance together.

### Fixed

- Restore saved providers in the awaited async extension factory so cloned providers participate in initial default-model and thinking-level selection and `pi --list-models`.

### Security

- Updated the `brace-expansion` override to 5.0.9 and refreshed the lockfile to patched transitive dependency versions.

## [0.1.0] - 2026-07-26

### Added

- `/clone-provider` interactive command.
- Independent provider IDs and Pi credential scopes.
- Provider authentication, model filtering, and streaming delegation.
- Source/clone identity bridging for multi-turn tool-call compatibility.
- Atomic, permission-restricted clone-definition persistence.
- Startup and reload restoration of saved clones.
- Unit tests, CI, security scanning, and release documentation.

[Unreleased]: https://github.com/rkbkosp/pi-provider-clone/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/rkbkosp/pi-provider-clone/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/rkbkosp/pi-provider-clone/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/rkbkosp/pi-provider-clone/releases/tag/v0.1.0
