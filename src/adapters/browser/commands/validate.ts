import { attach, evaluate, type CdpAttachOptions } from "../cdp.ts";
import { buildResult } from "../../../result.ts";
import type { AdapterInvocation, AdapterResult } from "../../../schemas.ts";

import {
  assertExtractInputs,
  buildExtractScript,
  defaultSuggestedNextActions,
  isRecord,
  summarizeOutputUrl,
  validateAgainstSchema,
  type ExtractEvalResult,
  type ExtractFieldSpec,
  type SchemaValidationResult,
} from "./extract.ts";

const EXPECTATION_OPERATOR_KEYS = new Set([
  "coerce",
  "approx",
  "approxField",
  "within",
  "withinPercent",
  "equals",
  "equalsField",
  "notEquals",
  "notEqualsField",
  "includes",
  "notIncludes",
  "matches",
  "startsWith",
  "endsWith",
  "oneOf",
  "exists",
  "gt",
  "gte",
  "lt",
  "lte",
  "gtField",
  "gteField",
  "ltField",
  "lteField",
  "countEquals",
  "countGt",
  "countGte",
  "countLt",
  "countLte",
  "sumEquals",
  "sumGt",
  "sumGte",
  "sumLt",
  "sumLte",
  "avgEquals",
  "avgGt",
  "avgGte",
  "avgLt",
  "avgLte",
  "minEquals",
  "minGt",
  "minGte",
  "minLt",
  "minLte",
  "maxEquals",
  "maxGt",
  "maxGte",
  "maxLt",
  "maxLte",
  "medianEquals",
  "medianGt",
  "medianGte",
  "medianLt",
  "medianLte",
  "p90Equals",
  "p90Gt",
  "p90Gte",
  "p90Lt",
  "p90Lte",
  "p95Equals",
  "p95Gt",
  "p95Gte",
  "p95Lt",
  "p95Lte",
  "anyElement",
  "allElements",
  "firstElement",
  "lastElement",
  "elementAt",
  "firstIndexOf",
  "lastIndexOf",
  "beforeValue",
  "afterValue",
  "betweenValues",
  "adjacentToValue",
  "gapToValue",
  "surroundedByValues",
  "valueAtOffset",
  "valuesAtOffsets",
  "windowMatches",
  "windowIncludesAll",
  "windowIncludesAny",
  "includesAll",
  "includesAny",
  "setEquals",
  "bagEquals",
  "distinct",
  "occurs",
  "uniqueCount",
  "startsWithSequence",
  "endsWithSequence",
  "containsSequence",
  "containsOrderedSubsequence",
  "ordered",
  "minLength",
  "maxLength",
]);
const GROUP_OPERATOR_KEYS = new Set(["expected", "allOf", "anyOf", "not"]);

type ValueCoercion = "number" | "date" | "string";
type OrderedOperator = "gt" | "gte" | "lt" | "lte";
type ExpectedMap = Record<string, unknown | ExpectedMatcher>;
type PredicateNode = ExpectedMap | PredicateTree;

interface OccurrenceExpectation {
  value: unknown;
  equals?: number;
  gt?: number;
  gte?: number;
  lt?: number;
  lte?: number;
}

interface CardinalityExpectation {
  equals?: number;
  gt?: number;
  gte?: number;
  lt?: number;
  lte?: number;
}

interface OrderExpectation {
  direction: "asc" | "desc";
  strict?: boolean;
}

interface IndexedElementExpectation {
  index: number;
  value: unknown;
}

interface IndexedValueExpectation {
  value: unknown;
  equals?: number;
  gt?: number;
  gte?: number;
  lt?: number;
  lte?: number;
}

interface RelativePositionExpectation {
  value: unknown;
  other: unknown;
}

interface BetweenValuesExpectation {
  value: unknown;
  after: unknown;
  before: unknown;
}

interface AdjacentValueExpectation {
  value: unknown;
  other: unknown;
  direction?: "either" | "before" | "after";
}

interface GapToValueExpectation {
  value: unknown;
  other: unknown;
  direction?: "either" | "before" | "after";
  equals?: number;
  gt?: number;
  gte?: number;
  lt?: number;
  lte?: number;
}

interface SurroundedByValuesExpectation {
  value: unknown;
  left: unknown;
  right: unknown;
}

interface OffsetValueExpectation {
  value: unknown;
  offset: number;
  target: unknown;
}

interface OffsetValuesExpectation {
  value: unknown;
  targets: Record<string, unknown>;
}

interface WindowMatchExpectation {
  value: unknown;
  startOffset: number;
  values: unknown[];
}

interface WindowContainsExpectation {
  value: unknown;
  startOffset: number;
  endOffset: number;
  targets: unknown[];
}

interface ExpectedMatcher {
  coerce?: ValueCoercion;
  approx?: unknown;
  approxField?: string;
  within?: number;
  withinPercent?: number;
  equals?: unknown;
  equalsField?: string;
  notEquals?: unknown;
  notEqualsField?: string;
  includes?: unknown;
  notIncludes?: unknown;
  matches?: string;
  startsWith?: string;
  endsWith?: string;
  oneOf?: unknown[];
  exists?: boolean;
  gt?: unknown;
  gte?: unknown;
  lt?: unknown;
  lte?: unknown;
  gtField?: string;
  gteField?: string;
  ltField?: string;
  lteField?: string;
  countEquals?: number;
  countGt?: number;
  countGte?: number;
  countLt?: number;
  countLte?: number;
  sumEquals?: number;
  sumGt?: number;
  sumGte?: number;
  sumLt?: number;
  sumLte?: number;
  avgEquals?: number;
  avgGt?: number;
  avgGte?: number;
  avgLt?: number;
  avgLte?: number;
  minEquals?: number;
  minGt?: number;
  minGte?: number;
  minLt?: number;
  minLte?: number;
  maxEquals?: number;
  maxGt?: number;
  maxGte?: number;
  maxLt?: number;
  maxLte?: number;
  medianEquals?: number;
  medianGt?: number;
  medianGte?: number;
  medianLt?: number;
  medianLte?: number;
  p90Equals?: number;
  p90Gt?: number;
  p90Gte?: number;
  p90Lt?: number;
  p90Lte?: number;
  p95Equals?: number;
  p95Gt?: number;
  p95Gte?: number;
  p95Lt?: number;
  p95Lte?: number;
  anyElement?: unknown | ExpectedMatcher;
  allElements?: unknown | ExpectedMatcher;
  firstElement?: unknown | ExpectedMatcher;
  lastElement?: unknown | ExpectedMatcher;
  elementAt?: IndexedElementExpectation;
  firstIndexOf?: IndexedValueExpectation;
  lastIndexOf?: IndexedValueExpectation;
  beforeValue?: RelativePositionExpectation;
  afterValue?: RelativePositionExpectation;
  betweenValues?: BetweenValuesExpectation;
  adjacentToValue?: AdjacentValueExpectation;
  gapToValue?: GapToValueExpectation;
  surroundedByValues?: SurroundedByValuesExpectation;
  valueAtOffset?: OffsetValueExpectation;
  valuesAtOffsets?: OffsetValuesExpectation;
  windowMatches?: WindowMatchExpectation;
  windowIncludesAll?: WindowContainsExpectation;
  windowIncludesAny?: WindowContainsExpectation;
  includesAll?: unknown[];
  includesAny?: unknown[];
  setEquals?: unknown[];
  bagEquals?: unknown[];
  startsWithSequence?: unknown[];
  endsWithSequence?: unknown[];
  containsSequence?: unknown[];
  containsOrderedSubsequence?: unknown[];
  distinct?: boolean;
  occurs?: OccurrenceExpectation;
  uniqueCount?: CardinalityExpectation;
  ordered?: OrderExpectation;
  minLength?: number;
  maxLength?: number;
}

interface PredicateTree {
  expected?: ExpectedMap;
  allOf?: PredicateNode[];
  anyOf?: PredicateNode[];
  not?: PredicateNode[];
}

interface ValidateArgs extends CdpAttachOptions {
  fields: Record<string, ExtractFieldSpec>;
  expected?: ExpectedMap;
  allOf?: PredicateNode[];
  anyOf?: PredicateNode[];
  not?: PredicateNode[];
  schema?: unknown;
  withHelper?: boolean;
}

interface ExpectedFailure {
  field: string;
  operator: string;
  expected: unknown;
  actual: unknown;
  reason: string;
}

export async function validateCommand(
  invocation: AdapterInvocation,
): Promise<AdapterResult> {
  const args = (invocation.arguments ?? {}) as unknown as ValidateArgs;
  assertValidateInputs(args);

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

    const missingRequired = evaluated.missingFields;
    const expectedFailures = comparePredicateGroups(args, evaluated.extracted);
    let schemaValidation: SchemaValidationResult | null = null;
    if (args.schema !== undefined) {
      schemaValidation = validateAgainstSchema(args.schema, evaluated.extracted);
    }

    const schemaErrors = schemaValidation?.errors ?? [];
    const ok =
      missingRequired.length === 0 &&
      expectedFailures.length === 0 &&
      schemaErrors.length === 0;

    return buildResult({
      invocation,
      status: ok ? "success" : "failed",
      summary: ok
        ? `validated ${Object.keys(evaluated.extracted).length} field(s) on ${summarizeOutputUrl(session.target.url)}`
        : summarizeValidationFailure(missingRequired, expectedFailures, schemaErrors),
      observedState: {
        targetId: session.target.id,
        url: summarizeOutputUrl(session.target.url),
        title: session.target.title,
        helperInstalled: session.helperInstalled,
        requested: {
          fieldNames: Object.keys(args.fields),
          expectedKeys: isRecord(args.expected) ? Object.keys(args.expected) : [],
          predicateGroups: {
            allOf: Array.isArray(args.allOf) ? args.allOf.length : 0,
            anyOf: Array.isArray(args.anyOf) ? args.anyOf.length : 0,
            not: Array.isArray(args.not) ? args.not.length : 0,
          },
          schemaProvided: args.schema !== undefined,
        },
        extracted: evaluated.extracted,
        observations: evaluated.observations,
        missingFields: missingRequired,
        expectedFailures,
        schema: schemaValidation
          ? {
              valid: schemaValidation.ok,
              errors: schemaValidation.errors,
            }
          : null,
      },
      verification: {
        status: ok ? "passed" : "failed",
        checks: [
          "trace_grade",
          ...(hasExpectedAssertions(args) ? ["expected"] : []),
          ...(args.schema !== undefined ? ["schema"] : []),
        ],
      },
      suggestedNextActions: ok ? [] : defaultSuggestedNextActions(),
    });
  } finally {
    await session.close();
  }
}

function assertValidateInputs(args: ValidateArgs): void {
  assertExtractInputs(args);
  if (!hasExpectedAssertions(args) && args.schema === undefined) {
    throw new Error(
      "validate requires `arguments.expected`, `arguments.allOf`, `arguments.anyOf`, `arguments.not`, or `arguments.schema`",
    );
  }
  if (args.expected !== undefined) assertExpectedMap("expected", args.expected);
  if (args.allOf !== undefined) assertExpectedGroup("allOf", args.allOf);
  if (args.anyOf !== undefined) assertExpectedGroup("anyOf", args.anyOf);
  if (args.not !== undefined) assertExpectedGroup("not", args.not);
}

function hasExpectedAssertions(args: ValidateArgs): boolean {
  return hasPredicateAssertions(args);
}

function hasPredicateAssertions(tree: PredicateTree): boolean {
  return (
    isExpectedMap(tree.expected) ||
    (Array.isArray(tree.allOf) && tree.allOf.length > 0) ||
    (Array.isArray(tree.anyOf) && tree.anyOf.length > 0) ||
    (Array.isArray(tree.not) && tree.not.length > 0)
  );
}

function assertExpectedMap(label: string, value: unknown): asserts value is ExpectedMap {
  if (!isRecord(value)) {
    throw new Error(`validate \`arguments.${label}\` must be an object`);
  }
  if (Object.keys(value).length === 0) {
    throw new Error(`validate \`arguments.${label}\` must be a non-empty object`);
  }
  for (const [field, expectation] of Object.entries(value)) {
    assertExpectedMatcher(`${label}.${field}`, expectation);
  }
}

function assertExpectedGroup(
  label: string,
  value: unknown,
): asserts value is PredicateNode[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`validate \`arguments.${label}\` must be a non-empty array`);
  }
  for (const [index, entry] of value.entries()) {
    assertPredicateNode(`${label}[${index}]`, entry);
  }
}

function compareExpectedMap(
  expected: ExpectedMap | undefined,
  extracted: Record<string, unknown>,
  context?: string,
): ExpectedFailure[] {
  if (!expected) return [];
  const failures: ExpectedFailure[] = [];
  for (const [field, expectedValue] of Object.entries(expected)) {
    const actualValue = extracted[field];
    const displayField = context ? `${context}.${field}` : field;
    if (isExpectedMatcher(expectedValue)) {
      failures.push(
        ...evaluateMatcher(displayField, expectedValue, actualValue, extracted),
      );
      continue;
    }
    if (!deepEqual(actualValue, expectedValue)) {
      failures.push(
        expectedFailure(
          displayField,
          "equals",
          expectedValue,
          actualValue,
          `expected ${JSON.stringify(expectedValue)} got ${JSON.stringify(actualValue)}`,
        ),
      );
    }
  }
  return failures;
}

function comparePredicateGroups(
  args: ValidateArgs,
  extracted: Record<string, unknown>,
): ExpectedFailure[] {
  return comparePredicateTree(args, extracted);
}

function assertPredicateNode(
  label: string,
  value: unknown,
): asserts value is PredicateNode {
  if (isPredicateTreeNode(value)) {
    assertPredicateTree(label, value);
    return;
  }
  assertExpectedMap(label, value);
}

function assertPredicateTree(
  label: string,
  value: unknown,
): asserts value is PredicateTree {
  if (!isRecord(value)) {
    throw new Error(`validate \`arguments.${label}\` must be an object`);
  }
  const unsupported = Object.keys(value).filter((key) => !GROUP_OPERATOR_KEYS.has(key));
  if (unsupported.length > 0) {
    throw new Error(
      `validate \`arguments.${label}\` nested group has unsupported key(s): ${unsupported.join(", ")}`,
    );
  }
  if (!hasPredicateAssertions(value)) {
    throw new Error(
      `validate \`arguments.${label}\` nested group must contain non-empty expected, allOf, anyOf, or not`,
    );
  }
  if (value.expected !== undefined) {
    assertExpectedMap(`${label}.expected`, value.expected);
  }
  if (value.allOf !== undefined) {
    assertExpectedGroup(`${label}.allOf`, value.allOf);
  }
  if (value.anyOf !== undefined) {
    assertExpectedGroup(`${label}.anyOf`, value.anyOf);
  }
  if (value.not !== undefined) {
    assertExpectedGroup(`${label}.not`, value.not);
  }
}

