/**
 * A small, dependency-free JSON Schema validator.
 *
 * ── Why not Ajv ──────────────────────────────────────────────────────────────
 *
 * Ajv is a large dependency and, more importantly, it *compiles and evaluates* the
 * schema. Here the schema is data that arrives over the wire: a tool's `inputSchema` is
 * shipped to whichever model is planning, and an LLM-backed planner may echo a shape
 * back. Executing structure that originated outside this process is exactly the kind of
 * thing that should not happen in a creative tool holding a user's projects.
 *
 * So this validator deliberately implements a *subset* — the subset the agent system
 * actually uses — and it is honest about what it does not understand. An unknown
 * keyword is reported as an error in the schema, never silently ignored. A schema that
 * quietly validates nothing is worse than no schema at all, because every downstream
 * "the input was validated" claim becomes false.
 *
 * ── Supported keywords ───────────────────────────────────────────────────────
 *
 *   type (incl. union arrays and "integer"), enum, const,
 *   properties, required, additionalProperties,
 *   items, minItems, maxItems, uniqueItems, minLength, maxLength,
 *   pattern, minimum, maximum, exclusiveMinimum, exclusiveMaximum,
 *   multipleOf, allOf, anyOf, oneOf, not,
 *   format (date-time only), description, title, default, examples, $schema, $id
 *
 * Anything else is rejected at schema-compile time.
 */

// ---------------------------------------------------------------------------
// Schema shape
// ---------------------------------------------------------------------------

export type JsonSchemaTypeName =
  | "object"
  | "array"
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "null";

/**
 * A JSON Schema fragment.
 *
 * Kept deliberately open (`Record<string, unknown>` compatible) so tool authors can
 * write plain object literals without fighting the type, while `assertSupportedSchema`
 * is what catches a keyword this validator cannot honour.
 */
export interface JsonSchema {
  readonly type?: JsonSchemaTypeName | readonly JsonSchemaTypeName[];
  readonly enum?: readonly unknown[];
  readonly const?: unknown;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | JsonSchema;
  readonly items?: JsonSchema;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly uniqueItems?: boolean;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly exclusiveMinimum?: number;
  readonly exclusiveMaximum?: number;
  readonly multipleOf?: number;
  readonly allOf?: readonly JsonSchema[];
  readonly anyOf?: readonly JsonSchema[];
  readonly oneOf?: readonly JsonSchema[];
  readonly not?: JsonSchema;
  /** Only "date-time" is implemented; any other value is rejected. */
  readonly format?: string;
  readonly description?: string;
  readonly title?: string;
  readonly default?: unknown;
  readonly examples?: readonly unknown[];
  readonly $schema?: string;
  readonly $id?: string;
  [keyword: string]: unknown;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** One validation failure, located with a JSON Pointer so callers can highlight a field. */
export interface ValidationIssue {
  /** JSON Pointer to the offending value, e.g. `/scenes/2/durationSeconds`. "" is root. */
  readonly path: string;
  /** What the schema demanded. */
  readonly expected: string;
  /** What was actually there, rendered compactly. Never contains secrets by design. */
  readonly actual: string;
  readonly message: string;
}

export type ValidationOutcome =
  | { readonly valid: true }
  | { readonly valid: false; readonly issues: readonly ValidationIssue[] };

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when a *schema itself* is unusable — an unsupported keyword, a bad regex, a
 * malformed `required`. Distinct from validation failure on purpose: a broken schema is
 * a programming error in the tool registration, whereas invalid input is a caller error
 * and must be reported, not thrown.
 */
export class SchemaDefinitionError extends Error {
  readonly toolName: string;
  readonly issues: readonly string[];

