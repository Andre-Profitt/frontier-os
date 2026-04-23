// Azure adapter — WRAPS first-party @azure/arm-* SDKs for auth + retries,
// with the `az` CLI used only as the whoami fallback path.
//
// Design:
// - whoami: `az account show` first (fast, no SDK import, returns the user's
//   logged-in tenant + subscription straight from ~/.azure/). If `az` is
//   missing we fall back to DefaultAzureCredential.getToken() to at least
//   confirm credential resolution.
// - list-subscriptions / list-resource-groups / list-resources: pure SDK paths
//   via DefaultAzureCredential. The `@azure/identity` + `@azure/arm-*` imports
//   are all inside async handlers so frontier-os's ~3s startup does NOT pay
//   the ~15 MB import cost just to have this adapter declared in the registry.
// - Every handler returns an AdapterResult — never throws on missing auth.
//   The `failedResult` path carries a hint telling the user exactly what to do
//   (run `az login`, or set AZURE_SUBSCRIPTION_ID).
//
// Subscription resolution:
//   list-resource-groups / list-resources require a subscriptionId. We accept
//   it via `invocation.arguments.subscriptionId`. If absent we fall back to
//   `process.env.AZURE_SUBSCRIPTION_ID`. If still absent we fail with a hint
//   pointing at `frontier run azure list-subscriptions` so the caller can pick
//   one. We do NOT auto-pick from `az account show` — that's ambiguous when
//   the user has multiple subs and silently picking one is worse than asking.

import { adapterCommandSpec, type AdapterImpl } from "../../registry.ts";
import { buildResult, failedResult } from "../../result.ts";
import type {
  AdapterInvocation,
  AdapterManifest,
  AdapterResult,
} from "../../schemas.ts";

import { azBin, runAz } from "./az-cli.ts";

// ---- arg coercion ----

function optionalString(
  invocation: AdapterInvocation,
  key: string,
): string | undefined {
  const args = (invocation.arguments ?? {}) as Record<string, unknown>;
  const raw = args[key];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error(
      `${invocation.command} arguments.${key} must be a non-empty string`,
    );
  }
  return raw.trim();
}

function resolveSubscriptionId(
  invocation: AdapterInvocation,
): string | undefined {
  const fromArgs = optionalString(invocation, "subscriptionId");
  if (fromArgs) return fromArgs;
  const fromEnv = process.env["AZURE_SUBSCRIPTION_ID"];
  if (fromEnv && fromEnv.trim() !== "") return fromEnv.trim();
  return undefined;
}

// ---- command handlers ----

/**
 * whoami — prefer `az account show` (fast, no SDK import), fall back to
 * DefaultAzureCredential.getToken() if az is missing. This is the canonical
 * "does auth work?" probe.
 */