function comparePredicateTree(
  tree: PredicateTree,
  extracted: Record<string, unknown>,
  context?: string,
): ExpectedFailure[] {
  const failures: ExpectedFailure[] = [];
  failures.push(...compareExpectedMap(tree.expected, extracted, context));
  for (const [index, node] of (tree.allOf ?? []).entries()) {
    failures.push(
      ...comparePredicateNode(node, extracted, childPredicateContext(context, "allOf", index)),
    );
  }
  if (Array.isArray(tree.anyOf) && tree.anyOf.length > 0) {
    const branchFailures = tree.anyOf.map((node, index) =>
      comparePredicateNode(
        node,
        extracted,
        childPredicateContext(context, "anyOf", index),
      ),
    );
    if (!branchFailures.some((branch) => branch.length === 0)) {
      failures.push(
        expectedFailure(
          context ? `${context}.anyOf` : "anyOf",
          "group",
          tree.anyOf.length,
          null,
          `no branch matched: ${branchFailures
            .map(
              (branch, index) =>
                `[${index}] ${branch.map(formatExpectedFailure).join(", ")}`,
            )
            .join(" | ")}`,
        ),
      );
    }
  }
  for (const [index, node] of (tree.not ?? []).entries()) {
    const nodeContext = childPredicateContext(context, "not", index);
    const branchFailures = comparePredicateNode(node, extracted, nodeContext);
    if (branchFailures.length === 0) {
      failures.push(
        expectedFailure(
          nodeContext,
          "group",
          node,
          null,
          "unexpectedly matched all conditions",
        ),
      );
    }
  }
  return failures;
}

function comparePredicateNode(
  node: PredicateNode,
  extracted: Record<string, unknown>,
  context: string,
): ExpectedFailure[] {
  if (isPredicateTreeNode(node)) {
    return comparePredicateTree(node, extracted, context);
  }
  return compareExpectedMap(node, extracted, context);
}

function childPredicateContext(
  context: string | undefined,
  operator: "allOf" | "anyOf" | "not",
  index: number,
): string {
  return context ? `${context}.${operator}[${index}]` : `${operator}[${index}]`;
}