  constructor(toolName: string, issues: readonly string[]) {
    super(
      `The schema for tool "${toolName}" uses features this validator cannot honour:\n` +
        issues.map((i) => `  - ${i}`).join("\n"),
    );
    this.name = "SchemaDefinitionError";
    this.toolName = toolName;
    this.issues = issues;
  }
}

// ---------------------------------------------------------------------------
// Keyword allowlist
// ---------------------------------------------------------------------------

const SUPPORTED_KEYWORDS = new Set<string>([
  "type",
  "enum",
  "const",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minLength",
  "maxLength",
  "pattern",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "format",
  "description",
  "title",
  "default",
  "examples",
  "$schema",
  "$id",
  // Annotations only; ignored deliberately and listed so their presence is not an error.
  "deprecated",
  "readOnly",
  "writeOnly",
]);

const SUPPORTED_TYPES = new Set<string>([
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
]);

const SUPPORTED_FORMATS = new Set<string>(["date-time"]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check that a schema uses only supported keywords, recursively.
 *
 * Call this at *registration* time, not at invocation time: a tool whose schema is not
 * understood should fail to register, loudly, on the developer's machine — not fail
 * mysteriously in front of a user halfway through a build.
 *
 * @throws SchemaDefinitionError if anything is unsupported.
 */
export function assertSupportedSchema(schema: JsonSchema, toolName: string): void {
  const issues = collectSchemaIssues(schema, toolName, "#");
  if (issues.length > 0) throw new SchemaDefinitionError(toolName, issues);
}

/** Non-throwing variant, for reporting a problem into a UI rather than crashing. */
export function describeSchemaProblems(
  schema: JsonSchema,
  toolName: string,
): readonly string[] {
  return collectSchemaIssues(schema, toolName, "#");
}

/**
 * Validate a value against a schema.
 *
 * Never throws for invalid *data* — returns a structured outcome. It does throw if the
 * schema itself is broken, because that is a bug in this codebase and swallowing it
 * would let an unvalidated value through.
 */
export function validateAgainstSchema(
  value: unknown,
  schema: JsonSchema,
  toolName = "<anonymous>",
): ValidationOutcome {
  assertSupportedSchema(schema, toolName);
  const issues: ValidationIssue[] = [];
  validateNode(value, schema, "", issues, schema);
  return issues.length === 0 ? { valid: true } : { valid: false, issues };
}

/** Convenience: does this value satisfy the schema? */
export function isValidAgainstSchema(value: unknown, schema: JsonSchema): boolean {
  return validateAgainstSchema(value, schema).valid;
}

/** Render a compact, single-line description of an arbitrary value for error messages. */
export function describeValue(value: unknown, budget = 60): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") {
    return value.length > budget ? JSON.stringify(value.slice(0, budget - 1) + "…") : JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === "object") {
    const keys = Object.keys(value as object);
    return keys.length === 0
      ? "object{}"
      : `object{${keys.slice(0, 5).join(",")}${keys.length > 5 ? ",…" : ""}}`;
  }
  return typeof value;
}

/** Append a JSON Pointer segment, escaping `~` and `/` per RFC 6901. */
export function appendPointer(pointer: string, segment: string): string {
  return `${pointer}/${segment.replace(/~/g, "~0").replace(/\//g, "~1")}`;
}

// ---------------------------------------------------------------------------
// Schema static analysis
// ---------------------------------------------------------------------------

