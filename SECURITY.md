# Security Policy

## Reporting a vulnerability

Please report security issues privately via GitHub's
[Report a vulnerability](https://github.com/tekapo/voynix/security/advisories/new)
form (Security tab → "Report a vulnerability"). Please do not open a public issue
for security problems.

I'll acknowledge reports as soon as I can; this is a personal project maintained
on a best-effort basis.

## Scope

Voynix runs a LAN sync server on the Mac (HTTPS with a self-signed certificate,
SPKI pinning, bearer token, and an approval prompt for new pairings). Issues in
pairing, authentication, certificate handling, or the sync API are especially
welcome. Only the latest release is supported.