function assertExpectedMatcher(field: string, expectation: unknown): void {
  if (!isExpectedMatcher(expectation)) return;
  const unsupported = Object.keys(expectation).filter(
    (key) => !EXPECTATION_OPERATOR_KEYS.has(key),
  );
  if (unsupported.length > 0) {
    throw new Error(
      `validate expected matcher "${field}" has unsupported operator(s): ${unsupported.join(", ")}`,
    );
  }
  if (
    "coerce" in expectation &&
    expectation.coerce !== undefined &&
    !["number", "date", "string"].includes(expectation.coerce)
  ) {
    throw new Error(
      `validate expected matcher "${field}".coerce must be "number", "date", or "string"`,
    );
  }
  for (const operator of ["approxField", "equalsField", "notEqualsField", "gtField", "gteField", "ltField", "lteField"] as const) {
    const value = expectation[operator];
    if (value !== undefined && (typeof value !== "string" || value.trim().length === 0)) {
      throw new Error(`validate expected matcher "${field}".${operator} must be a non-empty string`);
    }
  }
  if ("within" in expectation) {
    assertNonNegativeNumber(field, "within", expectation.within);
  }
  if ("withinPercent" in expectation) {
    assertNonNegativeNumber(field, "withinPercent", expectation.withinPercent);
  }
  if (
    (expectation.approx !== undefined || expectation.approxField !== undefined) &&
    expectation.coerce !== "number"
  ) {
    throw new Error(
      `validate expected matcher "${field}" approximate comparisons require coerce "number"`,
    );
  }
  if (
    (expectation.approx !== undefined || expectation.approxField !== undefined) &&
    expectation.within === undefined &&
    expectation.withinPercent === undefined
  ) {
    throw new Error(
      `validate expected matcher "${field}" approximate comparisons require within or withinPercent`,
    );
  }
  if (
    "matches" in expectation &&
    expectation.matches !== undefined &&
    typeof expectation.matches !== "string"
  ) {
    throw new Error(`validate expected matcher "${field}".matches must be a string`);
  }
  if (
    "startsWith" in expectation &&
    expectation.startsWith !== undefined &&
    typeof expectation.startsWith !== "string"
  ) {
    throw new Error(
      `validate expected matcher "${field}".startsWith must be a string`,
    );
  }
  if (
    "endsWith" in expectation &&
    expectation.endsWith !== undefined &&
    typeof expectation.endsWith !== "string"
  ) {
    throw new Error(`validate expected matcher "${field}".endsWith must be a string`);
  }
  if (
    "oneOf" in expectation &&
    expectation.oneOf !== undefined &&
    !Array.isArray(expectation.oneOf)
  ) {
    throw new Error(`validate expected matcher "${field}".oneOf must be an array`);
  }
  if (
    "exists" in expectation &&
    expectation.exists !== undefined &&
    typeof expectation.exists !== "boolean"
  ) {
    throw new Error(`validate expected matcher "${field}".exists must be boolean`);
  }
  if ("minLength" in expectation) {
    assertLengthOperator(field, "minLength", expectation.minLength);
  }
  if ("maxLength" in expectation) {
    assertLengthOperator(field, "maxLength", expectation.maxLength);
  }
  for (const operator of [
    "countEquals",
    "countGt",
    "countGte",
    "countLt",
    "countLte",
  ] as const) {
    assertCountOperator(field, operator, expectation[operator]);
  }
  for (const operator of [
    "sumEquals",
    "sumGt",
    "sumGte",
    "sumLt",
    "sumLte",
    "avgEquals",
    "avgGt",
    "avgGte",
    "avgLt",
    "avgLte",
    "minEquals",
    "minGt",
    "minGte",
    "minLt",
    "minLte",
    "maxEquals",
    "maxGt",
    "maxGte",
    "maxLt",
    "maxLte",
    "medianEquals",
    "medianGt",
    "medianGte",
    "medianLt",
    "medianLte",
    "p90Equals",
    "p90Gt",
    "p90Gte",
    "p90Lt",
    "p90Lte",
    "p95Equals",
    "p95Gt",
    "p95Gte",
    "p95Lt",
    "p95Lte",
  ] as const) {
    assertAggregateNumberOperator(field, operator, expectation[operator]);
  }
  if (
    typeof expectation.minLength === "number" &&
    typeof expectation.maxLength === "number" &&
    expectation.minLength > expectation.maxLength
  ) {
    throw new Error(
      `validate expected matcher "${field}" has minLength greater than maxLength`,
    );
  }
  if (typeof expectation.matches === "string") {
    try {
      new RegExp(expectation.matches);
    } catch (error) {
      throw new Error(
        `validate expected matcher "${field}".matches is invalid: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  for (const [operator, elementExpectation] of [
    ["anyElement", expectation.anyElement],
    ["allElements", expectation.allElements],
    ["firstElement", expectation.firstElement],
    ["lastElement", expectation.lastElement],
  ] as const) {
    if (isExpectedMatcher(elementExpectation)) {
      assertExpectedMatcher(`${field}.${operator}`, elementExpectation);
    }
  }
  if ("elementAt" in expectation && expectation.elementAt !== undefined) {
    assertIndexedElementExpectation(field, expectation.elementAt);
  }
  for (const [operator, value] of [
    ["firstIndexOf", expectation.firstIndexOf],
    ["lastIndexOf", expectation.lastIndexOf],
  ] as const) {
    if (value !== undefined) {
      assertIndexedValueExpectation(field, operator, value);
    }
  }
  for (const [operator, value] of [
    ["beforeValue", expectation.beforeValue],
    ["afterValue", expectation.afterValue],
  ] as const) {
    if (value !== undefined) {
      assertRelativePositionExpectation(field, operator, value);
    }
  }
  if ("betweenValues" in expectation && expectation.betweenValues !== undefined) {
    assertBetweenValuesExpectation(field, expectation.betweenValues);
  }
  if (
    "adjacentToValue" in expectation &&
    expectation.adjacentToValue !== undefined
  ) {
    assertAdjacentValueExpectation(field, expectation.adjacentToValue);
  }
  if ("gapToValue" in expectation && expectation.gapToValue !== undefined) {
    assertGapToValueExpectation(field, expectation.gapToValue);
  }
  if (
    "surroundedByValues" in expectation &&
    expectation.surroundedByValues !== undefined
  ) {
    assertSurroundedByValuesExpectation(
      field,
      expectation.surroundedByValues,
    );
  }
  if ("valueAtOffset" in expectation && expectation.valueAtOffset !== undefined) {
    assertOffsetValueExpectation(field, expectation.valueAtOffset);
  }
  if (
    "valuesAtOffsets" in expectation &&
    expectation.valuesAtOffsets !== undefined
  ) {
    assertOffsetValuesExpectation(field, expectation.valuesAtOffsets);
  }
  if ("windowMatches" in expectation && expectation.windowMatches !== undefined) {
    assertWindowMatchExpectation(field, expectation.windowMatches);
  }
  if (
    "windowIncludesAll" in expectation &&
    expectation.windowIncludesAll !== undefined
  ) {
    assertWindowContainsExpectation(
      field,
      "windowIncludesAll",
      expectation.windowIncludesAll,
    );
  }
  if (
    "windowIncludesAny" in expectation &&
    expectation.windowIncludesAny !== undefined
  ) {
    assertWindowContainsExpectation(
      field,
      "windowIncludesAny",
      expectation.windowIncludesAny,
    );
  }
  for (const [operator, candidates] of [
    ["includesAll", expectation.includesAll],
    ["includesAny", expectation.includesAny],
    ["setEquals", expectation.setEquals],
    ["bagEquals", expectation.bagEquals],
    ["startsWithSequence", expectation.startsWithSequence],
    ["endsWithSequence", expectation.endsWithSequence],
    ["containsSequence", expectation.containsSequence],
    ["containsOrderedSubsequence", expectation.containsOrderedSubsequence],
  ] as const) {
    if (candidates !== undefined) {
      if (!Array.isArray(candidates)) {
        throw new Error(
          `validate expected matcher "${field}".${operator} must be an array`,
        );
      }
      if (
        operator !== "setEquals" &&
        operator !== "bagEquals" &&
        candidates.length === 0
      ) {
        throw new Error(
          `validate expected matcher "${field}".${operator} must be a non-empty array`,
        );
      }
    }
  }
  if (
    "distinct" in expectation &&
    expectation.distinct !== undefined &&
    typeof expectation.distinct !== "boolean"
  ) {
    throw new Error(`validate expected matcher "${field}".distinct must be boolean`);
  }
  if ("occurs" in expectation && expectation.occurs !== undefined) {
    assertOccurrenceExpectation(field, expectation.occurs);
  }
  if ("uniqueCount" in expectation && expectation.uniqueCount !== undefined) {
    assertCardinalityExpectation(field, "uniqueCount", expectation.uniqueCount);
  }
  if ("ordered" in expectation && expectation.ordered !== undefined) {
    assertOrderExpectation(field, expectation.ordered);
  }
}

function assertLengthOperator(
  field: string,
  operator: "minLength" | "maxLength",
  value: unknown,
): void {
  if (value === undefined) return;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    Math.floor(value) !== value
  ) {
    throw new Error(
      `validate expected matcher "${field}".${operator} must be a non-negative integer`,
    );
  }
}

function assertCountOperator(
  field: string,
  operator: "countEquals" | "countGt" | "countGte" | "countLt" | "countLte",
  value: unknown,
): void {
  if (value === undefined) return;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    Math.floor(value) !== value
  ) {
    throw new Error(
      `validate expected matcher "${field}".${operator} must be a non-negative integer`,
    );
  }
}

function assertOccurrenceExpectation(field: string, value: unknown): void {
  if (!isRecord(value)) {
    throw new Error(`validate expected matcher "${field}".occurs must be an object`);
  }
  if (!Object.prototype.hasOwnProperty.call(value, "value")) {
    throw new Error(
      `validate expected matcher "${field}".occurs requires a \`value\` field`,
    );
  }
  const comparators = [
    ["equals", value.equals],
    ["gt", value.gt],
    ["gte", value.gte],
    ["lt", value.lt],
    ["lte", value.lte],
  ] as const;
  if (comparators.every(([, operand]) => operand === undefined)) {
    throw new Error(
      `validate expected matcher "${field}".occurs requires at least one comparator: equals, gt, gte, lt, or lte`,
    );
  }
  for (const [operator, operand] of comparators) {
    if (operand === undefined) continue;
    if (
      typeof operand !== "number" ||
      !Number.isFinite(operand) ||
      operand < 0 ||
      Math.floor(operand) !== operand
    ) {
      throw new Error(
        `validate expected matcher "${field}".occurs.${operator} must be a non-negative integer`,
      );
    }
  }
}

function assertCardinalityExpectation(
  field: string,
  operator: "uniqueCount",
  value: unknown,
): void {
  if (!isRecord(value)) {
    throw new Error(
      `validate expected matcher "${field}".${operator} must be an object`,
    );
  }
  const comparators = [
    ["equals", value.equals],
    ["gt", value.gt],
    ["gte", value.gte],
    ["lt", value.lt],
    ["lte", value.lte],
  ] as const;
  if (comparators.every(([, operand]) => operand === undefined)) {
    throw new Error(
      `validate expected matcher "${field}".${operator} requires at least one comparator: equals, gt, gte, lt, or lte`,
    );
  }
  for (const [comparison, operand] of comparators) {
    if (operand === undefined) continue;
    if (
      typeof operand !== "number" ||
      !Number.isFinite(operand) ||
      operand < 0 ||
      Math.floor(operand) !== operand
    ) {
      throw new Error(
        `validate expected matcher "${field}".${operator}.${comparison} must be a non-negative integer`,
      );
    }
  }
}

function assertOrderExpectation(field: string, value: unknown): void {
  if (!isRecord(value)) {
    throw new Error(`validate expected matcher "${field}".ordered must be an object`);
  }
  if (value.direction !== "asc" && value.direction !== "desc") {
    throw new Error(
      `validate expected matcher "${field}".ordered.direction must be "asc" or "desc"`,
    );
  }
  if (
    "strict" in value &&
    value.strict !== undefined &&
    typeof value.strict !== "boolean"
  ) {
    throw new Error(
      `validate expected matcher "${field}".ordered.strict must be boolean`,
    );
  }
}

function assertIndexedElementExpectation(field: string, value: unknown): void {
  if (!isRecord(value)) {
    throw new Error(
      `validate expected matcher "${field}".elementAt must be an object`,
    );
  }
  if (!Object.prototype.hasOwnProperty.call(value, "index")) {
    throw new Error(
      `validate expected matcher "${field}".elementAt requires an \`index\` field`,
    );
  }
  if (!Object.prototype.hasOwnProperty.call(value, "value")) {
    throw new Error(
      `validate expected matcher "${field}".elementAt requires a \`value\` field`,
    );
  }
  if (
    typeof value.index !== "number" ||
    !Number.isFinite(value.index) ||
    value.index < 0 ||
    Math.floor(value.index) !== value.index
  ) {
    throw new Error(
      `validate expected matcher "${field}".elementAt.index must be a non-negative integer`,
    );
  }
  if (isExpectedMatcher(value.value)) {
    assertExpectedMatcher(`${field}.elementAt.value`, value.value);
  }
}

function assertIndexedValueExpectation(
  field: string,
  operator: "firstIndexOf" | "lastIndexOf",
  value: unknown,
): void {
  if (!isRecord(value)) {
    throw new Error(
      `validate expected matcher "${field}".${operator} must be an object`,
    );
  }
  if (!Object.prototype.hasOwnProperty.call(value, "value")) {
    throw new Error(
      `validate expected matcher "${field}".${operator} requires a \`value\` field`,
    );
  }
  const comparators = [
    ["equals", value.equals],
    ["gt", value.gt],
    ["gte", value.gte],
    ["lt", value.lt],
    ["lte", value.lte],
  ] as const;
  if (comparators.every(([, operand]) => operand === undefined)) {
    throw new Error(
      `validate expected matcher "${field}".${operator} requires at least one comparator: equals, gt, gte, lt, or lte`,
    );
  }
  for (const [comparison, operand] of comparators) {
    if (operand === undefined) continue;
    if (
      typeof operand !== "number" ||
      !Number.isFinite(operand) ||
      operand < 0 ||
      Math.floor(operand) !== operand
    ) {
      throw new Error(
        `validate expected matcher "${field}".${operator}.${comparison} must be a non-negative integer`,
      );
    }
  }
  if (isExpectedMatcher(value.value)) {
    assertExpectedMatcher(`${field}.${operator}.value`, value.value);
  }
}

function assertRelativePositionExpectation(
  field: string,
  operator: "beforeValue" | "afterValue",
  value: unknown,
): void {
  if (!isRecord(value)) {
    throw new Error(
      `validate expected matcher "${field}".${operator} must be an object`,
    );
  }
  if (!Object.prototype.hasOwnProperty.call(value, "value")) {
    throw new Error(
      `validate expected matcher "${field}".${operator} requires a \`value\` field`,
    );
  }
  if (!Object.prototype.hasOwnProperty.call(value, "other")) {
    throw new Error(
      `validate expected matcher "${field}".${operator} requires an \`other\` field`,
    );
  }
  if (isExpectedMatcher(value.value)) {
    assertExpectedMatcher(`${field}.${operator}.value`, value.value);
  }
  if (isExpectedMatcher(value.other)) {
    assertExpectedMatcher(`${field}.${operator}.other`, value.other);
  }
}

function assertBetweenValuesExpectation(field: string, value: unknown): void {
  if (!isRecord(value)) {
    throw new Error(
      `validate expected matcher "${field}".betweenValues must be an object`,
    );
  }
  if (!Object.prototype.hasOwnProperty.call(value, "value")) {
    throw new Error(
      `validate expected matcher "${field}".betweenValues requires a \`value\` field`,
    );
  }
  if (!Object.prototype.hasOwnProperty.call(value, "after")) {
    throw new Error(
      `validate expected matcher "${field}".betweenValues requires an \`after\` field`,
    );
  }
  if (!Object.prototype.hasOwnProperty.call(value, "before")) {
    throw new Error(
      `validate expected matcher "${field}".betweenValues requires a \`before\` field`,
    );
  }
  if (isExpectedMatcher(value.value)) {
    assertExpectedMatcher(`${field}.betweenValues.value`, value.value);
  }
  if (isExpectedMatcher(value.after)) {
    assertExpectedMatcher(`${field}.betweenValues.after`, value.after);
  }
  if (isExpectedMatcher(value.before)) {
    assertExpectedMatcher(`${field}.betweenValues.before`, value.before);
  }
}

function assertAdjacentValueExpectation(field: string, value: unknown): void {
  if (!isRecord(value)) {
    throw new Error(
      `validate expected matcher "${field}".adjacentToValue must be an object`,
    );
  }
  if (!Object.prototype.hasOwnProperty.call(value, "value")) {
    throw new Error(
      `validate expected matcher "${field}".adjacentToValue requires a \`value\` field`,
    );
  }
  if (!Object.prototype.hasOwnProperty.call(value, "other")) {
    throw new Error(
      `validate expected matcher "${field}".adjacentToValue requires an \`other\` field`,
    );
  }
  if (
    "direction" in value &&
    value.direction !== undefined &&
    value.direction !== "either" &&
    value.direction !== "before" &&
    value.direction !== "after"
  ) {
    throw new Error(
      `validate expected matcher "${field}".adjacentToValue.direction must be "either", "before", or "after"`,
    );
  }
  if (isExpectedMatcher(value.value)) {
    assertExpectedMatcher(`${field}.adjacentToValue.value`, value.value);
  }
  if (isExpectedMatcher(value.other)) {
    assertExpectedMatcher(`${field}.adjacentToValue.other`, value.other);
  }
}

function assertGapToValueExpectation(field: string, value: unknown): void {
  if (!isRecord(value)) {
    throw new Error(
      `validate expected matcher "${field}".gapToValue must be an object`,
    );
  }
  if (!Object.prototype.hasOwnProperty.call(value, "value")) {
    throw new Error(
      `validate expected matcher "${field}".gapToValue requires a \`value\` field`,
    );
  }
  if (!Object.prototype.hasOwnProperty.call(value, "other")) {
    throw new Error(
      `validate expected matcher "${field}".gapToValue requires an \`other\` field`,
    );
  }
  if (
    "direction" in value &&
    value.direction !== undefined &&
    value.direction !== "either" &&
    value.direction !== "before" &&
    value.direction !== "after"
  ) {
    throw new Error(
      `validate expected matcher "${field}".gapToValue.direction must be "either", "before", or "after"`,
    );
  }
  const comparators = [
    ["equals", value.equals],
    ["gt", value.gt],
    ["gte", value.gte],
    ["lt", value.lt],
    ["lte", value.lte],
  ] as const;
  if (comparators.every(([, operand]) => operand === undefined)) {
    throw new Error(
      `validate expected matcher "${field}".gapToValue requires at least one comparator: equals, gt, gte, lt, or lte`,
    );
  }
  for (const [comparison, operand] of comparators) {
    if (operand === undefined) continue;
    if (
      typeof operand !== "number" ||
      !Number.isFinite(operand) ||
      operand < 0 ||
      Math.floor(operand) !== operand
    ) {
      throw new Error(
        `validate expected matcher "${field}".gapToValue.${comparison} must be a non-negative integer`,
      );
    }
  }
  if (isExpectedMatcher(value.value)) {
    assertExpectedMatcher(`${field}.gapToValue.value`, value.value);
  }
  if (isExpectedMatcher(value.other)) {
    assertExpectedMatcher(`${field}.gapToValue.other`, value.other);
  }
}

function assertSurroundedByValuesExpectation(
  field: string,
  value: unknown,
): void {
  if (!isRecord(value)) {
    throw new Error(
      `validate expected matcher "${field}".surroundedByValues must be an object`,
    );
  }
  if (!Object.prototype.hasOwnProperty.call(value, "value")) {
    throw new Error(
      `validate expected matcher "${field}".surroundedByValues requires a \`value\` field`,
    );
  }
  if (!Object.prototype.hasOwnProperty.call(value, "left")) {
    throw new Error(
      `validate expected matcher "${field}".surroundedByValues requires a \`left\` field`,
    );
  }
  if (!Object.prototype.hasOwnProperty.call(value, "right")) {
    throw new Error(
      `validate expected matcher "${field}".surroundedByValues requires a \`right\` field`,
    );
  }
  if (isExpectedMatcher(value.value)) {
    assertExpectedMatcher(`${field}.surroundedByValues.value`, value.value);
  }
  if (isExpectedMatcher(value.left)) {
    assertExpectedMatcher(`${field}.surroundedByValues.left`, value.left);
  }
  if (isExpectedMatcher(value.right)) {
    assertExpectedMatcher(`${field}.surroundedByValues.right`, value.right);
  }
}

function assertOffsetValueExpectation(field: string, value: unknown): void {
  if (!isRecord(value)) {
    throw new Error(
      `validate expected matcher "${field}".valueAtOffset must be an object`,
    );
  }
  if (!Object.prototype.hasOwnProperty.call(value, "value")) {
    throw new Error(
      `validate expected matcher "${field}".valueAtOffset requires a \`value\` field`,
    );
  }
  if (!Object.prototype.hasOwnProperty.call(value, "offset")) {
    throw new Error(
      `validate expected matcher "${field}".valueAtOffset requires an \`offset\` field`,
    );
  }
  if (!Object.prototype.hasOwnProperty.call(value, "target")) {
    throw new Error(
      `validate expected matcher "${field}".valueAtOffset requires a \`target\` field`,
    );
  }
  if (
    typeof value.offset !== "number" ||
    !Number.isFinite(value.offset) ||
    Math.floor(value.offset) !== value.offset
  ) {
    throw new Error(
      `validate expected matcher "${field}".valueAtOffset.offset must be an integer`,
    );
  }
  if (isExpectedMatcher(value.value)) {
    assertExpectedMatcher(`${field}.valueAtOffset.value`, value.value);
  }
  if (isExpectedMatcher(value.target)) {
    assertExpectedMatcher(`${field}.valueAtOffset.target`, value.target);
  }
}

function assertOffsetValuesExpectation(field: string, value: unknown): void {
  if (!isRecord(value)) {
    throw new Error(
      `validate expected matcher "${field}".valuesAtOffsets must be an object`,
    );
  }
  if (!Object.prototype.hasOwnProperty.call(value, "value")) {
    throw new Error(
      `validate expected matcher "${field}".valuesAtOffsets requires a \`value\` field`,
    );
  }
  if (!isRecord(value.targets) || Object.keys(value.targets).length === 0) {
    throw new Error(
      `validate expected matcher "${field}".valuesAtOffsets requires a non-empty \`targets\` object`,
    );
  }
  for (const [offsetKey, target] of Object.entries(value.targets)) {
    if (!/^[-]?\d+$/.test(offsetKey)) {
      throw new Error(
        `validate expected matcher "${field}".valuesAtOffsets target key "${offsetKey}" must be an integer string`,
      );
    }
    if (isExpectedMatcher(target)) {
      assertExpectedMatcher(
        `${field}.valuesAtOffsets.targets.${offsetKey}`,
        target,
      );
    }
  }
  if (isExpectedMatcher(value.value)) {
    assertExpectedMatcher(`${field}.valuesAtOffsets.value`, value.value);
  }
}

function assertWindowMatchExpectation(field: string, value: unknown): void {
  if (!isRecord(value)) {
    throw new Error(
      `validate expected matcher "${field}".windowMatches must be an object`,
    );
  }
  if (!Object.prototype.hasOwnProperty.call(value, "value")) {
    throw new Error(
      `validate expected matcher "${field}".windowMatches requires a \`value\` field`,
    );
  }
  if (!Object.prototype.hasOwnProperty.call(value, "startOffset")) {
    throw new Error(
      `validate expected matcher "${field}".windowMatches requires a \`startOffset\` field`,
    );
  }
  if (!Array.isArray(value.values) || value.values.length === 0) {
    throw new Error(
      `validate expected matcher "${field}".windowMatches requires a non-empty \`values\` array`,
    );
  }
  if (
    typeof value.startOffset !== "number" ||
    !Number.isFinite(value.startOffset) ||
    Math.floor(value.startOffset) !== value.startOffset
  ) {
    throw new Error(
      `validate expected matcher "${field}".windowMatches.startOffset must be an integer`,
    );
  }
  if (isExpectedMatcher(value.value)) {
    assertExpectedMatcher(`${field}.windowMatches.value`, value.value);
  }
  value.values.forEach((entry, index) => {
    if (isExpectedMatcher(entry)) {
      assertExpectedMatcher(`${field}.windowMatches.values[${index}]`, entry);
    }
  });
}

function assertWindowContainsExpectation(
  field: string,
  operator: "windowIncludesAll" | "windowIncludesAny",
  value: unknown,
): void {
  if (!isRecord(value)) {
    throw new Error(
      `validate expected matcher "${field}".${operator} must be an object`,
    );
  }
  if (!Object.prototype.hasOwnProperty.call(value, "value")) {
    throw new Error(
      `validate expected matcher "${field}".${operator} requires a \`value\` field`,
    );
  }
  if (!Object.prototype.hasOwnProperty.call(value, "startOffset")) {
    throw new Error(
      `validate expected matcher "${field}".${operator} requires a \`startOffset\` field`,
    );
  }
  if (!Object.prototype.hasOwnProperty.call(value, "endOffset")) {
    throw new Error(
      `validate expected matcher "${field}".${operator} requires an \`endOffset\` field`,
    );
  }
  if (!Array.isArray(value.targets) || value.targets.length === 0) {
    throw new Error(
      `validate expected matcher "${field}".${operator} requires a non-empty \`targets\` array`,
    );
  }
  if (
    typeof value.startOffset !== "number" ||
    !Number.isFinite(value.startOffset) ||
    Math.floor(value.startOffset) !== value.startOffset
  ) {
    throw new Error(
      `validate expected matcher "${field}".${operator}.startOffset must be an integer`,
    );
  }
  if (
    typeof value.endOffset !== "number" ||
    !Number.isFinite(value.endOffset) ||
    Math.floor(value.endOffset) !== value.endOffset
  ) {
    throw new Error(
      `validate expected matcher "${field}".${operator}.endOffset must be an integer`,
    );
  }
  if (value.startOffset > value.endOffset) {
    throw new Error(
      `validate expected matcher "${field}".${operator} startOffset must be <= endOffset`,
    );
  }
  if (isExpectedMatcher(value.value)) {
    assertExpectedMatcher(`${field}.${operator}.value`, value.value);
  }
  value.targets.forEach((entry, index) => {
    if (isExpectedMatcher(entry)) {
      assertExpectedMatcher(`${field}.${operator}.targets[${index}]`, entry);
    }
  });
}

function assertAggregateNumberOperator(
  field: string,
  operator:
    | "sumEquals"
    | "sumGt"
    | "sumGte"
    | "sumLt"
    | "sumLte"
    | "avgEquals"
    | "avgGt"
    | "avgGte"
    | "avgLt"
    | "avgLte"
    | "minEquals"
    | "minGt"
    | "minGte"
    | "minLt"
    | "minLte"
    | "maxEquals"
    | "maxGt"
    | "maxGte"
    | "maxLt"
    | "maxLte"
    | "medianEquals"
    | "medianGt"
    | "medianGte"
    | "medianLt"
    | "medianLte"
    | "p90Equals"
    | "p90Gt"
    | "p90Gte"
    | "p90Lt"
    | "p90Lte"
    | "p95Equals"
    | "p95Gt"
    | "p95Gte"
    | "p95Lt"
    | "p95Lte",
  value: unknown,
): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(
      `validate expected matcher "${field}".${operator} must be a finite number`,
    );
  }
}

function assertNonNegativeNumber(
  field: string,
  operator: "within" | "withinPercent",
  value: unknown,
): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(
      `validate expected matcher "${field}".${operator} must be a non-negative number`,
    );
  }
}

function formatNumericDiagnostic(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const rounded = Number(value.toFixed(6));
  if (Object.is(rounded, -0)) return "0";
  return String(rounded);
}

function isExpectedMatcher(value: unknown): value is ExpectedMatcher {
  return (
    isRecord(value) &&
    Object.keys(value).some((key) => EXPECTATION_OPERATOR_KEYS.has(key))
  );
}

function isExpectedMap(value: unknown): value is ExpectedMap {
  return isRecord(value) && Object.keys(value).length > 0;
}

function isPredicateTreeNode(value: unknown): value is PredicateTree {
  return (
    isRecord(value) &&
    Object.keys(value).some((key) => GROUP_OPERATOR_KEYS.has(key))
  );
}

