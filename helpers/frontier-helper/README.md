# Frontier Helper Scaffold

This directory holds the native privileged-helper scaffold for Frontier OS.

Current state:

- The production LaunchDaemon is not installed.
- `frontier helper *` runs a user-mode simulator with the same fixed verb allowlist.
- Class 0 verbs are read-only introspection.
- Class 2+ verbs require policy approval before any real helper implementation may execute them.
- Class 3 verbs are denied by default.

The helper must never expose an arbitrary root shell or wildcard file access.
