import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { attach, evaluate, type CdpAttachOptions } from "../cdp.ts";
import { buildResult } from "../../../result.ts";
import type { AdapterInvocation, AdapterResult } from "../../../schemas.ts";

export type ExtractFieldKind = "text" | "value" | "html" | "ariaLabel";

export interface ExtractFieldSpec {
  selector?: string;
  text?: string;
  ariaLabel?: string;
  role?: string;
  attribute?: string;
  kind?: ExtractFieldKind;
  multiple?: boolean;
  required?: boolean;
}

interface ExtractArgs extends CdpAttachOptions {
  fields: Record<string, ExtractFieldSpec>;
  schema?: unknown;
  withHelper?: boolean;
}

export interface ExtractedFieldObservation {
  matchCount: number;
  required: boolean;
  multiple: boolean;
  kind: ExtractFieldKind | "attribute";
}

export interface ExtractEvalResult {
  ok: true;
  extracted: Record<string, unknown>;
  observations: Record<string, ExtractedFieldObservation>;
  missingFields: string[];
}

export interface SchemaValidationResult {
  ok: boolean;
  errors: string[];
}

export async function extractCommand(
  invocation: AdapterInvocation,
): Promise<AdapterResult> {
  const args = (invocation.arguments ?? {}) as unknown as ExtractArgs;
  assertExtractInputs(args);

  const attachOpts: CdpAttachOptions = {};
  if (args.host !== undefined) attachOpts.host = args.host;
  if (args.port !== undefined) attachOpts.port = args.port;
  if (args.target !== undefined) attachOpts.target = args.target;
  attachOpts.installHelper = args.withHelper ?? true;

  const session = await attach(attachOpts);
  try {
    const evaluated = await evaluate<ExtractEvalResult | { ok: false; reason: string }>(
      session,
      {
        expression: buildExtractScript(args.fields),
        awaitPromise: false,
        returnByValue: true,
      },
    );
    if (!evaluated.ok) {
      return buildResult({
        invocation,
        status: "failed",
        summary: evaluated.reason,
        observedState: {
          targetId: session.target.id,
          url: summarizeOutputUrl(session.target.url),
          helperInstalled: session.helperInstalled,
        },
        verification: {
          status: "failed",
          checks: ["trace_grade"],
        },
        suggestedNextActions: defaultSuggestedNextActions(),
      });
    }

    let schemaValidation: SchemaValidationResult | null = null;
    if (args.schema !== undefined) {
      schemaValidation = validateAgainstSchema(args.schema, evaluated.extracted);
    }

    const missingRequired = evaluated.missingFields;
    const schemaErrors = schemaValidation?.errors ?? [];
    const ok = missingRequired.length === 0 && schemaErrors.length === 0;

    const summary = ok
      ? `extracted ${Object.keys(evaluated.extracted).length} field(s) from ${summarizeOutputUrl(session.target.url)}`
      : summarizeFailure(missingRequired, schemaErrors);

    return buildResult({
      invocation,
      status: ok ? "success" : "failed",
      summary,
      observedState: {
        targetId: session.target.id,
        url: summarizeOutputUrl(session.target.url),
        title: session.target.title,
        helperInstalled: session.helperInstalled,
        requested: {
          fieldNames: Object.keys(args.fields),
          schemaProvided: args.schema !== undefined,
        },
        extracted: evaluated.extracted,
        observations: evaluated.observations,
        missingFields: missingRequired,
        schema: schemaValidation
          ? {
              valid: schemaValidation.ok,
              errors: schemaValidation.errors,
            }
          : null,
      },
      verification: {
        status: ok ? "passed" : "failed",
        checks:
          args.schema !== undefined ? ["trace_grade", "schema"] : ["trace_grade"],
      },
      suggestedNextActions: ok ? [] : defaultSuggestedNextActions(),
    });
  } finally {
    await session.close();
  }
}