function evaluateMatcher(
  field: string,
  expectation: ExpectedMatcher,
  actualValue: unknown,
  extracted: Record<string, unknown>,
): ExpectedFailure[] {
  const failures: ExpectedFailure[] = [];
  const coercion = expectation.coerce;

  if ("approx" in expectation || "approxField" in expectation) {
    const approxFailures = evaluateApproximateMatcher(
      field,
      expectation,
      actualValue,
      extracted,
    );
    failures.push(...approxFailures);
  }
  if (
    "exists" in expectation &&
    typeof expectation.exists === "boolean" &&
    hasObservableValue(actualValue) !== expectation.exists
  ) {
    failures.push(
      expectedFailure(
        field,
        "exists",
        expectation.exists,
        actualValue,
        expectation.exists
          ? "expected a present non-empty value"
          : "expected the field to be absent or empty",
      ),
    );
  }
  if (
    "equals" in expectation &&
    !valuesEqual(actualValue, expectation.equals, coercion)
  ) {
    failures.push(
      expectedFailure(
        field,
        "equals",
        expectation.equals,
        actualValue,
        `expected ${JSON.stringify(expectation.equals)} got ${JSON.stringify(actualValue)}`,
      ),
    );
  }
  if (
    "equalsField" in expectation &&
    typeof expectation.equalsField === "string"
  ) {
    failures.push(
      ...evaluateFieldReferenceEquality(
        field,
        "equalsField",
        actualValue,
        expectation.equalsField,
        extracted,
        coercion,
        true,
      ),
    );
  }
  if (
    "notEquals" in expectation &&
    valuesEqual(actualValue, expectation.notEquals, coercion)
  ) {
    failures.push(
      expectedFailure(
        field,
        "notEquals",
        expectation.notEquals,
        actualValue,
        `did not expect ${JSON.stringify(expectation.notEquals)}`,
      ),
    );
  }
  if (
    "notEqualsField" in expectation &&
    typeof expectation.notEqualsField === "string"
  ) {
    failures.push(
      ...evaluateFieldReferenceEquality(
        field,
        "notEqualsField",
        actualValue,
        expectation.notEqualsField,
        extracted,
        coercion,
        false,
      ),
    );
  }
  if (
    "includes" in expectation &&
    !valueIncludes(actualValue, expectation.includes)
  ) {
    failures.push(
      expectedFailure(
        field,
        "includes",
        expectation.includes,
        actualValue,
        `expected value to include ${JSON.stringify(expectation.includes)}`,
      ),
    );
  }
  if (
    "notIncludes" in expectation &&
    valueIncludes(actualValue, expectation.notIncludes)
  ) {
    failures.push(
      expectedFailure(
        field,
        "notIncludes",
        expectation.notIncludes,
        actualValue,
        `did not expect value to include ${JSON.stringify(expectation.notIncludes)}`,
      ),
    );
  }
  if ("matches" in expectation && typeof expectation.matches === "string") {
    if (typeof actualValue !== "string") {
      failures.push(
        expectedFailure(
          field,
          "matches",
          expectation.matches,
          actualValue,
          "expected a string value for regex matching",
        ),
      );
    } else if (!new RegExp(expectation.matches).test(actualValue)) {
      failures.push(
        expectedFailure(
          field,
          "matches",
          expectation.matches,
          actualValue,
          `value did not match /${expectation.matches}/`,
        ),
      );
    }
  }
  if ("startsWith" in expectation && expectation.startsWith !== undefined) {
    if (typeof actualValue !== "string") {
      failures.push(
        expectedFailure(
          field,
          "startsWith",
          expectation.startsWith,
          actualValue,
          "expected a string value for startsWith",
        ),
      );
    } else if (!actualValue.startsWith(expectation.startsWith)) {
      failures.push(
        expectedFailure(
          field,
          "startsWith",
          expectation.startsWith,
          actualValue,
          `value did not start with ${JSON.stringify(expectation.startsWith)}`,
        ),
      );
    }
  }
  if ("endsWith" in expectation && expectation.endsWith !== undefined) {
    if (typeof actualValue !== "string") {
      failures.push(
        expectedFailure(
          field,
          "endsWith",
          expectation.endsWith,
          actualValue,
          "expected a string value for endsWith",
        ),
      );
    } else if (!actualValue.endsWith(expectation.endsWith)) {
      failures.push(
        expectedFailure(
          field,
          "endsWith",
          expectation.endsWith,
          actualValue,
          `value did not end with ${JSON.stringify(expectation.endsWith)}`,
        ),
      );
    }
  }
  if ("oneOf" in expectation && Array.isArray(expectation.oneOf)) {
    if (
      !expectation.oneOf.some((candidate) =>
        valuesEqual(actualValue, candidate, coercion),
      )
    ) {
      failures.push(
        expectedFailure(
          field,
          "oneOf",
          expectation.oneOf,
          actualValue,
          `expected one of ${JSON.stringify(expectation.oneOf)}`,
        ),
      );
    }
  }
  for (const [operator, operand] of [
    ["gt", expectation.gt],
    ["gte", expectation.gte],
    ["lt", expectation.lt],
    ["lte", expectation.lte],
  ] as const) {
    if (operand !== undefined) {
      const failure = evaluateOrderedComparison(
        field,
        operator,
        actualValue,
        operand,
        coercion,
        operator,
      );
      if (failure) failures.push(failure);
    }
  }
  for (const [operator, refField] of [
    ["gtField", expectation.gtField],
    ["gteField", expectation.gteField],
    ["ltField", expectation.ltField],
    ["lteField", expectation.lteField],
  ] as const) {
    if (typeof refField === "string") {
      const referenceValue = extracted[refField];
      const failure = evaluateOrderedComparison(
        field,
        operator,
        actualValue,
        referenceValue,
        coercion,
        `${operator}=${refField}`,
        refField,
      );
      if (failure) failures.push(failure);
    }
  }

  const actualLength = measurableLength(actualValue);
  for (const [operator, expectedCount] of [
    ["countEquals", expectation.countEquals],
    ["countGt", expectation.countGt],
    ["countGte", expectation.countGte],
    ["countLt", expectation.countLt],
    ["countLte", expectation.countLte],
  ] as const) {
    if (expectedCount !== undefined) {
      const failure = evaluateCountComparison(
        field,
        operator,
        actualLength,
        expectedCount,
        actualValue,
      );
      if (failure) failures.push(failure);
    }
  }
  for (const [operator, expectedSum] of [
    ["sumEquals", expectation.sumEquals],
    ["sumGt", expectation.sumGt],
    ["sumGte", expectation.sumGte],
    ["sumLt", expectation.sumLt],
    ["sumLte", expectation.sumLte],
    ["avgEquals", expectation.avgEquals],
    ["avgGt", expectation.avgGt],
    ["avgGte", expectation.avgGte],
    ["avgLt", expectation.avgLt],
    ["avgLte", expectation.avgLte],
    ["minEquals", expectation.minEquals],
    ["minGt", expectation.minGt],
    ["minGte", expectation.minGte],
    ["minLt", expectation.minLt],
    ["minLte", expectation.minLte],
    ["maxEquals", expectation.maxEquals],
    ["maxGt", expectation.maxGt],
    ["maxGte", expectation.maxGte],
    ["maxLt", expectation.maxLt],
    ["maxLte", expectation.maxLte],
    ["medianEquals", expectation.medianEquals],
    ["medianGt", expectation.medianGt],
    ["medianGte", expectation.medianGte],
    ["medianLt", expectation.medianLt],
    ["medianLte", expectation.medianLte],
    ["p90Equals", expectation.p90Equals],
    ["p90Gt", expectation.p90Gt],
    ["p90Gte", expectation.p90Gte],
    ["p90Lt", expectation.p90Lt],
    ["p90Lte", expectation.p90Lte],
    ["p95Equals", expectation.p95Equals],
    ["p95Gt", expectation.p95Gt],
    ["p95Gte", expectation.p95Gte],
    ["p95Lt", expectation.p95Lt],
    ["p95Lte", expectation.p95Lte],
  ] as const) {
    if (expectedSum !== undefined) {
      const failure = evaluateNumericAggregateComparison(
        field,
        operator,
        actualValue,
        expectedSum,
      );
      if (failure) failures.push(failure);
    }
  }
  for (const [operator, elementExpectation] of [
    ["anyElement", expectation.anyElement],
    ["allElements", expectation.allElements],
  ] as const) {
    if (elementExpectation !== undefined) {
      failures.push(
        ...evaluateElementExpectation(
          field,
          operator,
          actualValue,
          elementExpectation,
          extracted,
        ),
      );
    }
  }
  for (const [operator, elementExpectation] of [
    ["firstElement", expectation.firstElement],
    ["lastElement", expectation.lastElement],
  ] as const) {
    if (elementExpectation !== undefined) {
      failures.push(
        ...evaluateIndexedElementExpectation(
          field,
          operator,
          actualValue,
          operator === "firstElement" ? 0 : "last",
          elementExpectation,
          extracted,
        ),
      );
    }
  }
  if ("elementAt" in expectation && expectation.elementAt !== undefined) {
    failures.push(
      ...evaluateIndexedElementExpectation(
        field,
        "elementAt",
        actualValue,
        expectation.elementAt.index,
        expectation.elementAt.value,
        extracted,
      ),
    );
  }
  for (const [operator, valueExpectation] of [
    ["firstIndexOf", expectation.firstIndexOf],
    ["lastIndexOf", expectation.lastIndexOf],
  ] as const) {
    if (valueExpectation !== undefined) {
      failures.push(
        ...evaluateIndexedValueExpectation(
          field,
          operator,
          actualValue,
          valueExpectation,
          extracted,
        ),
      );
    }
  }
  for (const [operator, valueExpectation] of [
    ["beforeValue", expectation.beforeValue],
    ["afterValue", expectation.afterValue],
  ] as const) {
    if (valueExpectation !== undefined) {
      const failure = evaluateRelativePositionExpectation(
        field,
        operator,
        actualValue,
        valueExpectation,
        extracted,
      );
      if (failure) failures.push(failure);
    }
  }
  if ("betweenValues" in expectation && expectation.betweenValues !== undefined) {
    const failure = evaluateBetweenValuesExpectation(
      field,
      actualValue,
      expectation.betweenValues,
      extracted,
    );
    if (failure) failures.push(failure);
  }
  if (
    "adjacentToValue" in expectation &&
    expectation.adjacentToValue !== undefined
  ) {
    const failure = evaluateAdjacentValueExpectation(
      field,
      actualValue,
      expectation.adjacentToValue,
      extracted,
    );
    if (failure) failures.push(failure);
  }
  if ("gapToValue" in expectation && expectation.gapToValue !== undefined) {
    const failure = evaluateGapToValueExpectation(
      field,
      actualValue,
      expectation.gapToValue,
      extracted,
    );
    if (failure) failures.push(failure);
  }
  if (
    "surroundedByValues" in expectation &&
    expectation.surroundedByValues !== undefined
  ) {
    const failure = evaluateSurroundedByValuesExpectation(
      field,
      actualValue,
      expectation.surroundedByValues,
      extracted,
    );
    if (failure) failures.push(failure);
  }
  if ("valueAtOffset" in expectation && expectation.valueAtOffset !== undefined) {
    const failure = evaluateOffsetValueExpectation(
      field,
      actualValue,
      expectation.valueAtOffset,
      extracted,
    );
    if (failure) failures.push(failure);
  }
  if (
    "valuesAtOffsets" in expectation &&
    expectation.valuesAtOffsets !== undefined
  ) {
    const failure = evaluateOffsetValuesExpectation(
      field,
      actualValue,
      expectation.valuesAtOffsets,
      extracted,
    );
    if (failure) failures.push(failure);
  }
  if ("windowMatches" in expectation && expectation.windowMatches !== undefined) {
    const failure = evaluateWindowMatchExpectation(
      field,
      actualValue,
      expectation.windowMatches,
      extracted,
    );
    if (failure) failures.push(failure);
  }
  if (
    "windowIncludesAll" in expectation &&
    expectation.windowIncludesAll !== undefined
  ) {
    const failure = evaluateWindowContainsExpectation(
      field,
      "windowIncludesAll",
      actualValue,
      expectation.windowIncludesAll,
      extracted,
    );
    if (failure) failures.push(failure);
  }
  if (
    "windowIncludesAny" in expectation &&
    expectation.windowIncludesAny !== undefined
  ) {
    const failure = evaluateWindowContainsExpectation(
      field,
      "windowIncludesAny",
      actualValue,
      expectation.windowIncludesAny,
      extracted,
    );
    if (failure) failures.push(failure);
  }
  for (const [operator, expectedValues] of [
    ["includesAll", expectation.includesAll],
    ["includesAny", expectation.includesAny],
    ["setEquals", expectation.setEquals],
    ["bagEquals", expectation.bagEquals],
    ["startsWithSequence", expectation.startsWithSequence],
    ["endsWithSequence", expectation.endsWithSequence],
    ["containsSequence", expectation.containsSequence],
    ["containsOrderedSubsequence", expectation.containsOrderedSubsequence],
  ] as const) {
    if (expectedValues !== undefined) {
      const failure =
        operator === "setEquals"
          ? evaluateSetEqualityComparison(
              field,
              actualValue,
              expectedValues,
              coercion,
            )
          : operator === "bagEquals"
            ? evaluateBagEqualityComparison(
                field,
              actualValue,
              expectedValues,
              coercion,
            )
          : operator === "startsWithSequence" ||
              operator === "endsWithSequence" ||
              operator === "containsSequence" ||
              operator === "containsOrderedSubsequence"
            ? evaluateSequenceComparison(
                field,
                operator,
                actualValue,
                expectedValues,
                coercion,
              )
          : evaluateArrayMembershipComparison(
              field,
              operator,
              actualValue,
              expectedValues,
              coercion,
            );
      if (failure) failures.push(failure);
    }
  }
  if ("distinct" in expectation && expectation.distinct !== undefined) {
    const failure = evaluateDistinctComparison(
      field,
      actualValue,
      expectation.distinct,
      coercion,
    );
    if (failure) failures.push(failure);
  }
  if ("occurs" in expectation && expectation.occurs !== undefined) {
    failures.push(
      ...evaluateOccurrenceExpectation(
        field,
        actualValue,
        expectation.occurs,
        coercion,
      ),
    );
  }
  if ("uniqueCount" in expectation && expectation.uniqueCount !== undefined) {
    failures.push(
      ...evaluateUniqueCountExpectation(
        field,
        actualValue,
        expectation.uniqueCount,
        coercion,
      ),
    );
  }
  if ("ordered" in expectation && expectation.ordered !== undefined) {
    const failure = evaluateOrderExpectation(
      field,
      actualValue,
      expectation.ordered,
      coercion,
    );
    if (failure) failures.push(failure);
  }
  if ("minLength" in expectation && expectation.minLength !== undefined) {
    if (actualLength === null || actualLength < expectation.minLength) {
      failures.push(
        expectedFailure(
          field,
          "minLength",
          expectation.minLength,
          actualValue,
          actualLength === null
            ? "value has no measurable length"
            : `length ${actualLength} was below ${expectation.minLength}`,
        ),
      );
    }
  }
  if ("maxLength" in expectation && expectation.maxLength !== undefined) {
    if (actualLength === null || actualLength > expectation.maxLength) {
      failures.push(
        expectedFailure(
          field,
          "maxLength",
          expectation.maxLength,
          actualValue,
          actualLength === null
            ? "value has no measurable length"
            : `length ${actualLength} exceeded ${expectation.maxLength}`,
        ),
      );
    }
  }

  return failures;
}

