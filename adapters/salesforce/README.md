# Salesforce Adapter

## Purpose

Wrap Salesforce Lightning and dashboard workflows in a semantic control layer.

Because metadata access is unavailable, this adapter should rely on:

- the browser adapter
- an in-page Salesforce helper
- verification by state snapshots and screenshots

## First Scope

- inspect dashboards
- list filters
- change one filter
- enter edit mode
- move one widget
- save and verify

## Public Commands

- `inspect-dashboard`
- `audit-dashboard`
- `list-filters`
- `set-filter`
- `enter-edit-mode`
- `move-widget`
- `save-dashboard`

## Design Rules

- never expose raw Lightning selectors as the public API
- always verify a state change after UI actions
- produce structured artifacts that can be written into memory
- separate `audit` from `apply`

## Helper Responsibilities

The in-page helper should normalize:

- page type
- dashboard title
- widgets
- filters
- dirty state
- save state
- loading and error states
