/**
 * The assertions the case builder offers. Each entry says how a form maps to a promptfoo assertion,
 * and back, so cases written by hand in YAML can be opened in the builder too.
 */
export type FieldKind = 'list' | 'text' | 'number' | 'bool';

export interface Field {
  key: string;
  label: string;
  kind: FieldKind;
  help?: string;
  placeholder?: string;
  required?: boolean;
  /** Bool fields: the value the assertion assumes when the key is absent. */
  default?: boolean;
  /** List fields: suggest the tool names found in the recording. */
  suggest?: 'tools';
}

export interface AssertionSpec {
  id: string;
  label: string;
  help: string;
  /** "javascript" assertions call a function in src/assertions.ts; anything else is a promptfoo built-in. */
  fn?: string;
  type?: string;
  fields: Field[];
}

export const ASSERTIONS_FILE = 'file://../../src/assertions.ts';

export const CATALOG: AssertionSpec[] = [
  {
    id: 'callsTool',
    label: 'Calls one of these tools',
    help: 'Passes when the next step includes a call to at least one of the listed tools.',
    fn: 'callsTool',
    fields: [{ key: 'names', label: 'Tools', kind: 'list', required: true, suggest: 'tools' }],
  },
  {
    id: 'avoidsTool',
    label: 'Does not call these tools',
    help: 'Fails when the next step calls any of the listed tools, for example finishing too early.',
    fn: 'avoidsTool',
    fields: [{ key: 'names', label: 'Tools', kind: 'list', required: true, suggest: 'tools' }],
  },
  {
    id: 'validToolArguments',
    label: 'Tool arguments are valid JSON',
    help: 'Fails when a tool call carries arguments that cannot be parsed.',
    fn: 'validToolArguments',
    fields: [],
  },
  {
    id: 'delegatedRefsPreserved',
    label: 'Delegation uses only listed refs',
    help: 'Refs such as F3 or P2 in delegate_task goals must come from the work list the tool returned.',
    fn: 'delegatedRefsPreserved',
    fields: [
      { key: 'listedIn', label: 'Work list comes from a tool result containing', kind: 'text', placeholder: 'source="mcp__server__digest_begin"', help: 'Limits the refs that count as listed to tool results containing this text.' },
      { key: 'refPattern', label: 'Ref pattern (regex)', kind: 'text', placeholder: '\\b[PFTY]\\d+\\b' },
      { key: 'ordered', label: 'Keep the work list order', kind: 'bool', default: true },
      { key: 'unique', label: 'A ref appears in one goal only', kind: 'bool', default: true },
    ],
  },
  {
    id: 'noTemplateMarkers',
    label: 'No placeholders in goals',
    help: 'Fails when a subagent goal still contains something like <the ref> or {chat id}.',
    fn: 'noTemplateMarkers',
    fields: [],
  },
  {
    id: 'noRepeatedItems',
    label: 'Does not repeat earlier items',
    help: 'Values of one argument must not repeat what earlier calls to the same tool already sent.',
    fn: 'noRepeatedItems',
    fields: [
      { key: 'name', label: 'Tool', kind: 'text', required: true, placeholder: 'add_items' },
      { key: 'key', label: 'Argument', kind: 'text', required: true, placeholder: 'uris' },
    ],
  },
  {
    id: 'startsWith',
    label: 'Reply starts with',
    help: 'The reply text must start with this pattern.',
    fn: 'startsWith',
    fields: [
      { key: 'pattern', label: 'Pattern (regex)', kind: 'text', required: true },
      { key: 'flags', label: 'Flags', kind: 'text', placeholder: 'i' },
    ],
  },
  {
    id: 'maxLength',
    label: 'Reply length at most',
    help: 'Caps the length of the reply text.',
    fn: 'maxLength',
    fields: [{ key: 'max', label: 'Characters', kind: 'number', required: true }],
  },
  {
    id: 'icontains',
    label: 'Output contains text',
    help: 'Case-insensitive match against the whole output, tool call arguments included.',
    type: 'icontains',
    fields: [{ key: 'value', label: 'Text', kind: 'text', required: true }],
  },
  {
    id: 'not-icontains',
    label: 'Output does not contain text',
    help: 'Case-insensitive; fails when the text appears anywhere in the output.',
    type: 'not-icontains',
    fields: [{ key: 'value', label: 'Text', kind: 'text', required: true }],
  },
];

export type Values = Record<string, unknown>;
export interface Assertion {
  type: string;
  value?: unknown;
  config?: Record<string, unknown>;
}

const specById = (id: string) => CATALOG.find((s) => s.id === id);

const empty = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

/** Form values to a promptfoo assertion. Throws a readable message when a required field is missing. */
export function buildAssertion(id: string, values: Values): Assertion {
  const spec = specById(id);
  if (!spec) throw new Error(`unknown assertion "${id}"`);
  for (const f of spec.fields) if (f.required && empty(values[f.key])) throw new Error(`${spec.label}: "${f.label}" is required`);
  if (spec.type) return { type: spec.type, value: values.value };
  const config: Record<string, unknown> = {};
  for (const f of spec.fields) {
    const v = values[f.key];
    if (empty(v)) continue;
    if (f.kind === 'bool') {
      if (v !== (f.default ?? false)) config[f.key] = v;
    } else if (f.kind === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n)) throw new Error(`${spec.label}: "${f.label}" must be a number`);
      config[f.key] = n;
    } else if (f.kind === 'list') {
      config[f.key] = (Array.isArray(v) ? v : String(v).split(',')).map((x) => String(x).trim()).filter(Boolean);
    } else {
      config[f.key] = String(v);
    }
  }
  return { type: 'javascript', value: `${ASSERTIONS_FILE}:${spec.fn}`, ...(Object.keys(config).length ? { config } : {}) };
}

/** A promptfoo assertion back to its catalog entry and form values, or undefined for assertions the builder does not know. */
export function parseAssertion(a: Assertion): { id: string; values: Values } | undefined {
  if (a.type === 'javascript' && typeof a.value === 'string') {
    const fn = a.value.split(':').pop();
    const spec = CATALOG.find((s) => s.fn === fn);
    if (!spec) return undefined;
    const values: Values = {};
    for (const f of spec.fields) values[f.key] = a.config?.[f.key] ?? (f.kind === 'bool' ? (f.default ?? false) : undefined);
    return { id: spec.id, values };
  }
  const spec = CATALOG.find((s) => s.type === a.type);
  return spec ? { id: spec.id, values: { value: a.value } } : undefined;
}