function evaluateElementExpectation(
  field: string,
  operator: "anyElement" | "allElements",
  actualValue: unknown,
  expectedElement: unknown,
  extracted: Record<string, unknown>,
): ExpectedFailure[] {
  if (!Array.isArray(actualValue)) {
    return [
      expectedFailure(
        field,
        operator,
        expectedElement,
        actualValue,
        "element predicates require an array value",
      ),
    ];
  }
  if (operator === "allElements" && actualValue.length === 0) {
    return [];
  }
  if (operator === "anyElement" && actualValue.length === 0) {
    return [
      expectedFailure(
        field,
        operator,
        expectedElement,
        actualValue,
        "anyElement requires a non-empty array",
      ),
    ];
  }

  const branchFailures = actualValue.map((entry, index) =>
    evaluateElementCandidate(
      `${field}[${index}]`,
      expectedElement,
      entry,
      extracted,
    ),
  );

  if (operator === "anyElement") {
    if (branchFailures.some((branch) => branch.length === 0)) {
      return [];
    }
    return [
      expectedFailure(
        field,
        operator,
        expectedElement,
        actualValue,
        `no array element matched: ${branchFailures
          .map(
            (branch, index) =>
              `[${index}] ${branch.map(formatExpectedFailure).join(", ")}`,
          )
          .join(" | ")}`,
      ),
    ];
  }

  return branchFailures.flat();
}

function evaluateIndexedElementExpectation(
  field: string,
  operator: "firstElement" | "lastElement" | "elementAt",
  actualValue: unknown,
  index: number | "last",
  expectedElement: unknown,
  extracted: Record<string, unknown>,
): ExpectedFailure[] {
  if (!Array.isArray(actualValue)) {
    return [
      expectedFailure(
        field,
        operator,
        expectedElement,
        actualValue,
        "element position predicates require an array value",
      ),
    ];
  }
  if (index === "last") {
    if (actualValue.length === 0) {
      return [
        expectedFailure(
          field,
          operator,
          expectedElement,
          actualValue,
          "last element was requested but array was empty",
        ),
      ];
    }
    const resolvedIndex = actualValue.length - 1;
    return evaluateElementCandidate(
      `${field}[${resolvedIndex}]`,
      expectedElement,
      actualValue[resolvedIndex],
      extracted,
    );
  }
  if (index >= actualValue.length) {
    return [
      expectedFailure(
        field,
        operator,
        expectedElement,
        actualValue,
        `index ${index} was out of bounds for length ${actualValue.length}`,
      ),
    ];
  }
  return evaluateElementCandidate(
    `${field}[${index}]`,
    expectedElement,
    actualValue[index],
    extracted,
  );
}

function evaluateIndexedValueExpectation(
  field: string,
  operator: "firstIndexOf" | "lastIndexOf",
  actualValue: unknown,
  expectation: IndexedValueExpectation,
  extracted: Record<string, unknown>,
): ExpectedFailure[] {
  if (!Array.isArray(actualValue)) {
    return [
      expectedFailure(
        field,
        operator,
        expectation,
        actualValue,
        "index lookup predicates require an array value",
      ),
    ];
  }

  const index = findMatchingElementIndex(
    actualValue,
    expectation.value,
    extracted,
    operator === "lastIndexOf",
  );
  if (index === -1) {
    return [
      expectedFailure(
        field,
        operator,
        expectation,
        actualValue,
        `value ${JSON.stringify(expectation.value)} was not found`,
      ),
    ];
  }

  const failures: ExpectedFailure[] = [];
  for (const [comparison, expectedIndex] of [
    ["equals", expectation.equals],
    ["gt", expectation.gt],
    ["gte", expectation.gte],
    ["lt", expectation.lt],
    ["lte", expectation.lte],
  ] as const) {
    if (expectedIndex === undefined) continue;
    const passed =
      comparison === "equals"
        ? index === expectedIndex
        : comparison === "gt"
          ? index > expectedIndex
          : comparison === "gte"
            ? index >= expectedIndex
            : comparison === "lt"
              ? index < expectedIndex
              : index <= expectedIndex;
    if (passed) continue;
    const comparator =
      comparison === "equals"
        ? "="
        : comparison === "gt"
          ? ">"
          : comparison === "gte"
            ? ">="
            : comparison === "lt"
              ? "<"
              : "<=";
    failures.push(
      expectedFailure(
        field,
        `${operator}.${comparison}`,
        { value: expectation.value, index: expectedIndex },
        actualValue,
        `${operator} for ${JSON.stringify(expectation.value)} ${index} ${comparator} ${expectedIndex} was not satisfied`,
      ),
    );
  }
  return failures;
}

function evaluateRelativePositionExpectation(
  field: string,
  operator: "beforeValue" | "afterValue",
  actualValue: unknown,
  expectation: RelativePositionExpectation,
  extracted: Record<string, unknown>,
): ExpectedFailure | null {
  if (!Array.isArray(actualValue)) {
    return expectedFailure(
      field,
      operator,
      expectation,
      actualValue,
      "relative position predicates require an array value",
    );
  }

  const valueIndex = findMatchingElementIndex(
    actualValue,
    expectation.value,
    extracted,
    operator === "afterValue",
  );
  if (valueIndex === -1) {
    return expectedFailure(
      field,
      operator,
      expectation,
      actualValue,
      `value ${JSON.stringify(expectation.value)} was not found`,
    );
  }

  const otherIndex = findMatchingElementIndex(
    actualValue,
    expectation.other,
    extracted,
    operator === "beforeValue",
  );
  if (otherIndex === -1) {
    return expectedFailure(
      field,
      operator,
      expectation,
      actualValue,
      `other ${JSON.stringify(expectation.other)} was not found`,
    );
  }

  const passed =
    operator === "beforeValue"
      ? valueIndex < otherIndex
      : valueIndex > otherIndex;
  if (passed) return null;

  return expectedFailure(
    field,
    operator,
    expectation,
    actualValue,
    operator === "beforeValue"
      ? `${JSON.stringify(expectation.value)} at [${valueIndex}] was not before ${JSON.stringify(expectation.other)} at [${otherIndex}]`
      : `${JSON.stringify(expectation.value)} at [${valueIndex}] was not after ${JSON.stringify(expectation.other)} at [${otherIndex}]`,
  );
}

function evaluateBetweenValuesExpectation(
  field: string,
  actualValue: unknown,
  expectation: BetweenValuesExpectation,
  extracted: Record<string, unknown>,
): ExpectedFailure | null {
  if (!Array.isArray(actualValue)) {
    return expectedFailure(
      field,
      "betweenValues",
      expectation,
      actualValue,
      "between-values predicates require an array value",
    );
  }

  const valueIndices = findMatchingElementIndices(
    actualValue,
    expectation.value,
    extracted,
  );
  if (valueIndices.length === 0) {
    return expectedFailure(
      field,
      "betweenValues",
      expectation,
      actualValue,
      `value ${JSON.stringify(expectation.value)} was not found`,
    );
  }

  const afterIndices = findMatchingElementIndices(
    actualValue,
    expectation.after,
    extracted,
  );
  if (afterIndices.length === 0) {
    return expectedFailure(
      field,
      "betweenValues",
      expectation,
      actualValue,
      `after ${JSON.stringify(expectation.after)} was not found`,
    );
  }

  const beforeIndices = findMatchingElementIndices(
    actualValue,
    expectation.before,
    extracted,
  );
  if (beforeIndices.length === 0) {
    return expectedFailure(
      field,
      "betweenValues",
      expectation,
      actualValue,
      `before ${JSON.stringify(expectation.before)} was not found`,
    );
  }

  const matchedIndex = valueIndices.find((valueIndex) =>
    afterIndices.some((afterIndex) => afterIndex < valueIndex) &&
    beforeIndices.some((beforeIndex) => beforeIndex > valueIndex),
  );
  if (matchedIndex !== undefined) return null;

  return expectedFailure(
    field,
    "betweenValues",
    expectation,
    actualValue,
    `no occurrence of ${JSON.stringify(expectation.value)} was found after ${JSON.stringify(expectation.after)} and before ${JSON.stringify(expectation.before)}; value indices ${JSON.stringify(valueIndices)}, after indices ${JSON.stringify(afterIndices)}, before indices ${JSON.stringify(beforeIndices)}`,
  );
}

function evaluateAdjacentValueExpectation(
  field: string,
  actualValue: unknown,
  expectation: AdjacentValueExpectation,
  extracted: Record<string, unknown>,
): ExpectedFailure | null {
  if (!Array.isArray(actualValue)) {
    return expectedFailure(
      field,
      "adjacentToValue",
      expectation,
      actualValue,
      "adjacency predicates require an array value",
    );
  }

  const valueIndices = findMatchingElementIndices(
    actualValue,
    expectation.value,
    extracted,
  );
  if (valueIndices.length === 0) {
    return expectedFailure(
      field,
      "adjacentToValue",
      expectation,
      actualValue,
      `value ${JSON.stringify(expectation.value)} was not found`,
    );
  }

  const otherIndices = findMatchingElementIndices(
    actualValue,
    expectation.other,
    extracted,
  );
  if (otherIndices.length === 0) {
    return expectedFailure(
      field,
      "adjacentToValue",
      expectation,
      actualValue,
      `other ${JSON.stringify(expectation.other)} was not found`,
    );
  }

  const direction = expectation.direction ?? "either";
  const matchedIndex = valueIndices.find((valueIndex) =>
    otherIndices.some((otherIndex) =>
      direction === "before"
        ? valueIndex + 1 === otherIndex
        : direction === "after"
          ? valueIndex - 1 === otherIndex
          : Math.abs(valueIndex - otherIndex) === 1,
    ),
  );
  if (matchedIndex !== undefined) return null;

  const directionLabel =
    direction === "before"
      ? "immediately before"
      : direction === "after"
        ? "immediately after"
        : "adjacent to";
  return expectedFailure(
    field,
    "adjacentToValue",
    expectation,
    actualValue,
    `no occurrence of ${JSON.stringify(expectation.value)} was ${directionLabel} ${JSON.stringify(expectation.other)}; value indices ${JSON.stringify(valueIndices)}, other indices ${JSON.stringify(otherIndices)}`,
  );
}

function evaluateGapToValueExpectation(
  field: string,
  actualValue: unknown,
  expectation: GapToValueExpectation,
  extracted: Record<string, unknown>,
): ExpectedFailure | null {
  if (!Array.isArray(actualValue)) {
    return expectedFailure(
      field,
      "gapToValue",
      expectation,
      actualValue,
      "gap predicates require an array value",
    );
  }

  const valueIndices = findMatchingElementIndices(
    actualValue,
    expectation.value,
    extracted,
  );
  if (valueIndices.length === 0) {
    return expectedFailure(
      field,
      "gapToValue",
      expectation,
      actualValue,
      `value ${JSON.stringify(expectation.value)} was not found`,
    );
  }

  const otherIndices = findMatchingElementIndices(
    actualValue,
    expectation.other,
    extracted,
  );
  if (otherIndices.length === 0) {
    return expectedFailure(
      field,
      "gapToValue",
      expectation,
      actualValue,
      `other ${JSON.stringify(expectation.other)} was not found`,
    );
  }

  const direction = expectation.direction ?? "either";
  const gaps: number[] = [];
  for (const valueIndex of valueIndices) {
    for (const otherIndex of otherIndices) {
      if (valueIndex === otherIndex) continue;
      if (direction === "before") {
        if (valueIndex < otherIndex) gaps.push(otherIndex - valueIndex - 1);
        continue;
      }
      if (direction === "after") {
        if (valueIndex > otherIndex) gaps.push(valueIndex - otherIndex - 1);
        continue;
      }
      gaps.push(Math.abs(valueIndex - otherIndex) - 1);
    }
  }

  if (gaps.length === 0) {
    return expectedFailure(
      field,
      "gapToValue",
      expectation,
      actualValue,
      `no ${direction === "either" ? "distinct" : direction} pair was found between ${JSON.stringify(expectation.value)} and ${JSON.stringify(expectation.other)}`,
    );
  }

  const comparators = [
    ["equals", expectation.equals],
    ["gt", expectation.gt],
    ["gte", expectation.gte],
    ["lt", expectation.lt],
    ["lte", expectation.lte],
  ] as const;
  const satisfyingGap = gaps.find((gap) =>
    comparators.every(([comparison, operand]) => {
      if (operand === undefined) return true;
      return comparison === "equals"
        ? gap === operand
        : comparison === "gt"
          ? gap > operand
          : comparison === "gte"
            ? gap >= operand
            : comparison === "lt"
              ? gap < operand
              : gap <= operand;
    }),
  );
  if (satisfyingGap !== undefined) return null;

  const requirements = comparators
    .filter(([, operand]) => operand !== undefined)
    .map(([comparison, operand]) =>
      comparison === "equals"
        ? `= ${operand}`
        : comparison === "gt"
          ? `> ${operand}`
          : comparison === "gte"
            ? `>= ${operand}`
            : comparison === "lt"
              ? `< ${operand}`
              : `<= ${operand}`,
    )
    .join(" and ");
  return expectedFailure(
    field,
    "gapToValue",
    expectation,
    actualValue,
    `no gap between ${JSON.stringify(expectation.value)} and ${JSON.stringify(expectation.other)} satisfied ${requirements}; observed gaps ${JSON.stringify(gaps)}`,
  );
}

function evaluateSurroundedByValuesExpectation(
  field: string,
  actualValue: unknown,
  expectation: SurroundedByValuesExpectation,
  extracted: Record<string, unknown>,
): ExpectedFailure | null {
  if (!Array.isArray(actualValue)) {
    return expectedFailure(
      field,
      "surroundedByValues",
      expectation,
      actualValue,
      "surround predicates require an array value",
    );
  }
  if (actualValue.length < 3) {
    return expectedFailure(
      field,
      "surroundedByValues",
      expectation,
      actualValue,
      "array must have at least three entries for surround predicates",
    );
  }

  const matches: number[] = [];
  const leftMismatches: number[] = [];
  const rightMismatches: number[] = [];
  for (let index = 1; index < actualValue.length - 1; index += 1) {
    if (
      evaluateElementCandidate(
        `${field}[${index}]`,
        expectation.value,
        actualValue[index],
        extracted,
      ).length !== 0
    ) {
      continue;
    }
    matches.push(index);
    if (
      evaluateElementCandidate(
        `${field}[${index - 1}]`,
        expectation.left,
        actualValue[index - 1],
        extracted,
      ).length !== 0
    ) {
      leftMismatches.push(index);
    }
    if (
      evaluateElementCandidate(
        `${field}[${index + 1}]`,
        expectation.right,
        actualValue[index + 1],
        extracted,
      ).length !== 0
    ) {
      rightMismatches.push(index);
    }
    if (
      leftMismatches[leftMismatches.length - 1] !== index &&
      rightMismatches[rightMismatches.length - 1] !== index
    ) {
      return null;
    }
  }

  if (matches.length === 0) {
    return expectedFailure(
      field,
      "surroundedByValues",
      expectation,
      actualValue,
      `value ${JSON.stringify(expectation.value)} was not found in an interior array position`,
    );
  }

  const reasons: string[] = [];
  if (leftMismatches.length === matches.length) {
    reasons.push(
      `left neighbor ${JSON.stringify(expectation.left)} did not match for value indices ${JSON.stringify(matches)}`,
    );
  }
  if (rightMismatches.length === matches.length) {
    reasons.push(
      `right neighbor ${JSON.stringify(expectation.right)} did not match for value indices ${JSON.stringify(matches)}`,
    );
  }
  if (reasons.length === 0) {
    reasons.push(
      `no occurrence of ${JSON.stringify(expectation.value)} had left ${JSON.stringify(expectation.left)} and right ${JSON.stringify(expectation.right)} simultaneously`,
    );
  }
  return expectedFailure(
    field,
    "surroundedByValues",
    expectation,
    actualValue,
    reasons.join("; "),
  );
}