async function whoamiCommand(
  invocation: AdapterInvocation,
  timeoutMs: number | undefined,
): Promise<AdapterResult> {
  const run = await runAz(["account", "show", "--output", "json"], timeoutMs);

  // Case 1: az is missing → fall back to DefaultAzureCredential.getToken().
  if (run.spawnError) {
    const err = run.spawnError as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return whoamiViaCredential(invocation);
    }
    return failedResult(invocation, new Error(`az: ${err.message}`), {
      observedState: {
        invocation: { argv: run.argv, exitCode: null, signal: null },
        error: err.message,
      },
    });
  }

  // Case 2: az ran but failed (e.g. not logged in).
  if (run.code !== 0) {
    const stderrTrim = run.stderr.trim();
    // Try the credential fallback — DefaultAzureCredential can succeed via
    // env vars / managed identity even if `az login` hasn't been done.
    const fallback = await whoamiViaCredential(invocation);
    if (fallback.status === "success") {
      return fallback;
    }
    const hint = stderrTrim.includes("az login")
      ? " (run `az login` to sign in)"
      : "";
    return failedResult(
      invocation,
      new Error(
        `az account show failed: ${stderrTrim || `exit ${run.code}`}${hint}`,
      ),
      {
        observedState: {
          invocation: {
            argv: run.argv,
            exitCode: run.code,
            signal: run.signal,
          },
          stderr: stderrTrim,
        },
      },
    );
  }

  // Case 3: az succeeded — parse its JSON.
  let parsed: unknown;
  try {
    parsed = JSON.parse(run.stdout);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return failedResult(
      invocation,
      new Error(`az account show: failed to parse JSON (${reason})`),
      {
        observedState: {
          invocation: {
            argv: run.argv,
            exitCode: run.code,
            signal: run.signal,
          },
          rawStdout: run.stdout.slice(0, 4000),
        },
      },
    );
  }

  const acct = (parsed ?? {}) as Record<string, unknown>;
  const user = (acct["user"] ?? {}) as Record<string, unknown>;
  const userName = typeof user["name"] === "string" ? user["name"] : "unknown";
  const tenantId =
    typeof acct["tenantId"] === "string" ? acct["tenantId"] : "?";
  const subId = typeof acct["id"] === "string" ? acct["id"] : "?";
  const subName = typeof acct["name"] === "string" ? acct["name"] : "?";
  const state = typeof acct["state"] === "string" ? acct["state"] : "?";

  return buildResult({
    invocation,
    status: "success",
    summary: `${userName} | sub=${subName} (${subId}) | tenant=${tenantId} | state=${state}`,
    observedState: {
      source: "az_cli",
      invocation: { argv: run.argv, exitCode: run.code, signal: run.signal },
      user: userName,
      tenantId,
      subscriptionId: subId,
      subscriptionName: subName,
      state,
      account: acct,
    },
    verification: {
      status: "passed",
      checks: ["trace_grade"],
    },
  });
}

/**
 * Fallback whoami path: lazy-import @azure/identity and call
 * DefaultAzureCredential.getToken(). We don't get a rich account object — just
 * confirmation that credentials resolved and a token was issued.
 */