function collectSchemaIssues(
  schema: JsonSchema,
  toolName: string,
  pointer: string,
): string[] {
  const issues: string[] = [];

  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    issues.push(`${pointer}: schema must be an object.`);
    return issues;
  }

  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(keyword)) {
      issues.push(
        `${pointer}: unsupported keyword "${keyword}". Supported keywords: ` +
          `${[...SUPPORTED_KEYWORDS].sort().join(", ")}.`,
      );
    }
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (types.length === 0) issues.push(`${pointer}/type: must name at least one type.`);
    for (const t of types) {
      if (typeof t !== "string" || !SUPPORTED_TYPES.has(t)) {
        issues.push(`${pointer}/type: unsupported type ${describeValue(t)}.`);
      }
    }
  }

  if (schema.format !== undefined && !SUPPORTED_FORMATS.has(schema.format)) {
    issues.push(
      `${pointer}/format: "${schema.format}" is not implemented (only "date-time" is). ` +
        `Remove it rather than assuming it validates.`,
    );
  }

  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== "string") {
      issues.push(`${pointer}/pattern: must be a string.`);
    } else {
      try {
        new RegExp(schema.pattern);
      } catch (error) {
        issues.push(`${pointer}/pattern: not a valid regular expression — ${String(error)}`);
      }
    }
  }

  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required) || schema.required.some((r) => typeof r !== "string")) {
      issues.push(`${pointer}/required: must be an array of strings.`);
    }
  }

  if (schema.properties !== undefined) {
    if (typeof schema.properties !== "object" || schema.properties === null) {
      issues.push(`${pointer}/properties: must be an object.`);
    } else {
      for (const [key, child] of Object.entries(schema.properties)) {
        issues.push(...collectSchemaIssues(child, toolName, appendPointer(`${pointer}/properties`, key)));
      }
    }
  }

  if (schema.items !== undefined) {
    issues.push(...collectSchemaIssues(schema.items, toolName, `${pointer}/items`));
  }

  if (typeof schema.additionalProperties === "object" && schema.additionalProperties !== null) {
    issues.push(
      ...collectSchemaIssues(schema.additionalProperties, toolName, `${pointer}/additionalProperties`),
    );
  }

  for (const combinator of ["allOf", "anyOf", "oneOf"] as const) {
    const branches = schema[combinator];
    if (branches === undefined) continue;
    if (!Array.isArray(branches) || branches.length === 0) {
      issues.push(`${pointer}/${combinator}: must be a non-empty array of schemas.`);
      continue;
    }
    branches.forEach((branch, index) => {
      issues.push(...collectSchemaIssues(branch, toolName, `${pointer}/${combinator}/${index}`));
    });
  }

  if (schema.not !== undefined) {
    issues.push(...collectSchemaIssues(schema.not, toolName, `${pointer}/not`));
  }

  return issues.map((issue) => issue.replace(/^#/, toolName));
}

// ---------------------------------------------------------------------------
// Instance validation
// ---------------------------------------------------------------------------

function validateNode(
  value: unknown,
  schema: JsonSchema,
  pointer: string,
  issues: ValidationIssue[],
  root: JsonSchema,
): void {
  void root;

  if (schema.const !== undefined && !deepEqual(value, schema.const)) {
    issues.push({
      path: pointer,
      expected: `the constant ${describeValue(schema.const)}`,
      actual: describeValue(value),
      message: `must equal ${describeValue(schema.const)}.`,
    });
  }

  if (schema.enum !== undefined && !schema.enum.some((candidate) => deepEqual(value, candidate))) {
    issues.push({
      path: pointer,
      expected: `one of ${schema.enum.map((v) => describeValue(v, 24)).join(" | ")}`,
      actual: describeValue(value),
      message: `must be one of the listed values.`,
    });
  }

  if (schema.type !== undefined && !matchesType(value, schema.type)) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    issues.push({
      path: pointer,
      expected: types.join(" | "),
      actual: describeValue(value),
      message: `must be of type ${types.join(" | ")}.`,
    });
    // Type mismatch makes every other check noise; stop descending here.
    return;
  }

  // Combinators. These are evaluated before the type-specific rules so that a `oneOf`
  // discriminated union reports the union failure rather than a misleading inner one.
  if (schema.allOf) {
    for (const [index, branch] of schema.allOf.entries()) {
      validateNode(value, branch, pointer, issues, root);
      void index;
    }
  }

  if (schema.anyOf) {
    if (!schema.anyOf.some((branch) => isValidAgainstSchema(value, branch))) {
      issues.push({
        path: pointer,
        expected: `any of ${schema.anyOf.length} alternatives`,
        actual: describeValue(value),
        message: "matched none of the permitted shapes.",
      });
    }
  }

  if (schema.oneOf) {
    const matches = schema.oneOf.filter((branch) => isValidAgainstSchema(value, branch));
    if (matches.length === 0) {
      issues.push({
        path: pointer,
        expected: `exactly one of ${schema.oneOf.length} alternatives`,
        actual: describeValue(value),
        message: "matched none of the permitted shapes.",
      });
    } else if (matches.length > 1) {
      issues.push({
        path: pointer,
        expected: "exactly one matching alternative",
        actual: `${matches.length} alternatives matched`,
        message: "is ambiguous — the permitted shapes overlap.",
      });
    }
  }

  if (schema.not !== undefined && isValidAgainstSchema(value, schema.not)) {
    issues.push({
      path: pointer,
      expected: "a value that does not match the forbidden shape",
      actual: describeValue(value),
      message: "matched a shape the schema explicitly forbids.",
    });
  }

  if (typeof value === "string") validateString(value, schema, pointer, issues);
  if (typeof value === "number") validateNumber(value, schema, pointer, issues);
  if (Array.isArray(value)) validateArray(value, schema, pointer, issues, root);
  if (isPlainObject(value)) validateObject(value, schema, pointer, issues, root);
}

