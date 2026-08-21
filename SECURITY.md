# Security Policy

flare-idp is an identity provider; security reports are taken seriously and handled with priority.

## Supported versions

The project is in early development (0.x). Only the latest release on `main` receives fixes.

| Version | Supported |
|---|---|
| latest `0.x` release | ✅ |
| anything older | ❌ |

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Use GitHub's private vulnerability reporting for this repository:
<https://github.com/andersro93/flare-idp/security/advisories/new>

Include as much of the following as you can: affected version/commit, a description of the issue and its impact, reproduction steps or a proof of concept, and any suggested fix.

You can expect an acknowledgement within 72 hours and a status update at least every 7 days until the issue is resolved. Fixes are released as a patch version with a GitHub Security Advisory and credit to the reporter (unless you prefer to stay anonymous).

## Scope notes

- Secrets (`AUTH_SECRET`, `SETUP_SECRET`, provider keys) must be provided through Wrangler secrets / `.dev.vars`; never commit them. The CI and git hooks do not scan for secrets — please report any accidental leak immediately.
- The spike configuration in the Phase 0 scaffold (`packages/api/src/auth.ts`, `packages/api/src/app.ts`) is explicitly **not** a production configuration and is replaced in Phase 1; deploying the scaffold as an IdP is unsupported.