async function whoamiViaCredential(
  invocation: AdapterInvocation,
): Promise<AdapterResult> {
  try {
    const { DefaultAzureCredential } = await import("@azure/identity");
    const cred = new DefaultAzureCredential();
    const token = await cred.getToken("https://management.azure.com/.default");
    if (!token) {
      return failedResult(
        invocation,
        new Error(
          `DefaultAzureCredential returned no token (is '${azBin()}' on PATH, or AZURE_* env vars set? try \`az login\`)`,
        ),
        {
          observedState: {
            source: "default_azure_credential",
            tokenIssued: false,
          },
        },
      );
    }
    return buildResult({
      invocation,
      status: "success",
      summary: `DefaultAzureCredential resolved (expiresOn=${new Date(token.expiresOnTimestamp).toISOString()}); az CLI not available for richer whoami`,
      observedState: {
        source: "default_azure_credential",
        tokenIssued: true,
        expiresOnTimestamp: token.expiresOnTimestamp,
      },
      verification: {
        status: "passed",
        checks: ["trace_grade"],
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return failedResult(
      invocation,
      new Error(
        `DefaultAzureCredential.getToken failed: ${message} (try \`az login\` or set AZURE_TENANT_ID/AZURE_CLIENT_ID/AZURE_CLIENT_SECRET)`,
      ),
      {
        observedState: {
          source: "default_azure_credential",
          tokenIssued: false,
        },
      },
    );
  }
}

/**
 * list-subscriptions — `@azure/arm-subscriptions` v6 narrowed its surface to
 * subscription-lifecycle operations and no longer exposes a tenant-wide list.
 * We therefore call the ARM REST endpoint directly using a bearer token from
 * DefaultAzureCredential. Same SDK-backed auth path, no extra dep. Pagination
 * is handled via the `nextLink` field.
 *
 * (The `@azure/arm-subscriptions` install is still justified — a future
 * follow-up can use its SubscriptionClient for cancel/rename/accept-ownership
 * flows when we widen the write surface.)
 */
async function listSubscriptionsCommand(
  invocation: AdapterInvocation,
): Promise<AdapterResult> {
  try {
    const { DefaultAzureCredential } = await import("@azure/identity");
    const cred = new DefaultAzureCredential();
    const token = await cred.getToken("https://management.azure.com/.default");
    if (!token) {
      return failedResult(
        invocation,
        new Error(
          "DefaultAzureCredential returned no token (try `az login`, or set AZURE_TENANT_ID/AZURE_CLIENT_ID/AZURE_CLIENT_SECRET)",
        ),
      );
    }

    interface SubSummary {
      id: string | undefined;
      subscriptionId: string | undefined;
      displayName: string | undefined;
      state: string | undefined;
      tenantId: string | undefined;
    }
    interface SubListPage {
      value?: Array<Record<string, unknown>>;
      nextLink?: string;
    }

    const subs: SubSummary[] = [];
    let url: string | undefined =
      "https://management.azure.com/subscriptions?api-version=2022-12-01";
    while (url) {
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${token.token}` },
      });
      if (!resp.ok) {
        const body = await resp.text();
        return authOrFailed(
          invocation,
          new Error(
            `ARM subscriptions list returned HTTP ${resp.status}: ${body.slice(0, 400)}`,
          ),
          "list-subscriptions",
        );
      }
      const page = (await resp.json()) as SubListPage;
      for (const sub of page.value ?? []) {
        subs.push({
          id: typeof sub["id"] === "string" ? (sub["id"] as string) : undefined,
          subscriptionId:
            typeof sub["subscriptionId"] === "string"
              ? (sub["subscriptionId"] as string)
              : undefined,
          displayName:
            typeof sub["displayName"] === "string"
              ? (sub["displayName"] as string)
              : undefined,
          state:
            typeof sub["state"] === "string"
              ? (sub["state"] as string)
              : undefined,
          tenantId:
            typeof sub["tenantId"] === "string"
              ? (sub["tenantId"] as string)
              : undefined,
        });
      }
      url = page.nextLink;
    }

    return buildResult({
      invocation,
      status: "success",
      summary: `found ${subs.length} subscription(s)`,
      observedState: {
        source: "arm_rest",
        count: subs.length,
        subscriptions: subs,
      },
      verification: {
        status: "passed",
        checks: ["trace_grade"],
      },
    });
  } catch (err) {
    return authOrFailed(invocation, err, "list-subscriptions");
  }
}

/**
 * list-resource-groups — needs subscriptionId. Lazy-imports @azure/arm-resources.
 */
async function listResourceGroupsCommand(
  invocation: AdapterInvocation,
): Promise<AdapterResult> {
  const subscriptionId = resolveSubscriptionId(invocation);
  if (!subscriptionId) {
    return failedResult(
      invocation,
      new Error(
        "list-resource-groups requires arguments.subscriptionId or AZURE_SUBSCRIPTION_ID env var (run `frontier run azure list-subscriptions` to pick one)",
      ),
    );
  }

  try {
    const { DefaultAzureCredential } = await import("@azure/identity");
    const { ResourceManagementClient } = await import("@azure/arm-resources");

    const cred = new DefaultAzureCredential();
    const client = new ResourceManagementClient(cred, subscriptionId);

    interface RgSummary {
      id: string | undefined;
      name: string | undefined;
      location: string | undefined;
      tags: Record<string, string> | undefined;
      provisioningState: string | undefined;
    }
    const groups: RgSummary[] = [];
    for await (const rg of client.resourceGroups.list()) {
      groups.push({
        id: rg.id,
        name: rg.name,
        location: rg.location,
        tags: rg.tags,
        provisioningState: rg.properties?.provisioningState,
      });
    }

    return buildResult({
      invocation,
      status: "success",
      summary: `subscription ${subscriptionId}: ${groups.length} resource group(s)`,
      observedState: {
        source: "arm_resources",
        subscriptionId,
        count: groups.length,
        resourceGroups: groups,
      },
      verification: {
        status: "passed",
        checks: ["trace_grade"],
      },
    });
  } catch (err) {
    return authOrFailed(invocation, err, "list-resource-groups");
  }
}

/**
 * list-resources — needs subscriptionId; resourceGroupName optional.
 * Scope: subscription-wide when no rg given, else scoped to that rg.
 */
async function listResourcesCommand(
  invocation: AdapterInvocation,
): Promise<AdapterResult> {
  const subscriptionId = resolveSubscriptionId(invocation);
  if (!subscriptionId) {
    return failedResult(
      invocation,
      new Error(
        "list-resources requires arguments.subscriptionId or AZURE_SUBSCRIPTION_ID env var (run `frontier run azure list-subscriptions` to pick one)",
      ),
    );
  }

  let resourceGroupName: string | undefined;
  try {
    resourceGroupName = optionalString(invocation, "resourceGroupName");
  } catch (err) {
    return failedResult(invocation, err);
  }

  try {
    const { DefaultAzureCredential } = await import("@azure/identity");
    const { ResourceManagementClient } = await import("@azure/arm-resources");

    const cred = new DefaultAzureCredential();
    const client = new ResourceManagementClient(cred, subscriptionId);

    interface ResourceSummary {
      id: string | undefined;
      name: string | undefined;
      type: string | undefined;
      location: string | undefined;
      kind: string | undefined;
      tags: Record<string, string> | undefined;
    }
    const resources: ResourceSummary[] = [];
    const iter = resourceGroupName
      ? client.resources.listByResourceGroup(resourceGroupName)
      : client.resources.list();
    for await (const r of iter) {
      resources.push({
        id: r.id,
        name: r.name,
        type: r.type,
        location: r.location,
        kind: r.kind,
        tags: r.tags,
      });
    }

    const scope = resourceGroupName
      ? `rg=${resourceGroupName}`
      : "subscription-wide";
    return buildResult({
      invocation,
      status: "success",
      summary: `subscription ${subscriptionId} (${scope}): ${resources.length} resource(s)`,
      observedState: {
        source: "arm_resources",
        subscriptionId,
        resourceGroupName: resourceGroupName ?? null,
        count: resources.length,
        resources,
      },
      verification: {
        status: "passed",
        checks: ["trace_grade"],
      },
    });
  } catch (err) {
    return authOrFailed(invocation, err, "list-resources");
  }
}

/**
 * stop-resource — deallocate an Azure VM via ARM REST (POST ../deallocate).
 * `destructive_action` side effect, class-3 in the manifest: Ghost Shift must
 * always refuse, and even interactive use must clear a class-≥3 human gate.
 *
 * Propose mode: looks up the VM (GET) to confirm it exists and echoes the exact
 * POST URL that apply would hit. No state changes.
 * Apply mode: issues POST .../deallocate?api-version=2024-07-01 and surfaces
 * the `Azure-AsyncOperation` header so callers can poll to completion. We do
 * NOT block on the long-running operation here — the operator can use the
 * returned pollUrl, or just re-run `list-resources` to confirm state.
 *
 * Args: subscriptionId (or AZURE_SUBSCRIPTION_ID), resourceGroupName, vmName.
 * `mode` may optionally override the action (`deallocate` default, or `power-off`
 * — NOT recommended because power-off keeps billing the VM).
 */
async function stopResourceCommand(
  invocation: AdapterInvocation,
): Promise<AdapterResult> {
  const subscriptionId = resolveSubscriptionId(invocation);
  if (!subscriptionId) {
    return failedResult(
      invocation,
      new Error(
        "stop-resource requires arguments.subscriptionId or AZURE_SUBSCRIPTION_ID env var",
      ),
    );
  }
  let resourceGroupName: string | undefined;
  let vmName: string | undefined;
  let stopMode = "deallocate";
  try {
    resourceGroupName = optionalString(invocation, "resourceGroupName");
    vmName = optionalString(invocation, "vmName");
    const modeRaw = optionalString(invocation, "stopMode");
    if (modeRaw) stopMode = modeRaw;
  } catch (err) {
    return failedResult(invocation, err);
  }
  if (!resourceGroupName) {
    return failedResult(
      invocation,
      new Error("stop-resource requires arguments.resourceGroupName"),
    );
  }
  if (!vmName) {
    return failedResult(
      invocation,
      new Error("stop-resource requires arguments.vmName"),
    );
  }
  if (stopMode !== "deallocate" && stopMode !== "power-off") {
    return failedResult(
      invocation,
      new Error(
        `stop-resource arguments.stopMode must be "deallocate" (default) or "power-off"; got "${stopMode}"`,
      ),
    );
  }

  const apiVersion = "2024-07-01";
  const action = stopMode === "power-off" ? "powerOff" : "deallocate";
  const vmUrl =
    `https://management.azure.com/subscriptions/${subscriptionId}` +
    `/resourceGroups/${encodeURIComponent(resourceGroupName)}` +
    `/providers/Microsoft.Compute/virtualMachines/${encodeURIComponent(vmName)}`;
  const actionUrl = `${vmUrl}/${action}?api-version=${apiVersion}`;

  const sideEffect = {
    class: "destructive_action" as const,
    target: `azure vm ${subscriptionId}/${resourceGroupName}/${vmName}`,
    summary: `would ${action} VM ${vmName} (stops the instance; deallocate also releases compute billing)`,
  };

  // Propose mode: confirm the VM exists, echo the would-be POST, no mutation.
  if (invocation.mode === "propose") {
    try {
      const { DefaultAzureCredential } = await import("@azure/identity");
      const cred = new DefaultAzureCredential();
      const token = await cred.getToken(
        "https://management.azure.com/.default",
      );
      if (!token) {
        return failedResult(
          invocation,
          new Error(
            "propose: DefaultAzureCredential returned no token (run `az login` or set AZURE_* env)",
          ),
        );
      }
      const getUrl = `${vmUrl}?api-version=${apiVersion}&$expand=instanceView`;
      const resp = await fetch(getUrl, {
        headers: { Authorization: `Bearer ${token.token}` },
      });
      const rawBody = await resp.text();
      let vmBody: Record<string, unknown> | null = null;
      try {
        vmBody = rawBody
          ? (JSON.parse(rawBody) as Record<string, unknown>)
          : null;
      } catch {
        vmBody = null;
      }
      const vmExists = resp.ok;
      const vmState = (() => {
        const props = (vmBody?.["properties"] ?? {}) as Record<string, unknown>;
        const iv = (props["instanceView"] ?? {}) as Record<string, unknown>;
        const statuses = Array.isArray(iv["statuses"])
          ? (iv["statuses"] as Array<Record<string, unknown>>)
          : [];
        const powerStatus = statuses.find(
          (s) =>
            typeof s["code"] === "string" &&
            (s["code"] as string).startsWith("PowerState/"),
        );
        return typeof powerStatus?.["displayStatus"] === "string"
          ? (powerStatus["displayStatus"] as string)
          : null;
      })();
      return buildResult({
        invocation,
        status: "success",
        summary: vmExists
          ? `propose: would ${action} VM ${vmName} (currently ${vmState ?? "unknown"})`
          : `propose: VM lookup returned HTTP ${resp.status}; apply would still POST ${actionUrl}`,
        observedState: {
          mode: "propose",
          subscriptionId,
          resourceGroupName,
          vmName,
          action,
          stopMode,
          vmExists,
          vmState,
          vmLookupStatus: resp.status,
          vmLookupBody: rawBody.slice(0, 2000),
          applyWould: {
            method: "POST",
            url: actionUrl,
            expectedAsyncHeader: "Azure-AsyncOperation",
          },
        },
        sideEffects: [sideEffect],
        verification: {
          status: "passed",
          checks: ["trace_grade"],
        },
      });
    } catch (err) {
      return authOrFailed(invocation, err, "stop-resource (propose)");
    }
  }

  // Apply mode: real POST — destructive.
  try {
    const { DefaultAzureCredential } = await import("@azure/identity");
    const cred = new DefaultAzureCredential();
    const token = await cred.getToken("https://management.azure.com/.default");
    if (!token) {
      return failedResult(
        invocation,
        new Error(
          "apply: DefaultAzureCredential returned no token (run `az login` or set AZURE_* env)",
        ),
      );
    }
    const resp = await fetch(actionUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.token}`,
        "Content-Length": "0",
      },
    });
    const rawBody = await resp.text();
    if (!resp.ok) {
      return failedResult(
        invocation,
        new Error(
          `stop-resource: ARM returned HTTP ${resp.status}: ${rawBody.slice(0, 400)}`,
        ),
        {
          observedState: {
            mode: "apply",
            subscriptionId,
            resourceGroupName,
            vmName,
            action,
            httpStatus: resp.status,
            body: rawBody.slice(0, 2000),
          },
        },
      );
    }
    const asyncHeader =
      resp.headers.get("azure-asyncoperation") ??
      resp.headers.get("Azure-AsyncOperation") ??
      null;
    const locationHeader = resp.headers.get("location") ?? null;
    return buildResult({
      invocation,
      status: "success",
      summary: `${action} accepted for VM ${vmName} (HTTP ${resp.status}); poll ${asyncHeader ?? locationHeader ?? "Azure-AsyncOperation"} for completion`,
      observedState: {
        mode: "apply",
        subscriptionId,
        resourceGroupName,
        vmName,
        action,
        stopMode,
        httpStatus: resp.status,
        pollUrl: asyncHeader ?? locationHeader,
        body: rawBody.slice(0, 2000),
      },
      sideEffects: [
        {
          ...sideEffect,
          summary: `${action} POST accepted for VM ${vmName} (long-running op; poll ${asyncHeader ?? locationHeader ?? "async header"} for terminal state)`,
        },
      ],
      verification: {
        status: "passed",
        checks: ["trace_grade", "policy"],
      },
    });
  } catch (err) {
    return authOrFailed(invocation, err, "stop-resource (apply)");
  }
}

/**
 * Translate SDK / credential exceptions into a failedResult carrying a
 * specific hint. We never rethrow — the executor expects a result object.
 */
function authOrFailed(
  invocation: AdapterInvocation,
  err: unknown,
  command: string,
): AdapterResult {
  const message = err instanceof Error ? err.message : String(err);
  const looksLikeAuth =
    /credential|authenticate|token|login|unauthorized|AADSTS|401/i.test(
      message,
    );
  const hint = looksLikeAuth
    ? " (try `az login`, or set AZURE_TENANT_ID/AZURE_CLIENT_ID/AZURE_CLIENT_SECRET)"
    : "";
  return failedResult(invocation, new Error(`${command}: ${message}${hint}`), {
    observedState: {
      source: "azure_sdk",
      error: message,
      authLikely: looksLikeAuth,
    },
  });
}

// ---- dispatcher ----

type CommandHandler = (
  invocation: AdapterInvocation,
  timeoutMs: number | undefined,
) => Promise<AdapterResult>;

const HANDLERS: Record<string, CommandHandler> = {
  whoami: whoamiCommand,
  "list-subscriptions": (inv) => listSubscriptionsCommand(inv),
  "list-resource-groups": (inv) => listResourceGroupsCommand(inv),
  "list-resources": (inv) => listResourcesCommand(inv),
  "stop-resource": (inv) => stopResourceCommand(inv),
};

export async function createAzureAdapter(
  manifest: AdapterManifest,
): Promise<AdapterImpl> {
  return {
    manifest,
    async invoke(invocation: AdapterInvocation): Promise<AdapterResult> {
      // 1. Manifest sanity — command must be declared.
      const spec = adapterCommandSpec(manifest, invocation.command);
      // 2. Mode must be supported.
      if (!spec.supportedModes.includes(invocation.mode)) {
        return failedResult(
          invocation,
          new Error(
            `command "${invocation.command}" does not support mode "${invocation.mode}"`,
          ),
        );
      }
      // 3. Handler exists.
      const handler = HANDLERS[invocation.command];
      if (!handler) {
        return failedResult(
          invocation,
          new Error(
            `azure adapter has no handler for command "${invocation.command}" yet`,
          ),
        );
      }
      const timeoutSec = invocation.policy?.maxRuntimeSeconds;
      const timeoutMs =
        typeof timeoutSec === "number" && timeoutSec > 0
          ? timeoutSec * 1000
          : undefined;
      try {
        return await handler(invocation, timeoutMs);
      } catch (err) {
        return failedResult(invocation, err);
      }
    },
  };
}