function evaluateOffsetValueExpectation(
  field: string,
  actualValue: unknown,
  expectation: OffsetValueExpectation,
  extracted: Record<string, unknown>,
): ExpectedFailure | null {
  if (!Array.isArray(actualValue)) {
    return expectedFailure(
      field,
      "valueAtOffset",
      expectation,
      actualValue,
      "offset predicates require an array value",
    );
  }

  const anchorIndices = findMatchingElementIndices(
    actualValue,
    expectation.value,
    extracted,
  );
  if (anchorIndices.length === 0) {
    return expectedFailure(
      field,
      "valueAtOffset",
      expectation,
      actualValue,
      `value ${JSON.stringify(expectation.value)} was not found`,
    );
  }

  const candidates = anchorIndices.map((anchorIndex) => ({
    anchorIndex,
    targetIndex: anchorIndex + expectation.offset,
  }));
  const inBounds = candidates.filter(
    (candidate) =>
      candidate.targetIndex >= 0 && candidate.targetIndex < actualValue.length,
  );
  if (inBounds.length === 0) {
    return expectedFailure(
      field,
      "valueAtOffset",
      expectation,
      actualValue,
      `all target positions for offset ${expectation.offset} were out of bounds; anchor indices ${JSON.stringify(anchorIndices)}`,
    );
  }

  const observations = inBounds.map((candidate) => ({
    anchorIndex: candidate.anchorIndex,
    targetIndex: candidate.targetIndex,
    targetValue: actualValue[candidate.targetIndex],
  }));
  for (const candidate of inBounds) {
    if (
      evaluateElementCandidate(
        `${field}[${candidate.targetIndex}]`,
        expectation.target,
        actualValue[candidate.targetIndex],
        extracted,
      ).length === 0
    ) {
      return null;
    }
  }

  return expectedFailure(
    field,
    "valueAtOffset",
    expectation,
    actualValue,
    `no occurrence of ${JSON.stringify(expectation.value)} had target ${JSON.stringify(expectation.target)} at offset ${expectation.offset}; observed ${JSON.stringify(observations)}`,
  );
}

function evaluateOffsetValuesExpectation(
  field: string,
  actualValue: unknown,
  expectation: OffsetValuesExpectation,
  extracted: Record<string, unknown>,
): ExpectedFailure | null {
  if (!Array.isArray(actualValue)) {
    return expectedFailure(
      field,
      "valuesAtOffsets",
      expectation,
      actualValue,
      "multi-offset predicates require an array value",
    );
  }

  const anchorIndices = findMatchingElementIndices(
    actualValue,
    expectation.value,
    extracted,
  );
  if (anchorIndices.length === 0) {
    return expectedFailure(
      field,
      "valuesAtOffsets",
      expectation,
      actualValue,
      `value ${JSON.stringify(expectation.value)} was not found`,
    );
  }

  const targetEntries = Object.entries(expectation.targets).map(
    ([offsetKey, target]) => ({
      offsetKey,
      offset: Number.parseInt(offsetKey, 10),
      target,
    }),
  );
  const observations = anchorIndices.map((anchorIndex) => ({
    anchorIndex,
    checks: targetEntries.map(({ offsetKey, offset, target }) => {
      const targetIndex = anchorIndex + offset;
      const inBounds = targetIndex >= 0 && targetIndex < actualValue.length;
      return {
        offset: offsetKey,
        targetIndex,
        inBounds,
        targetValue: inBounds ? actualValue[targetIndex] : null,
        matched:
          inBounds &&
          evaluateElementCandidate(
            `${field}[${targetIndex}]`,
            target,
            actualValue[targetIndex],
            extracted,
          ).length === 0,
      };
    }),
  }));

  const satisfied = observations.some((observation) =>
    observation.checks.every((check) => check.matched),
  );
  if (satisfied) return null;

  return expectedFailure(
    field,
    "valuesAtOffsets",
    expectation,
    actualValue,
    `no occurrence of ${JSON.stringify(expectation.value)} satisfied all requested offsets; observed ${JSON.stringify(observations)}`,
  );
}

function evaluateWindowMatchExpectation(
  field: string,
  actualValue: unknown,
  expectation: WindowMatchExpectation,
  extracted: Record<string, unknown>,
): ExpectedFailure | null {
  if (!Array.isArray(actualValue)) {
    return expectedFailure(
      field,
      "windowMatches",
      expectation,
      actualValue,
      "window predicates require an array value",
    );
  }

  const anchorIndices = findMatchingElementIndices(
    actualValue,
    expectation.value,
    extracted,
  );
  if (anchorIndices.length === 0) {
    return expectedFailure(
      field,
      "windowMatches",
      expectation,
      actualValue,
      `value ${JSON.stringify(expectation.value)} was not found`,
    );
  }

  const windows = anchorIndices.map((anchorIndex) => {
    const startIndex = anchorIndex + expectation.startOffset;
    const endIndex = startIndex + expectation.values.length;
    const inBounds = startIndex >= 0 && endIndex <= actualValue.length;
    const checks = inBounds
      ? expectation.values.map((expectedEntry, offset) => {
          const targetIndex = startIndex + offset;
          return {
            targetIndex,
            actualValue: actualValue[targetIndex],
            matched:
              evaluateElementCandidate(
                `${field}[${targetIndex}]`,
                expectedEntry,
                actualValue[targetIndex],
                extracted,
              ).length === 0,
          };
        })
      : [];
    return {
      anchorIndex,
      startIndex,
      endIndex,
      inBounds,
      checks,
    };
  });

  const satisfied = windows.some(
    (window) => window.inBounds && window.checks.every((check) => check.matched),
  );
  if (satisfied) return null;

  const inBoundsWindows = windows.filter((window) => window.inBounds);
  if (inBoundsWindows.length === 0) {
    return expectedFailure(
      field,
      "windowMatches",
      expectation,
      actualValue,
      `all windows for startOffset ${expectation.startOffset} and length ${expectation.values.length} were out of bounds; anchor indices ${JSON.stringify(anchorIndices)}`,
    );
  }

  return expectedFailure(
    field,
    "windowMatches",
    expectation,
    actualValue,
    `no occurrence of ${JSON.stringify(expectation.value)} matched window ${JSON.stringify(expectation.values)} from offset ${expectation.startOffset}; observed ${JSON.stringify(windows)}`,
  );
}

function evaluateWindowContainsExpectation(
  field: string,
  operator: "windowIncludesAll" | "windowIncludesAny",
  actualValue: unknown,
  expectation: WindowContainsExpectation,
  extracted: Record<string, unknown>,
): ExpectedFailure | null {
  if (!Array.isArray(actualValue)) {
    return expectedFailure(
      field,
      operator,
      expectation,
      actualValue,
      "window-contains predicates require an array value",
    );
  }

  const anchorIndices = findMatchingElementIndices(
    actualValue,
    expectation.value,
    extracted,
  );
  if (anchorIndices.length === 0) {
    return expectedFailure(
      field,
      operator,
      expectation,
      actualValue,
      `value ${JSON.stringify(expectation.value)} was not found`,
    );
  }

  const windows = anchorIndices.map((anchorIndex) => {
    const startIndex = anchorIndex + expectation.startOffset;
    const endIndex = anchorIndex + expectation.endOffset;
    const inBounds = startIndex >= 0 && endIndex < actualValue.length;
    const checks = expectation.targets.map((target) => {
      if (!inBounds) {
        return {
          target,
          matched: false,
          matchesAt: [],
        };
      }
      const matchesAt: number[] = [];
      for (let index = startIndex; index <= endIndex; index += 1) {
        if (
          evaluateElementCandidate(
            `${field}[${index}]`,
            target,
            actualValue[index],
            extracted,
          ).length === 0
        ) {
          matchesAt.push(index);
        }
      }
      return {
        target,
        matched: matchesAt.length > 0,
        matchesAt,
      };
    });
    return {
      anchorIndex,
      startIndex,
      endIndex,
      inBounds,
      checks,
    };
  });

  const satisfied = windows.some((window) =>
    operator === "windowIncludesAll"
      ? window.inBounds && window.checks.every((check) => check.matched)
      : window.inBounds && window.checks.some((check) => check.matched),
  );
  if (satisfied) return null;

  const inBoundsWindows = windows.filter((window) => window.inBounds);
  if (inBoundsWindows.length === 0) {
    return expectedFailure(
      field,
      operator,
      expectation,
      actualValue,
      `all windows for offsets ${expectation.startOffset}..${expectation.endOffset} were out of bounds; anchor indices ${JSON.stringify(anchorIndices)}`,
    );
  }

  return expectedFailure(
    field,
    operator,
    expectation,
    actualValue,
    operator === "windowIncludesAll"
      ? `no occurrence of ${JSON.stringify(expectation.value)} contained all targets ${JSON.stringify(expectation.targets)} within offsets ${expectation.startOffset}..${expectation.endOffset}; observed ${JSON.stringify(windows)}`
      : `no occurrence of ${JSON.stringify(expectation.value)} contained any target from ${JSON.stringify(expectation.targets)} within offsets ${expectation.startOffset}..${expectation.endOffset}; observed ${JSON.stringify(windows)}`,
  );
}

function evaluateElementCandidate(
  field: string,
  expectedElement: unknown,
  actualValue: unknown,
  extracted: Record<string, unknown>,
): ExpectedFailure[] {
  if (isExpectedMatcher(expectedElement)) {
    return evaluateMatcher(field, expectedElement, actualValue, extracted);
  }
  if (deepEqual(actualValue, expectedElement)) {
    return [];
  }
  return [
    expectedFailure(
      field,
      "equals",
      expectedElement,
      actualValue,
      `expected ${JSON.stringify(expectedElement)} got ${JSON.stringify(actualValue)}`,
    ),
  ];
}

function findMatchingElementIndex(
  actualValues: unknown[],
  expectedElement: unknown,
  extracted: Record<string, unknown>,
  fromEnd: boolean,
): number {
  if (fromEnd) {
    for (let index = actualValues.length - 1; index >= 0; index -= 1) {
      if (
        evaluateElementCandidate(
          `$[${index}]`,
          expectedElement,
          actualValues[index],
          extracted,
        ).length === 0
      ) {
        return index;
      }
    }
    return -1;
  }
  for (let index = 0; index < actualValues.length; index += 1) {
    if (
      evaluateElementCandidate(
        `$[${index}]`,
        expectedElement,
        actualValues[index],
        extracted,
      ).length === 0
    ) {
      return index;
    }
  }
  return -1;
}

function findMatchingElementIndices(
  actualValues: unknown[],
  expectedElement: unknown,
  extracted: Record<string, unknown>,
): number[] {
  const matches: number[] = [];
  for (let index = 0; index < actualValues.length; index += 1) {
    if (
      evaluateElementCandidate(
        `$[${index}]`,
        expectedElement,
        actualValues[index],
        extracted,
      ).length === 0
    ) {
      matches.push(index);
    }
  }
  return matches;
}

function evaluateArrayMembershipComparison(
  field: string,
  operator: "includesAll" | "includesAny",
  actualValue: unknown,
  expectedValues: unknown[],
  coercion: ValueCoercion | undefined,
): ExpectedFailure | null {
  if (!Array.isArray(actualValue)) {
    return expectedFailure(
      field,
      operator,
      expectedValues,
      actualValue,
      "set-membership predicates require an array value",
    );
  }
  if (operator === "includesAll") {
    const missing = expectedValues.filter(
      (candidate) => !arrayIncludesElement(actualValue, candidate, coercion),
    );
    if (missing.length === 0) return null;
    return expectedFailure(
      field,
      operator,
      expectedValues,
      actualValue,
      `missing expected element(s): ${JSON.stringify(missing)}`,
    );
  }
  if (
    expectedValues.some((candidate) =>
      arrayIncludesElement(actualValue, candidate, coercion),
    )
  ) {
    return null;
  }
  return expectedFailure(
    field,
    operator,
    expectedValues,
    actualValue,
    `none of the candidate elements matched: ${JSON.stringify(expectedValues)}`,
  );
}

function evaluateSetEqualityComparison(
  field: string,
  actualValue: unknown,
  expectedValues: unknown[],
  coercion: ValueCoercion | undefined,
): ExpectedFailure | null {
  if (!Array.isArray(actualValue)) {
    return expectedFailure(
      field,
      "setEquals",
      expectedValues,
      actualValue,
      "set equality requires an array value",
    );
  }
  const uniqueActual = uniqueElements(actualValue, coercion);
  const uniqueExpected = uniqueElements(expectedValues, coercion);
  const missing = uniqueExpected.filter(
    (candidate) => !arrayIncludesElement(uniqueActual, candidate, coercion),
  );
  const unexpected = uniqueActual.filter(
    (candidate) => !arrayIncludesElement(uniqueExpected, candidate, coercion),
  );
  if (missing.length === 0 && unexpected.length === 0) return null;

  const reasons: string[] = [];
  if (missing.length > 0) {
    reasons.push(`missing set member(s): ${JSON.stringify(missing)}`);
  }
  if (unexpected.length > 0) {
    reasons.push(`unexpected set member(s): ${JSON.stringify(unexpected)}`);
  }
  return expectedFailure(
    field,
    "setEquals",
    expectedValues,
    actualValue,
    reasons.join("; "),
  );
}

function evaluateBagEqualityComparison(
  field: string,
  actualValue: unknown,
  expectedValues: unknown[],
  coercion: ValueCoercion | undefined,
): ExpectedFailure | null {
  if (!Array.isArray(actualValue)) {
    return expectedFailure(
      field,
      "bagEquals",
      expectedValues,
      actualValue,
      "bag equality requires an array value",
    );
  }
  const candidates = uniqueElements([...actualValue, ...expectedValues], coercion);
  const missing: unknown[] = [];
  const unexpected: unknown[] = [];
  for (const candidate of candidates) {
    const actualCount = countMatchingElements(actualValue, candidate, coercion);
    const expectedCount = countMatchingElements(expectedValues, candidate, coercion);
    if (expectedCount > actualCount) {
      missing.push(...repeatValue(candidate, expectedCount - actualCount));
    } else if (actualCount > expectedCount) {
      unexpected.push(...repeatValue(candidate, actualCount - expectedCount));
    }
  }
  if (missing.length === 0 && unexpected.length === 0) return null;

  const reasons: string[] = [];
  if (missing.length > 0) {
    reasons.push(`missing bag member(s): ${JSON.stringify(missing)}`);
  }
  if (unexpected.length > 0) {
    reasons.push(`unexpected bag member(s): ${JSON.stringify(unexpected)}`);
  }
  return expectedFailure(
    field,
    "bagEquals",
    expectedValues,
    actualValue,
    reasons.join("; "),
  );
}