function validateString(
  value: string,
  schema: JsonSchema,
  pointer: string,
  issues: ValidationIssue[],
): void {
  // Length is measured in code points, not UTF-16 units. A maxLength of 10 should mean
  // ten characters, and emoji-heavy creative text would otherwise be wrongly rejected.
  const length = [...value].length;

  if (schema.minLength !== undefined && length < schema.minLength) {
    issues.push({
      path: pointer,
      expected: `at least ${schema.minLength} characters`,
      actual: `${length} characters`,
      message: `is too short (minimum ${schema.minLength}).`,
    });
  }
  if (schema.maxLength !== undefined && length > schema.maxLength) {
    issues.push({
      path: pointer,
      expected: `at most ${schema.maxLength} characters`,
      actual: `${length} characters`,
      message: `is too long (maximum ${schema.maxLength}).`,
    });
  }
  if (schema.pattern !== undefined && typeof schema.pattern === "string") {
    if (!new RegExp(schema.pattern).test(value)) {
      issues.push({
        path: pointer,
        expected: `a string matching /${schema.pattern}/`,
        actual: describeValue(value),
        message: `does not match the required pattern /${schema.pattern}/.`,
      });
    }
  }
  if (schema.format === "date-time" && !isIsoDateTime(value)) {
    issues.push({
      path: pointer,
      expected: "an RFC 3339 date-time string",
      actual: describeValue(value),
      message: "is not a valid ISO-8601 date-time (e.g. \"2026-10-24T09:30:00.000Z\").",
    });
  }
}

function validateNumber(
  value: number,
  schema: JsonSchema,
  pointer: string,
  issues: ValidationIssue[],
): void {
  if (!Number.isFinite(value)) {
    issues.push({
      path: pointer,
      expected: "a finite number",
      actual: String(value),
      message: "must be finite; NaN and Infinity are not valid JSON numbers.",
    });
    return;
  }
  if (schema.minimum !== undefined && value < schema.minimum) {
    issues.push({
      path: pointer,
      expected: `>= ${schema.minimum}`,
      actual: String(value),
      message: `must be at least ${schema.minimum}.`,
    });
  }
  if (schema.maximum !== undefined && value > schema.maximum) {
    issues.push({
      path: pointer,
      expected: `<= ${schema.maximum}`,
      actual: String(value),
      message: `must be at most ${schema.maximum}.`,
    });
  }
  if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
    issues.push({
      path: pointer,
      expected: `> ${schema.exclusiveMinimum}`,
      actual: String(value),
      message: `must be greater than ${schema.exclusiveMinimum}.`,
    });
  }
  if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) {
    issues.push({
      path: pointer,
      expected: `< ${schema.exclusiveMaximum}`,
      actual: String(value),
      message: `must be less than ${schema.exclusiveMaximum}.`,
    });
  }
  if (schema.multipleOf !== undefined && schema.multipleOf > 0) {
    const ratio = value / schema.multipleOf;
    if (Math.abs(ratio - Math.round(ratio)) > 1e-9) {
      issues.push({
        path: pointer,
        expected: `a multiple of ${schema.multipleOf}`,
        actual: String(value),
        message: `must be a multiple of ${schema.multipleOf}.`,
      });
    }
  }
}

