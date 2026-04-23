// Thin CDP session wrapper around chrome-remote-interface.
// Raw CDP is the transport choice for this first spike — Playwright's
// connectOverCDP comes later when we need frame/target/network-event plumbing.

import CDP from "chrome-remote-interface";

export interface CdpAttachOptions {
  host?: string;
  port?: number;
  target?: string; // target id OR url substring; undefined = first matching page
  matchUrl?: (url: string) => boolean;
  /** If true, install the frontier page-side helper after attaching. */
  installHelper?: boolean;
}

const DEFAULT_HOST = "localhost";
const DEFAULT_PORT = 9222;

export interface TabSummary {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string | undefined;
  attached: boolean;
}

export async function listTabs(
  opts: Pick<CdpAttachOptions, "host" | "port"> = {},
): Promise<TabSummary[]> {
  const host = opts.host ?? DEFAULT_HOST;
  const port = opts.port ?? DEFAULT_PORT;
  const raw = await CDP.List({ host, port });
  return raw.map((t: any) => ({
    id: t.id,
    type: t.type,
    title: t.title,
    url: t.url,
    webSocketDebuggerUrl: t.webSocketDebuggerUrl,
    attached: Boolean(t.attached),
  }));
}

export async function pickPageTarget(
  opts: CdpAttachOptions = {},
): Promise<TabSummary> {
  const tabs = await listTabs({
    host: opts.host ?? DEFAULT_HOST,
    port: opts.port ?? DEFAULT_PORT,
  });
  const pages = tabs.filter((t) => t.type === "page");
  if (pages.length === 0) {
    throw new Error(
      `no page targets available on ${opts.host ?? DEFAULT_HOST}:${
        opts.port ?? DEFAULT_PORT
      } — is Chrome running with --remote-debugging-port?`,
    );
  }
  if (opts.target) {
    const byId = pages.find((t) => t.id === opts.target);
    if (byId) return byId;
    const byUrl = pages.find((t) => t.url.includes(opts.target as string));
    if (byUrl) return byUrl;
    throw new Error(
      `no page target matches "${opts.target}" (tried id + url substring)`,
    );
  }
  if (opts.matchUrl) {
    const matched = pages.find((t) => opts.matchUrl!(t.url));
    if (matched) return matched;
    throw new Error(`no page target matched custom matchUrl predicate`);
  }
  // Default: first non-devtools, non-extension page.
  const ranked = pages.filter(
    (t) =>
      !t.url.startsWith("chrome://") &&
      !t.url.startsWith("devtools://") &&
      !t.url.startsWith("chrome-extension://"),
  );
  return ranked[0] ?? pages[0]!;
}

export interface CdpSession {
  client: Awaited<ReturnType<typeof CDP>>;
  target: TabSummary;
  helperInstalled: boolean;
  close(): Promise<void>;
}

export async function attach(opts: CdpAttachOptions = {}): Promise<CdpSession> {
  const target = await pickPageTarget(opts);
  const client = await CDP({
    host: opts.host ?? DEFAULT_HOST,
    port: opts.port ?? DEFAULT_PORT,
    target: target.id,
  });
  const session: CdpSession = {
    client,
    target,
    helperInstalled: false,
    async close() {
      try {
        await client.close();
      } catch {
        /* already closed */
      }
    },
  };
  if (opts.installHelper) {
    // Lazy import to avoid circular deps (install.ts imports CdpSession from here).
    const { installHelper } = await import("./inject/install.ts");
    await installHelper(session);
    session.helperInstalled = true;
  }
  return session;
}

export interface EvaluateOptions {
  expression: string;
  awaitPromise?: boolean;
  returnByValue?: boolean;
  timeout?: number;
  worldName?: string;
}

export async function evaluate<T = unknown>(
  session: CdpSession,
  opts: EvaluateOptions,
): Promise<T> {
  const { Runtime } = session.client;
  const callOpts: any = {
    expression: opts.expression,
    awaitPromise: opts.awaitPromise ?? true,
    returnByValue: opts.returnByValue ?? true,
  };
  if (opts.timeout !== undefined) callOpts.timeout = opts.timeout;
  const response = await Runtime.evaluate(callOpts);
  if (response.exceptionDetails) {
    const msg =
      response.exceptionDetails.exception?.description ??
      response.exceptionDetails.text ??
      "Runtime.evaluate exception";
    throw new Error(`page eval failed: ${msg}`);
  }
  return response.result.value as T;
}