function evaluateSequenceComparison(
  field: string,
  operator:
    | "startsWithSequence"
    | "endsWithSequence"
    | "containsSequence"
    | "containsOrderedSubsequence",
  actualValue: unknown,
  expectedValues: unknown[],
  coercion: ValueCoercion | undefined,
): ExpectedFailure | null {
  if (!Array.isArray(actualValue)) {
    return expectedFailure(
      field,
      operator,
      expectedValues,
      actualValue,
      "sequence predicates require an array value",
    );
  }
  const passed =
    operator === "startsWithSequence"
      ? sequenceStartsWith(actualValue, expectedValues, coercion)
      : operator === "endsWithSequence"
        ? sequenceEndsWith(actualValue, expectedValues, coercion)
        : operator === "containsSequence"
          ? sequenceContains(actualValue, expectedValues, coercion)
          : sequenceContainsOrderedSubsequence(
              actualValue,
              expectedValues,
              coercion,
            );
  if (passed) return null;

  const reason =
    operator === "startsWithSequence"
      ? `array did not start with sequence ${JSON.stringify(expectedValues)}`
      : operator === "endsWithSequence"
        ? `array did not end with sequence ${JSON.stringify(expectedValues)}`
        : operator === "containsSequence"
          ? `contiguous sequence ${JSON.stringify(expectedValues)} was not found`
          : `ordered subsequence ${JSON.stringify(expectedValues)} was not found`;
  return expectedFailure(field, operator, expectedValues, actualValue, reason);
}

function evaluateOccurrenceExpectation(
  field: string,
  actualValue: unknown,
  occurrence: OccurrenceExpectation,
  coercion: ValueCoercion | undefined,
): ExpectedFailure[] {
  if (!Array.isArray(actualValue)) {
    return [
      expectedFailure(
        field,
        "occurs",
        occurrence,
        actualValue,
        "occurs requires an array value",
      ),
    ];
  }
  const count = actualValue.filter((entry) =>
    elementValuesEqual(entry, occurrence.value, coercion),
  ).length;
  const failures: ExpectedFailure[] = [];
  for (const [operator, expectedCount] of [
    ["equals", occurrence.equals],
    ["gt", occurrence.gt],
    ["gte", occurrence.gte],
    ["lt", occurrence.lt],
    ["lte", occurrence.lte],
  ] as const) {
    if (expectedCount === undefined) continue;
    const passed =
      operator === "equals"
        ? count === expectedCount
        : operator === "gt"
          ? count > expectedCount
          : operator === "gte"
            ? count >= expectedCount
            : operator === "lt"
              ? count < expectedCount
              : count <= expectedCount;
    if (passed) continue;
    const comparator =
      operator === "equals"
        ? "="
        : operator === "gt"
          ? ">"
          : operator === "gte"
            ? ">="
            : operator === "lt"
              ? "<"
              : "<=";
    failures.push(
      expectedFailure(
        field,
        `occurs.${operator}`,
        { value: occurrence.value, count: expectedCount },
        actualValue,
        `occurrence count for ${JSON.stringify(occurrence.value)} ${count} ${comparator} ${expectedCount} was not satisfied`,
      ),
    );
  }
  return failures;
}

function evaluateUniqueCountExpectation(
  field: string,
  actualValue: unknown,
  cardinality: CardinalityExpectation,
  coercion: ValueCoercion | undefined,
): ExpectedFailure[] {
  if (!Array.isArray(actualValue)) {
    return [
      expectedFailure(
        field,
        "uniqueCount",
        cardinality,
        actualValue,
        "uniqueCount requires an array value",
      ),
    ];
  }
  const count = uniqueElements(actualValue, coercion).length;
  const failures: ExpectedFailure[] = [];
  for (const [operator, expectedCount] of [
    ["equals", cardinality.equals],
    ["gt", cardinality.gt],
    ["gte", cardinality.gte],
    ["lt", cardinality.lt],
    ["lte", cardinality.lte],
  ] as const) {
    if (expectedCount === undefined) continue;
    const passed =
      operator === "equals"
        ? count === expectedCount
        : operator === "gt"
          ? count > expectedCount
          : operator === "gte"
            ? count >= expectedCount
            : operator === "lt"
              ? count < expectedCount
              : count <= expectedCount;
    if (passed) continue;
    const comparator =
      operator === "equals"
        ? "="
        : operator === "gt"
          ? ">"
          : operator === "gte"
            ? ">="
            : operator === "lt"
              ? "<"
              : "<=";
    failures.push(
      expectedFailure(
        field,
        `uniqueCount.${operator}`,
        expectedCount,
        actualValue,
        `unique count ${count} ${comparator} ${expectedCount} was not satisfied`,
      ),
    );
  }
  return failures;
}

function evaluateOrderExpectation(
  field: string,
  actualValue: unknown,
  order: OrderExpectation,
  coercion: ValueCoercion | undefined,
): ExpectedFailure | null {
  if (!Array.isArray(actualValue)) {
    return expectedFailure(
      field,
      "ordered",
      order,
      actualValue,
      "ordered requires an array value",
    );
  }
  if (actualValue.length <= 1) return null;

  const comparableValues: Array<{ value: number | string; display: string }> = [];
  for (const [index, entry] of actualValue.entries()) {
    const comparable = coerceComparable(entry, coercion);
    if (!comparable.ok) {
      return expectedFailure(
        field,
        "ordered",
        order,
        actualValue,
        `array entry [${index}] ${comparable.reason}`,
      );
    }
    comparableValues.push(comparable);
  }

  for (let index = 1; index < comparableValues.length; index += 1) {
    const previous = comparableValues[index - 1]!;
    const current = comparableValues[index]!;
    const passed =
      order.direction === "asc"
        ? order.strict
          ? previous.value < current.value
          : previous.value <= current.value
        : order.strict
          ? previous.value > current.value
          : previous.value >= current.value;
    if (passed) continue;
    const expectation = `${order.direction}${order.strict ? " strict" : ""}`;
    return expectedFailure(
      field,
      "ordered",
      order,
      actualValue,
      `values at [${index - 1}] and [${index}] were not ${expectation}: ${previous.display} then ${current.display}`,
    );
  }

  return null;
}

function evaluateDistinctComparison(
  field: string,
  actualValue: unknown,
  expectedDistinct: boolean,
  coercion: ValueCoercion | undefined,
): ExpectedFailure | null {
  if (!Array.isArray(actualValue)) {
    return expectedFailure(
      field,
      "distinct",
      expectedDistinct,
      actualValue,
      "distinct requires an array value",
    );
  }
  const duplicate = findDuplicateElement(actualValue, coercion);
  const isDistinct = duplicate === null;
  if (isDistinct === expectedDistinct) return null;
  if (expectedDistinct) {
    return expectedFailure(
      field,
      "distinct",
      expectedDistinct,
      actualValue,
      `duplicate element found at [${duplicate!.leftIndex}] and [${duplicate!.rightIndex}]`,
    );
  }
  return expectedFailure(
    field,
    "distinct",
    expectedDistinct,
    actualValue,
    "expected at least one duplicate element",
  );
}

function arrayIncludesElement(
  actualValues: unknown[],
  expectedValue: unknown,
  coercion: ValueCoercion | undefined,
): boolean {
  return actualValues.some((entry) =>
    elementValuesEqual(entry, expectedValue, coercion),
  );
}

function countMatchingElements(
  values: unknown[],
  expectedValue: unknown,
  coercion: ValueCoercion | undefined,
): number {
  return values.filter((entry) =>
    elementValuesEqual(entry, expectedValue, coercion),
  ).length;
}

function repeatValue(value: unknown, count: number): unknown[] {
  return Array.from({ length: count }, () => value);
}

function sequenceStartsWith(
  actualValues: unknown[],
  expectedValues: unknown[],
  coercion: ValueCoercion | undefined,
): boolean {
  if (expectedValues.length > actualValues.length) return false;
  return expectedValues.every((expectedValue, index) =>
    elementValuesEqual(actualValues[index], expectedValue, coercion),
  );
}

function sequenceEndsWith(
  actualValues: unknown[],
  expectedValues: unknown[],
  coercion: ValueCoercion | undefined,
): boolean {
  if (expectedValues.length > actualValues.length) return false;
  const offset = actualValues.length - expectedValues.length;
  return expectedValues.every((expectedValue, index) =>
    elementValuesEqual(actualValues[offset + index], expectedValue, coercion),
  );
}

function sequenceContains(
  actualValues: unknown[],
  expectedValues: unknown[],
  coercion: ValueCoercion | undefined,
): boolean {
  if (expectedValues.length > actualValues.length) return false;
  for (
    let startIndex = 0;
    startIndex <= actualValues.length - expectedValues.length;
    startIndex += 1
  ) {
    const matched = expectedValues.every((expectedValue, index) =>
      elementValuesEqual(actualValues[startIndex + index], expectedValue, coercion),
    );
    if (matched) return true;
  }
  return false;
}

function sequenceContainsOrderedSubsequence(
  actualValues: unknown[],
  expectedValues: unknown[],
  coercion: ValueCoercion | undefined,
): boolean {
  if (expectedValues.length > actualValues.length) return false;
  let expectedIndex = 0;
  for (const actualValue of actualValues) {
    if (
      elementValuesEqual(
        actualValue,
        expectedValues[expectedIndex],
        coercion,
      )
    ) {
      expectedIndex += 1;
      if (expectedIndex === expectedValues.length) return true;
    }
  }
  return false;
}

function uniqueElements(
  values: unknown[],
  coercion: ValueCoercion | undefined,
): unknown[] {
  const unique: unknown[] = [];
  for (const value of values) {
    if (!arrayIncludesElement(unique, value, coercion)) {
      unique.push(value);
    }
  }
  return unique;
}

function findDuplicateElement(
  actualValues: unknown[],
  coercion: ValueCoercion | undefined,
): { leftIndex: number; rightIndex: number } | null {
  for (let leftIndex = 0; leftIndex < actualValues.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < actualValues.length;
      rightIndex += 1
    ) {
      if (
        elementValuesEqual(
          actualValues[leftIndex],
          actualValues[rightIndex],
          coercion,
        )
      ) {
        return { leftIndex, rightIndex };
      }
    }
  }
  return null;
}

function evaluateCountComparison(
  field: string,
  operator: "countEquals" | "countGt" | "countGte" | "countLt" | "countLte",
  actualCount: number | null,
  expectedCount: number,
  actualValue: unknown,
): ExpectedFailure | null {
  if (actualCount === null) {
    return expectedFailure(
      field,
      operator,
      expectedCount,
      actualValue,
      "value has no measurable count",
    );
  }
  const passed =
    operator === "countEquals"
      ? actualCount === expectedCount
      : operator === "countGt"
        ? actualCount > expectedCount
        : operator === "countGte"
          ? actualCount >= expectedCount
          : operator === "countLt"
            ? actualCount < expectedCount
            : actualCount <= expectedCount;
  if (passed) return null;

  const comparator =
    operator === "countEquals"
      ? "="
      : operator === "countGt"
        ? ">"
        : operator === "countGte"
          ? ">="
          : operator === "countLt"
            ? "<"
            : "<=";
  return expectedFailure(
    field,
    operator,
    expectedCount,
    actualValue,
    `count ${actualCount} ${comparator} ${expectedCount} was not satisfied`,
  );
}

function evaluateNumericAggregateComparison(
  field: string,
  operator:
    | "sumEquals"
    | "sumGt"
    | "sumGte"
    | "sumLt"
    | "sumLte"
    | "avgEquals"
    | "avgGt"
    | "avgGte"
    | "avgLt"
    | "avgLte"
    | "minEquals"
    | "minGt"
    | "minGte"
    | "minLt"
    | "minLte"
    | "maxEquals"
    | "maxGt"
    | "maxGte"
    | "maxLt"
    | "maxLte"
    | "medianEquals"
    | "medianGt"
    | "medianGte"
    | "medianLt"
    | "medianLte"
    | "p90Equals"
    | "p90Gt"
    | "p90Gte"
    | "p90Lt"
    | "p90Lte"
    | "p95Equals"
    | "p95Gt"
    | "p95Gte"
    | "p95Lt"
    | "p95Lte",
  actualValue: unknown,
  expectedValue: number,
): ExpectedFailure | null {
  const numericCollection = coerceNumericCollection(actualValue);
  if (!numericCollection.ok) {
    return expectedFailure(
      field,
      operator,
      expectedValue,
      actualValue,
      numericAggregateCollectionReason(operator, numericCollection),
    );
  }
  const metric = numericAggregateMetric(operator);
  const actualMetricValue =
    metric === "sum"
      ? numericCollection.sum
      : metric === "avg"
        ? numericCollection.avg
      : metric === "min"
          ? numericCollection.min
          : metric === "max"
            ? numericCollection.max
            : metric === "median"
              ? numericCollection.median
              : metric === "p90"
                ? numericCollection.p90
                : numericCollection.p95;
  if (actualMetricValue === null) {
    return expectedFailure(
      field,
      operator,
      expectedValue,
      actualValue,
      `${metric} comparisons require a non-empty numeric array`,
    );
  }
  const passed =
    aggregateOperatorKind(operator) === "Equals"
      ? actualMetricValue === expectedValue
      : aggregateOperatorKind(operator) === "Gt"
        ? actualMetricValue > expectedValue
        : aggregateOperatorKind(operator) === "Gte"
          ? actualMetricValue >= expectedValue
          : aggregateOperatorKind(operator) === "Lt"
            ? actualMetricValue < expectedValue
            : actualMetricValue <= expectedValue;
  if (passed) return null;

  const comparator =
    aggregateOperatorKind(operator) === "Equals"
      ? "="
      : aggregateOperatorKind(operator) === "Gt"
        ? ">"
        : aggregateOperatorKind(operator) === "Gte"
          ? ">="
          : aggregateOperatorKind(operator) === "Lt"
            ? "<"
            : "<=";
  return expectedFailure(
    field,
    operator,
    expectedValue,
    actualValue,
    `${metric} ${formatNumericDiagnostic(actualMetricValue)} ${comparator} ${formatNumericDiagnostic(expectedValue)} was not satisfied`,
  );
}

function numericAggregateMetric(
  operator:
    | "sumEquals"
    | "sumGt"
    | "sumGte"
    | "sumLt"
    | "sumLte"
    | "avgEquals"
    | "avgGt"
    | "avgGte"
    | "avgLt"
    | "avgLte"
    | "minEquals"
    | "minGt"
    | "minGte"
    | "minLt"
    | "minLte"
    | "maxEquals"
    | "maxGt"
    | "maxGte"
    | "maxLt"
    | "maxLte"
    | "medianEquals"
    | "medianGt"
    | "medianGte"
    | "medianLt"
    | "medianLte"
    | "p90Equals"
    | "p90Gt"
    | "p90Gte"
    | "p90Lt"
    | "p90Lte"
    | "p95Equals"
    | "p95Gt"
    | "p95Gte"
    | "p95Lt"
    | "p95Lte",
): "sum" | "avg" | "min" | "max" | "median" | "p90" | "p95" {
  if (operator.startsWith("sum")) return "sum";
  if (operator.startsWith("avg")) return "avg";
  if (operator.startsWith("min")) return "min";
  if (operator.startsWith("max")) return "max";
  if (operator.startsWith("median")) return "median";
  if (operator.startsWith("p90")) return "p90";
  return "p95";
}