function validateArray(
  value: readonly unknown[],
  schema: JsonSchema,
  pointer: string,
  issues: ValidationIssue[],
  root: JsonSchema,
): void {
  if (schema.minItems !== undefined && value.length < schema.minItems) {
    issues.push({
      path: pointer,
      expected: `at least ${schema.minItems} items`,
      actual: `${value.length} items`,
      message: `has too few items (minimum ${schema.minItems}).`,
    });
  }
  if (schema.maxItems !== undefined && value.length > schema.maxItems) {
    issues.push({
      path: pointer,
      expected: `at most ${schema.maxItems} items`,
      actual: `${value.length} items`,
      message: `has too many items (maximum ${schema.maxItems}).`,
    });
  }
  if (schema.uniqueItems === true) {
    for (let i = 0; i < value.length; i += 1) {
      for (let j = i + 1; j < value.length; j += 1) {
        if (deepEqual(value[i], value[j])) {
          issues.push({
            path: appendPointer(pointer, String(j)),
            expected: "a value not already present",
            actual: describeValue(value[j]),
            message: `duplicates the item at index ${i}; the schema requires unique items.`,
          });
        }
      }
    }
  }
  if (schema.items !== undefined) {
    value.forEach((item, index) => {
      validateNode(item, schema.items as JsonSchema, appendPointer(pointer, String(index)), issues, root);
    });
  }
}

function validateObject(
  value: Record<string, unknown>,
  schema: JsonSchema,
  pointer: string,
  issues: ValidationIssue[],
  root: JsonSchema,
): void {
  for (const name of schema.required ?? []) {
    if (!Object.prototype.hasOwnProperty.call(value, name) || value[name] === undefined) {
      issues.push({
        path: pointer,
        expected: `a property "${name}"`,
        actual: Object.prototype.hasOwnProperty.call(value, name)
          ? `"${name}" was present but undefined`
          : "property absent",
        message: `is missing required property "${name}".`,
      });
    }
  }

  const declared = schema.properties ?? {};

  for (const [name, childSchema] of Object.entries(declared)) {
    if (!Object.prototype.hasOwnProperty.call(value, name)) continue;
    const child = value[name];
    // An optional property explicitly set to undefined is treated as absent. This keeps
    // `exactOptionalPropertyTypes` semantics consistent between TypeScript and the schema.
    if (child === undefined) continue;
    validateNode(child, childSchema, appendPointer(pointer, name), issues, root);
  }

  for (const name of Object.keys(value)) {
    if (Object.prototype.hasOwnProperty.call(declared, name)) continue;
    const additional = schema.additionalProperties;
    if (additional === false) {
      issues.push({
        path: appendPointer(pointer, name),
        expected: "no such property",
        actual: describeValue(value[name]),
        message:
          `is an unknown property "${name}". ` +
          `Allowed: ${Object.keys(declared).join(", ") || "(none)"}.`,
      });
    } else if (typeof additional === "object" && additional !== null) {
      validateNode(value[name], additional, appendPointer(pointer, name), issues, root);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function matchesType(
  value: unknown,
  type: JsonSchemaTypeName | readonly JsonSchemaTypeName[],
): boolean {
  const types = Array.isArray(type) ? type : [type];
  return types.some((t) => {
    switch (t) {
      case "object":
        return isPlainObject(value);
      case "array":
        return Array.isArray(value);
      case "string":
        return typeof value === "string";
      case "number":
        return typeof value === "number" && Number.isFinite(value);
      case "integer":
        return typeof value === "number" && Number.isInteger(value);
      case "boolean":
        return typeof value === "boolean";
      case "null":
        return value === null;
      default:
        return false;
    }
  });
}

/**
 * Arrays and `null` are excluded from "object", matching JSON Schema.
 *
 * Note that class instances *are* accepted: the planner hands real `Task` objects
 * around, and rejecting them for having a prototype would be surprising rather than
 * safe.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Structural equality over JSON values.
 *
 * Key order is not significant. `NaN` never equals itself, which is the correct and
 * safe answer here.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const aKeys = Object.keys(a as object).sort();
    const bKeys = Object.keys(b as object).sort();
    if (aKeys.length !== bKeys.length) return false;
    if (!aKeys.every((key, index) => key === bKeys[index])) return false;
    return aKeys.every((key) =>
      deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    );
  }
  return false;
}

const ISO_DATE_TIME =
  /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

function isIsoDateTime(value: string): boolean {
  return ISO_DATE_TIME.test(value) && !Number.isNaN(Date.parse(value));
}