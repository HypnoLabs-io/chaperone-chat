# Security policy

## Reporting a vulnerability

Please report it privately, through GitHub's private vulnerability reporting on this repository (the Security tab,
then "Report a vulnerability"). Don't open a public issue.

Say what you found, how to reproduce it, and what it lets someone do. Use made-up data only.

## In scope

- Forging a link token, or using one beyond its participant, its kind or its expiry.
- Reading or writing a conversation without its link, or acting on the moderators' handler without passing
  `authorizeModerator`.
- Message text reaching events, logs, errors or notices.
- Input that makes the rules run for a long time.
- A message delivered without being checked, when it should have waited.

## Not a vulnerability

A message the screen misses is a gap in detection, and so is a clean message it refuses. Neither is a
vulnerability. Open a regular issue with a made-up example, never a real person's details.

## Supported versions

The latest release.

## How the package is meant to be secure

See the [security model](docs/security.md).
