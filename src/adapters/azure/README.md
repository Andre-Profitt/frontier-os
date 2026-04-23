# Azure Adapter

Read-only Azure adapter for Frontier OS. Wraps the narrow `@azure/arm-*` SDKs
(which handle auth, retries, and pagination correctly) with `az` CLI as the
whoami fallback. All commands are `mode: read`, `sideEffectClass: none`.

## Authentication

Uses `@azure/identity`'s `DefaultAzureCredential`, which probes in order:

1. Environment variables (`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`)
2. Workload identity (AKS federated credential)
3. Managed identity (when running on Azure VM / App Service)
4. Azure CLI (`~/.azure/` populated via `az login`)
5. Azure PowerShell
6. Azure Developer CLI (`azd`)

For local dev on the user's laptop the `az login` path is what matters — the
SDK picks up `~/.azure/msal_token_cache.*` + `~/.azure/azureProfile.json`
automatically. No env vars required.

The `whoami` command is `az`-first because `az account show` returns a rich
account object in one sync shell round-trip (tenant, subscription, user) that
`DefaultAzureCredential.getToken()` cannot produce without extra Graph calls.
If `az` is not on PATH we fall back to `getToken()` just to confirm
credentials resolve.

Override the binary path: `FRONTIER_AZ_BIN=/path/to/az`.

## Commands

All commands are `mode: read`, `sideEffectClass: none`, `defaultClass: 0`.

| Command                | Arguments                                       | Source                                            |
| ---------------------- | ----------------------------------------------- | ------------------------------------------------- |
| `whoami`               | —                                               | `az account show` → fallback `getToken()`         |
| `list-subscriptions`   | —                                               | `@azure/arm-subscriptions` `SubscriptionClient`   |
| `list-resource-groups` | `subscriptionId` (or env)                       | `@azure/arm-resources` `ResourceManagementClient` |
| `list-resources`       | `subscriptionId` (or env), `resourceGroupName?` | `@azure/arm-resources` `ResourceManagementClient` |

### Examples

```bash
frontier run azure whoami
frontier run azure list-subscriptions
frontier run azure list-resource-groups --arg subscriptionId=<sub-uuid>
frontier run azure list-resources --arg subscriptionId=<sub-uuid> --arg resourceGroupName=my-rg
```

## Multiple subscriptions

When the account has more than one subscription:

- `whoami` shows the **active** subscription (the one `az account set` pointed
  at, persisted in `~/.azure/azureProfile.json`).
- `list-subscriptions` enumerates **all** subscriptions the credential can
  see, regardless of the active one.
- `list-resource-groups` / `list-resources` take an explicit
  `subscriptionId` argument. If omitted they fall back to
  `AZURE_SUBSCRIPTION_ID`. If both are missing, the command **fails with a
  hint** pointing at `list-subscriptions` — we do not silently pick the
  first subscription, because that's a footgun when the user has prod and
  non-prod subscriptions under the same tenant.

To switch the active CLI subscription:

```bash
az account set --subscription <sub-uuid-or-name>
```

Or set the env var for a single frontier run:

```bash
AZURE_SUBSCRIPTION_ID=<sub-uuid> frontier run azure list-resources
```

## Performance

The `@azure/identity` + `@azure/arm-*` imports are **lazy** — loaded inside the
command handlers, not at module top-level — so frontier-os's startup does not
pay the ~15 MB import cost just because `azure` is registered. `whoami`
actually does zero SDK imports on the happy path (the `az` CLI fallback is a
plain `child_process.spawn`).