export function assertExtractInputs(args: ExtractArgs): void {
  if (!isRecord(args.fields) || Object.keys(args.fields).length === 0) {
    throw new Error("extract requires `arguments.fields` (non-empty object)");
  }
  for (const [name, rawSpec] of Object.entries(args.fields)) {
    if (!isRecord(rawSpec)) {
      throw new Error(`extract field "${name}" must be an object`);
    }
    if (
      typeof rawSpec.selector !== "string" &&
      typeof rawSpec.text !== "string" &&
      typeof rawSpec.ariaLabel !== "string"
    ) {
      throw new Error(
        `extract field "${name}" requires at least one locator: selector, text, or ariaLabel`,
      );
    }
    if (
      typeof rawSpec.kind === "string" &&
      !["text", "value", "html", "ariaLabel"].includes(rawSpec.kind)
    ) {
      throw new Error(
        `extract field "${name}" has unsupported kind "${rawSpec.kind}"`,
      );
    }
    if (
      typeof rawSpec.attribute === "string" &&
      rawSpec.attribute.trim().length === 0
    ) {
      throw new Error(`extract field "${name}" attribute must be non-empty`);
    }
  }
}

export function buildExtractScript(
  fields: Record<string, ExtractFieldSpec>,
): string {
  return `(() => {
    const fields = ${JSON.stringify(fields)};
    const normalize = (value) =>
      String(value ?? '').replace(/\\s+/g, ' ').trim();
    const lower = (value) => normalize(value).toLowerCase();
    const isVisible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const implicitRole = (el) => {
      if (!el) return '';
      const explicit = lower(el.getAttribute && el.getAttribute('role'));
      if (explicit) return explicit;
      const tag = String(el.tagName || '').toLowerCase();
      const type = lower(el.getAttribute && el.getAttribute('type'));
      if (tag === 'a' && el.hasAttribute && el.hasAttribute('href')) return 'link';
      if (tag === 'button') return 'button';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'select') return el.multiple ? 'listbox' : 'combobox';
      if (el.isContentEditable) return 'textbox';
      if (tag === 'input') {
        if (['button', 'image', 'reset', 'submit'].includes(type)) return 'button';
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        return 'textbox';
      }
      return '';
    };
    const readValue = (el, spec) => {
      if (!el) return null;
      if (typeof spec.attribute === 'string' && spec.attribute.length > 0) {
        return el.getAttribute ? el.getAttribute(spec.attribute) : null;
      }
      const kind = typeof spec.kind === 'string' ? spec.kind : 'text';
      if (kind === 'html') {
        return typeof el.innerHTML === 'string' ? el.innerHTML : null;
      }
      if (kind === 'ariaLabel') {
        return normalize(el.getAttribute && el.getAttribute('aria-label')) || null;
      }
      if (kind === 'value') {
        if ('value' in el && typeof el.value === 'string') return el.value;
        return normalize(el.textContent || '') || null;
      }
      if ('value' in el) {
        const tag = String(el.tagName || '').toLowerCase();
        if (['input', 'option', 'select', 'textarea'].includes(tag) && typeof el.value === 'string') {
          return el.value;
        }
      }
      if (el.isContentEditable) return normalize(el.textContent || '') || null;
      return normalize(el.textContent || '') || null;
    };
    const readAssociatedText = (el) => {
      const values = [];
      const push = (value) => {
        const normalized = normalize(value);
        if (normalized) values.push(normalized);
      };
      push(el.getAttribute && el.getAttribute('aria-label'));
      push(el.getAttribute && el.getAttribute('placeholder'));
      push(el.getAttribute && el.getAttribute('name'));
      push(el.getAttribute && el.getAttribute('title'));
      push(el.id);
      push(readValue(el, {}));
      if (el.labels && el.labels.length > 0) {
        for (const label of el.labels) push(label.textContent || '');
      }
      const ancestorLabel = el.closest && el.closest('label');
      if (ancestorLabel) push(ancestorLabel.textContent || '');
      return values.join(' | ');
    };
    const matches = (el, spec) => {
      if (!el || !isVisible(el)) return false;
      const role = implicitRole(el);
      if (spec.role && role !== lower(spec.role)) return false;
      const ariaLabel = normalize(el.getAttribute && el.getAttribute('aria-label'));
      if (spec.ariaLabel && !ariaLabel.includes(normalize(spec.ariaLabel))) {
        return false;
      }
      if (spec.text) {
        const associatedText = readAssociatedText(el).toLowerCase();
        if (!associatedText.includes(lower(spec.text))) return false;
      }
      return true;
    };
    const collectCandidates = (spec) => {
      if (typeof spec.selector === 'string' && spec.selector.length > 0) {
        try {
          return Array.from(document.querySelectorAll(spec.selector));
        } catch (error) {
          return {
            invalidSelector: 'invalid selector: ' + ((error && error.message) || error),
          };
        }
      }
      const selectors = [
        'h1', 'h2', 'h3', 'p', 'span', 'div', 'li', 'a[href]', 'button', 'input',
        'textarea', 'select', 'option', 'label', '[role]', '[aria-label]', '[data-testid]',
      ];
      const candidates = [];
      const seen = new Set();
      for (const selector of selectors) {
        for (const element of document.querySelectorAll(selector)) {
          if (seen.has(element)) continue;
          seen.add(element);
          candidates.push(element);
        }
      }
      return candidates;
    };

    const extracted = {};
    const observations = {};
    const missingFields = [];

    for (const [name, spec] of Object.entries(fields)) {
      const candidates = collectCandidates(spec);
      if (candidates && !Array.isArray(candidates)) {
        return { ok: false, reason: 'field "' + name + '" ' + candidates.invalidSelector };
      }
      const matched = candidates.filter((candidate) => matches(candidate, spec));
      const multiple = spec.multiple === true;
      const required = spec.required !== false;
      observations[name] = {
        matchCount: matched.length,
        required,
        multiple,
        kind:
          typeof spec.attribute === 'string' && spec.attribute.length > 0
            ? 'attribute'
            : (typeof spec.kind === 'string' ? spec.kind : 'text'),
      };

      if (matched.length === 0) {
        extracted[name] = multiple ? [] : null;
        if (required) missingFields.push(name);
        continue;
      }

      if (multiple) {
        extracted[name] = matched.map((candidate) => readValue(candidate, spec));
        continue;
      }

      const value = readValue(matched[0], spec);
      extracted[name] = value;
      if (required && value === null) {
        missingFields.push(name);
      }
    }

    return { ok: true, extracted, observations, missingFields };
  })()`;
}

