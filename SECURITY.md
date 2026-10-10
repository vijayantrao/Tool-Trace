# Security policy

## Reporting a vulnerability

Please **don't open a public issue** for security problems. Use GitHub's private reporting instead: on this repository, go to **Security → Report a vulnerability**. Include what you found, how to reproduce it, and the impact you expect.

You'll get an acknowledgement within 7 days. Fixes are released as soon as they're ready, and reporters are credited unless they'd rather not be.

## Scope

In scope: the API (`apps/api`), the web app (`apps/web`), the station firmware (`firmware/station`), database migrations (`db/migrations`) and the CI configuration.

Out of scope: denial-of-service by sheer traffic volume, findings that need physical access to an unlocked device, and the deliberately public test vectors in `firmware/station/test/vectors.json`.

## How ToolTrace is secured

See the [threat model](docs/THREAT_MODEL.md) for the full STRIDE analysis, trust boundaries, defenses mapped to code and tests, and known residual risks.

## Supported versions

Only the latest commit on `main` is supported.