function aggregateOperatorKind(
  operator:
    | "sumEquals"
    | "sumGt"
    | "sumGte"
    | "sumLt"
    | "sumLte"
    | "avgEquals"
    | "avgGt"
    | "avgGte"
    | "avgLt"
    | "avgLte"
    | "minEquals"
    | "minGt"
    | "minGte"
    | "minLt"
    | "minLte"
    | "maxEquals"
    | "maxGt"
    | "maxGte"
    | "maxLt"
    | "maxLte"
    | "medianEquals"
    | "medianGt"
    | "medianGte"
    | "medianLt"
    | "medianLte"
    | "p90Equals"
    | "p90Gt"
    | "p90Gte"
    | "p90Lt"
    | "p90Lte"
    | "p95Equals"
    | "p95Gt"
    | "p95Gte"
    | "p95Lt"
    | "p95Lte",
): "Equals" | "Gt" | "Gte" | "Lt" | "Lte" {
  if (operator.endsWith("Equals")) return "Equals";
  if (operator.endsWith("Gt")) return "Gt";
  if (operator.endsWith("Gte")) return "Gte";
  if (operator.endsWith("Lt")) return "Lt";
  return "Lte";
}

function numericAggregateCollectionReason(
  operator:
    | "sumEquals"
    | "sumGt"
    | "sumGte"
    | "sumLt"
    | "sumLte"
    | "avgEquals"
    | "avgGt"
    | "avgGte"
    | "avgLt"
    | "avgLte"
    | "minEquals"
    | "minGt"
    | "minGte"
    | "minLt"
    | "minLte"
    | "maxEquals"
    | "maxGt"
    | "maxGte"
    | "maxLt"
    | "maxLte"
    | "medianEquals"
    | "medianGt"
    | "medianGte"
    | "medianLt"
    | "medianLte"
    | "p90Equals"
    | "p90Gt"
    | "p90Gte"
    | "p90Lt"
    | "p90Lte"
    | "p95Equals"
    | "p95Gt"
    | "p95Gte"
    | "p95Lt"
    | "p95Lte",
  result: { ok: false; reason: string; code: "array_required" | "entry_not_numeric"; index?: number },
): string {
  if (result.code === "array_required") {
    return `${numericAggregateMetric(operator)} comparisons require an array value`;
  }
  return result.reason;
}

function evaluateApproximateMatcher(
  field: string,
  expectation: ExpectedMatcher,
  actualValue: unknown,
  extracted: Record<string, unknown>,
): ExpectedFailure[] {
  const failures: ExpectedFailure[] = [];
  const targetLabel =
    typeof expectation.approxField === "string"
      ? expectation.approxField
      : expectation.approx;
  const targetValue =
    typeof expectation.approxField === "string"
      ? extracted[expectation.approxField]
      : expectation.approx;

  if (
    typeof expectation.approxField === "string" &&
    !Object.prototype.hasOwnProperty.call(extracted, expectation.approxField)
  ) {
    failures.push(
      expectedFailure(
        field,
        "approxField",
        expectation.approxField,
        actualValue,
        `referenced field "${expectation.approxField}" was not extracted`,
      ),
    );
    return failures;
  }

  const actualComparable = coerceNumericComparable(actualValue);
  if (!actualComparable.ok) {
    failures.push(
      expectedFailure(
        field,
        typeof expectation.approxField === "string" ? "approxField" : "approx",
        targetLabel,
        actualValue,
        actualComparable.reason,
      ),
    );
    return failures;
  }
  const targetComparable = coerceNumericComparable(targetValue);
  if (!targetComparable.ok) {
    failures.push(
      expectedFailure(
        field,
        typeof expectation.approxField === "string" ? "approxField" : "approx",
        targetLabel,
        actualValue,
        typeof expectation.approxField === "string"
          ? `referenced field "${expectation.approxField}" ${targetComparable.reason}`
          : targetComparable.reason,
      ),
    );
    return failures;
  }

  const difference = Math.abs(actualComparable.value - targetComparable.value);
  const absoluteTolerance =
    typeof expectation.within === "number" ? expectation.within : null;
  const percentTolerance =
    typeof expectation.withinPercent === "number"
      ? (Math.abs(targetComparable.value) * expectation.withinPercent) / 100
      : null;
  const passed =
    (absoluteTolerance !== null && difference <= absoluteTolerance) ||
    (percentTolerance !== null && difference <= percentTolerance);
  if (passed) return failures;

  const toleranceParts: string[] = [];
  if (absoluteTolerance !== null) {
    toleranceParts.push(`within ${formatNumericDiagnostic(absoluteTolerance)}`);
  }
  if (percentTolerance !== null && typeof expectation.withinPercent === "number") {
    toleranceParts.push(
      `within ${formatNumericDiagnostic(expectation.withinPercent)}% (${formatNumericDiagnostic(percentTolerance)})`,
    );
  }
  failures.push(
    expectedFailure(
      field,
      typeof expectation.approxField === "string" ? "approxField" : "approx",
      targetLabel,
      actualValue,
      `difference ${formatNumericDiagnostic(difference)} exceeded ${toleranceParts.join(" or ")} from ${targetComparable.display}`,
    ),
  );
  return failures;
}

function evaluateFieldReferenceEquality(
  field: string,
  operator: "equalsField" | "notEqualsField",
  actualValue: unknown,
  refField: string,
  extracted: Record<string, unknown>,
  coercion: ValueCoercion | undefined,
  shouldEqual: boolean,
): ExpectedFailure[] {
  const failures: ExpectedFailure[] = [];
  if (!Object.prototype.hasOwnProperty.call(extracted, refField)) {
    failures.push(
      expectedFailure(
        field,
        operator,
        refField,
        actualValue,
        `referenced field "${refField}" was not extracted`,
      ),
    );
    return failures;
  }
  const referenceValue = extracted[refField];
  const equal = valuesEqual(actualValue, referenceValue, coercion);
  if (equal !== shouldEqual) {
    failures.push(
      expectedFailure(
        field,
        operator,
        refField,
        actualValue,
        shouldEqual
          ? `expected value to equal field "${refField}" (${JSON.stringify(referenceValue)})`
          : `did not expect value to equal field "${refField}" (${JSON.stringify(referenceValue)})`,
      ),
    );
  }
  return failures;
}

function evaluateOrderedComparison(
  field: string,
  operator: "gt" | "gte" | "lt" | "lte" | "gtField" | "gteField" | "ltField" | "lteField",
  actualValue: unknown,
  expectedValue: unknown,
  coercion: ValueCoercion | undefined,
  expectedLabel: string,
  refField?: string,
): ExpectedFailure | null {
  const actualComparable = coerceComparable(actualValue, coercion);
  if (!actualComparable.ok) {
    return expectedFailure(
      field,
      operator,
      expectedLabel,
      actualValue,
      actualComparable.reason,
    );
  }
  const expectedComparable = coerceComparable(expectedValue, coercion);
  if (!expectedComparable.ok) {
    return expectedFailure(
      field,
      operator,
      refField ?? expectedLabel,
      actualValue,
      refField
        ? `referenced field "${refField}" ${expectedComparable.reason}`
        : expectedComparable.reason,
    );
  }
  let normalizedOperator: OrderedOperator;
  if (operator === "gt" || operator === "gtField") normalizedOperator = "gt";
  else if (operator === "gte" || operator === "gteField") normalizedOperator = "gte";
  else if (operator === "lt" || operator === "ltField") normalizedOperator = "lt";
  else normalizedOperator = "lte";
  const passed = compareOrderedValues(
    actualComparable.value,
    expectedComparable.value,
    normalizedOperator,
  );
  if (passed) return null;
  return expectedFailure(
    field,
    operator,
    refField ?? expectedValue,
    actualValue,
    `expected ${actualComparable.display} ${orderedOperatorLabel(normalizedOperator)} ${expectedComparable.display}`,
  );
}

function valuesEqual(
  actualValue: unknown,
  expectedValue: unknown,
  coercion: ValueCoercion | undefined,
): boolean {
  if (!coercion) return deepEqual(actualValue, expectedValue);
  const actualComparable = coerceComparable(actualValue, coercion);
  const expectedComparable = coerceComparable(expectedValue, coercion);
  return (
    actualComparable.ok &&
    expectedComparable.ok &&
    Object.is(actualComparable.value, expectedComparable.value)
  );
}

function elementValuesEqual(
  actualValue: unknown,
  expectedValue: unknown,
  coercion: ValueCoercion | undefined,
): boolean {
  if (!coercion) return deepEqual(actualValue, expectedValue);
  const actualComparable = coerceComparable(actualValue, coercion);
  const expectedComparable = coerceComparable(expectedValue, coercion);
  if (actualComparable.ok && expectedComparable.ok) {
    return Object.is(actualComparable.value, expectedComparable.value);
  }
  return deepEqual(actualValue, expectedValue);
}

function compareOrderedValues(
  actual: number | string,
  expected: number | string,
  operator: OrderedOperator,
): boolean {
  if (operator === "gt") return actual > expected;
  if (operator === "gte") return actual >= expected;
  if (operator === "lt") return actual < expected;
  return actual <= expected;
}

function orderedOperatorLabel(operator: OrderedOperator): string {
  if (operator === "gt") return ">";
  if (operator === "gte") return ">=";
  if (operator === "lt") return "<";
  return "<=";
}

function coerceComparable(
  value: unknown,
  coercion: ValueCoercion | undefined,
): { ok: true; value: number | string; display: string } | { ok: false; reason: string } {
  if (coercion === "number") {
    const parsed = parseNumericValue(value);
    if (parsed === null) {
      return { ok: false, reason: "could not be coerced to number" };
    }
    return { ok: true, value: parsed, display: String(parsed) };
  }
  if (coercion === "date") {
    const parsed = parseDateValue(value);
    if (parsed === null) {
      return { ok: false, reason: "could not be coerced to date" };
    }
    return { ok: true, value: parsed.valueOf(), display: parsed.toISOString() };
  }
  if (coercion === "string") {
    if (typeof value !== "string") {
      return { ok: false, reason: "could not be coerced to string" };
    }
    return { ok: true, value, display: JSON.stringify(value) };
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return { ok: true, value, display: String(value) };
  }
  if (typeof value === "string") {
    return { ok: true, value, display: JSON.stringify(value) };
  }
  return {
    ok: false,
    reason: 'ordered comparison requires `coerce: "number" | "date" | "string"` or already-ordered values',
  };
}

function coerceNumericComparable(
  value: unknown,
): { ok: true; value: number; display: string } | { ok: false; reason: string } {
  const parsed = parseNumericValue(value);
  if (parsed === null) {
    return { ok: false, reason: "could not be coerced to number" };
  }
  return { ok: true, value: parsed, display: String(parsed) };
}

function coerceNumericCollection(
  value: unknown,
): | { ok: true; values: number[]; sum: number; avg: number | null; min: number | null; max: number | null; median: number | null; p90: number | null; p95: number | null }
 | { ok: false; reason: string; code: "array_required" | "entry_not_numeric"; index?: number } {
  if (!Array.isArray(value)) {
    return {
      ok: false,
      reason: "numeric aggregate comparisons require an array value",
      code: "array_required",
    };
  }
  const values: number[] = [];
  for (const [index, entry] of value.entries()) {
    const parsed = parseNumericValue(entry);
    if (parsed === null) {
      return {
        ok: false,
        reason: `array entry [${index}] could not be coerced to number`,
        code: "entry_not_numeric",
        index,
      };
    }
    values.push(parsed);
  }
  const sum = values.reduce((total, entry) => total + entry, 0);
  const sortedValues = [...values].sort((left, right) => left - right);
  const middleIndex = Math.floor(sortedValues.length / 2);
  const median =
    sortedValues.length === 0
      ? null
      : sortedValues.length % 2 === 1
        ? sortedValues[middleIndex]!
        : (sortedValues[middleIndex - 1]! + sortedValues[middleIndex]!) / 2;
  const p90 = interpolatePercentile(sortedValues, 0.9);
  const p95 = interpolatePercentile(sortedValues, 0.95);
  return {
    ok: true,
    values,
    sum,
    avg: values.length > 0 ? sum / values.length : null,
    min: values.length > 0 ? Math.min(...values) : null,
    max: values.length > 0 ? Math.max(...values) : null,
    median,
    p90,
    p95,
  };
}

function interpolatePercentile(
  sortedValues: number[],
  percentile: number,
): number | null {
  if (sortedValues.length === 0) return null;
  const position = (sortedValues.length - 1) * percentile;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lowerValue = sortedValues[lowerIndex]!;
  const upperValue = sortedValues[upperIndex]!;
  if (lowerIndex === upperIndex) return lowerValue;
  const weight = position - lowerIndex;
  return lowerValue + (upperValue - lowerValue) * weight;
}

function parseNumericValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const negative = /^\(.*\)$/.test(trimmed);
  const unwrapped = negative ? trimmed.slice(1, -1) : trimmed;
  const multiplierMatch = unwrapped.match(/([kmbt])$/i);
  const multiplier =
    multiplierMatch?.[1]?.toLowerCase() === "k"
      ? 1_000
      : multiplierMatch?.[1]?.toLowerCase() === "m"
        ? 1_000_000
        : multiplierMatch?.[1]?.toLowerCase() === "b"
          ? 1_000_000_000
          : multiplierMatch?.[1]?.toLowerCase() === "t"
            ? 1_000_000_000_000
            : 1;
  const numericText = unwrapped
    .replace(/[$,%\s]/g, "")
    .replace(/,/g, "")
    .replace(/[kmbt]$/i, "");
  if (!numericText || !/^[-+]?\d*\.?\d+$/.test(numericText)) return null;
  const parsed = Number.parseFloat(numericText);
  if (!Number.isFinite(parsed)) return null;
  const signed = negative ? -parsed : parsed;
  return signed * multiplier;
}

function parseDateValue(value: unknown): Date | null {
  if (value instanceof Date && Number.isFinite(value.valueOf())) return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isFinite(date.valueOf()) ? date : null;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = new Date(trimmed);
  return Number.isFinite(parsed.valueOf()) ? parsed : null;
}

function expectedFailure(
  field: string,
  operator: string,
  expected: unknown,
  actual: unknown,
  reason: string,
): ExpectedFailure {
  return { field, operator, expected, actual, reason };
}

function formatExpectedFailure(failure: ExpectedFailure): string {
  return `${failure.field}.${failure.operator} ${failure.reason}`;
}

function hasObservableValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return true;
}

function valueIncludes(actual: unknown, expected: unknown): boolean {
  if (typeof actual === "string" && typeof expected === "string") {
    return actual.includes(expected);
  }
  if (Array.isArray(actual)) {
    return actual.some((entry) => deepEqual(entry, expected));
  }
  return false;
}

function measurableLength(value: unknown): number | null {
  if (typeof value === "string" || Array.isArray(value)) return value.length;
  if (isRecord(value)) return Object.keys(value).length;
  return null;
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((value, index) => deepEqual(value, right[index]))
    );
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key) =>
          Object.prototype.hasOwnProperty.call(right, key) &&
          deepEqual(left[key], right[key]),
      )
    );
  }
  return false;
}

function summarizeValidationFailure(
  missingFields: string[],
  expectedFailures: ExpectedFailure[],
  schemaErrors: string[],
): string {
  const parts: string[] = [];
  if (missingFields.length > 0) {
    parts.push(`missing required fields: ${missingFields.join(", ")}`);
  }
  if (expectedFailures.length > 0) {
    parts.push(
      `expected mismatches: ${expectedFailures
        .map(formatExpectedFailure)
        .join("; ")}`,
    );
  }
  if (schemaErrors.length > 0) {
    parts.push(`schema validation failed: ${schemaErrors.join("; ")}`);
  }
  return `validate failed: ${parts.join(" | ")}`;
}