export function validateAgainstSchema(
  schema: unknown,
  data: Record<string, unknown>,
): SchemaValidationResult {
  if (!isRecord(schema)) {
    throw new Error("extract `arguments.schema` must be an object");
  }
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  let validate;
  try {
    validate = ajv.compile(schema);
  } catch (error) {
    throw new Error(
      `extract schema compile failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const ok = Boolean(validate(data));
  const errors =
    validate.errors?.map((error) => {
      const path = error.instancePath || "/";
      return `${path} ${error.message ?? "schema validation error"}`;
    }) ?? [];
  return { ok, errors };
}

function summarizeFailure(missingFields: string[], schemaErrors: string[]): string {
  const parts: string[] = [];
  if (missingFields.length > 0) {
    parts.push(`missing required fields: ${missingFields.join(", ")}`);
  }
  if (schemaErrors.length > 0) {
    parts.push(`schema validation failed: ${schemaErrors.join("; ")}`);
  }
  return `extract failed: ${parts.join(" | ")}`;
}

export function defaultSuggestedNextActions(): string[] {
  return [
    "frontier adapter invoke browser current-tab --mode read --json",
    "frontier adapter invoke browser inspect-dom --mode read --json",
  ];
}

export function summarizeOutputUrl(url: string): string {
  if (!url.startsWith("data:")) return url;
  const comma = url.indexOf(",");
  if (comma <= 0) return "data:";
  return `${url.slice(0, comma)},…`;
}

export function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
