# Browser Adapter

## Purpose

Own the browser natively through active-session CDP access.

This adapter is the foundation for:

- Chrome control
- Atlas control where the protocol remains compatible
- Salesforce browser-backed automation
- browser evidence capture for audits and verification

## First Scope

- attach to approved active browser sessions
- list tabs
- inspect the current tab
- capture DOM, accessibility tree, console, network, and screenshots
- perform bounded element actions with verification

## Public Commands

- `list-tabs`
- `current-tab`
- `inspect-dom`
- `inspect-network`
- `run-script`
- `click-element`
- `capture-screenshot`

## Evidence Requirements

Every meaningful action should emit:

- a screenshot or DOM snapshot id
- the target tab id
- the page URL
- trace metadata

## Implementation Note

Do not expose CDP domain details as the public contract.

The adapter should hide transport specifics behind semantic CLI commands.
