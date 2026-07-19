import { useState } from 'react';
import type { JsonSchema } from './types';

const LONG_TEXT_KEYS = new Set(['markdown', 'html', 'body', 'quote', 'subhead', 'about', 'legal', 'answer', 'text']);

/**
 * Auto-generated form for a component's props from its JSON Schema.
 * Commits field-by-field (blur / change); complex unions fall back to JSON.
 */
export function SchemaFields({
  schema,
  values,
  onCommit,
}: {
  schema: JsonSchema;
  values: Record<string, unknown>;
  onCommit: (patch: Record<string, unknown>) => void;
}) {
  const props = schema.properties ?? {};
  return (
    <div className="fields">
      {Object.entries(props).map(([key, sub]) => (
        <Field
          key={key}
          name={key}
          schema={sub}
          value={values[key]}
          required={schema.required?.includes(key) ?? false}
          onCommit={(v) => onCommit({ [key]: v })}
        />
      ))}
    </div>
  );
}

function Field({
  name,
  schema,
  value,
  required,
  onCommit,
}: {
  name: string;
  schema: JsonSchema;
  value: unknown;
  required: boolean;
  onCommit: (value: unknown) => void;
}) {
  const label = (
    <span title={schema.description}>
      {name}
      {required ? ' *' : ''}
    </span>
  );

  if (schema.enum) {
    return (
      <label className="field">
        {label}
        <select
          value={String(value ?? schema.default ?? '')}
          data-testid={`prop-${name}`}
          onChange={(e) => onCommit(e.target.value)}
        >
          {!required && <option value="">—</option>}
          {schema.enum.map((o) => (
            <option key={String(o)} value={String(o)}>
              {String(o)}
            </option>
          ))}
        </select>
      </label>
    );
  }

  switch (schema.type) {
    case 'string':
      return (
        <StringField name={name} label={label} value={(value as string) ?? ''} onCommit={onCommit} />
      );
    case 'number':
    case 'integer':
      return (
        <label className="field">
          {label}
          <input
            type="number"
            defaultValue={value === undefined ? '' : String(value)}
            data-testid={`prop-${name}`}
            onBlur={(e) => {
              const v = e.target.value;
              onCommit(v === '' ? undefined : Number(v));
            }}
          />
        </label>
      );
    case 'boolean':
      return (
        <label className="check">
          <input
            type="checkbox"
            checked={Boolean(value ?? schema.default ?? false)}
            data-testid={`prop-${name}`}
            onChange={(e) => onCommit(e.target.checked)}
          />
          {label}
        </label>
      );
    case 'object':
      if (schema.properties) {
        const objValue = (value ?? {}) as Record<string, unknown>;
        const isEmpty = value === undefined;
        return (
          <fieldset className="obj-field">
            <legend>
              {label}
              {!required && (
                <button
                  type="button"
                  className="ghost"
                  onClick={() => onCommit(isEmpty ? {} : undefined)}
                  title={isEmpty ? 'Add' : 'Remove'}
                >
                  {isEmpty ? '＋' : '×'}
                </button>
              )}
            </legend>
            {!isEmpty &&
              Object.entries(schema.properties).map(([k, sub]) => (
                <Field
                  key={k}
                  name={k}
                  schema={sub}
                  value={objValue[k]}
                  required={schema.required?.includes(k) ?? false}
                  onCommit={(v) => onCommit({ ...objValue, [k]: v })}
                />
              ))}
          </fieldset>
        );
      }
      return <JsonFallback name={name} label={label} value={value} onCommit={onCommit} />;
    case 'array': {
      const items = (value ?? []) as unknown[];
      const itemSchema = schema.items;
      if (!itemSchema) return <JsonFallback name={name} label={label} value={value} onCommit={onCommit} />;
      return (
        <fieldset className="obj-field">
          <legend>
            {label} <span className="muted">({items.length})</span>
            <button
              type="button"
              className="ghost"
              title="Add item"
              onClick={() => onCommit([...items, emptyValue(itemSchema)])}
            >
              ＋
            </button>
          </legend>
          {items.map((item, i) => (
            <div className="array-item" key={i}>
              <div className="array-item-bar">
                <span className="muted">#{i + 1}</span>
                <button
                  type="button"
                  className="ghost danger"
                  title="Remove"
                  onClick={() => onCommit(items.filter((_, j) => j !== i))}
                >
                  ×
                </button>
              </div>
              <Field
                name={`${name}[${i}]`}
                schema={itemSchema}
                value={item}
                required
                onCommit={(v) => onCommit(items.map((old, j) => (j === i ? v : old)))}
              />
            </div>
          ))}
        </fieldset>
      );
    }
    default:
      return <JsonFallback name={name} label={label} value={value} onCommit={onCommit} />;
  }
}

function StringField({
  name,
  label,
  value,
  onCommit,
}: {
  name: string;
  label: React.ReactNode;
  value: string;
  onCommit: (v: unknown) => void;
}) {
  const [draft, setDraft] = useState(value);
  const long = LONG_TEXT_KEYS.has(name.replace(/\[\d+\]$/, '')) || value.length > 60;
  const commit = () => {
    if (draft !== value) onCommit(draft === '' ? undefined : draft);
  };
  return (
    <label className="field">
      {label}
      {long ? (
        <textarea
          rows={4}
          value={draft}
          data-testid={`prop-${name}`}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
        />
      ) : (
        <input
          value={draft}
          data-testid={`prop-${name}`}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
        />
      )}
    </label>
  );
}

function JsonFallback({
  name,
  label,
  value,
  onCommit,
}: {
  name: string;
  label: React.ReactNode;
  value: unknown;
  onCommit: (v: unknown) => void;
}) {
  const [draft, setDraft] = useState(JSON.stringify(value ?? null, null, 1) ?? 'null');
  const [invalid, setInvalid] = useState(false);
  return (
    <label className={`field ${invalid ? 'invalid' : ''}`}>
      {label} <span className="muted">(JSON)</span>
      <textarea
        rows={3}
        value={draft}
        data-testid={`prop-${name}`}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          try {
            const parsed = JSON.parse(draft) as unknown;
            setInvalid(false);
            onCommit(parsed === null ? undefined : parsed);
          } catch {
            setInvalid(true);
          }
        }}
      />
    </label>
  );
}

function emptyValue(schema: JsonSchema): unknown {
  if (schema.default !== undefined) return schema.default;
  if (schema.enum) return schema.enum[0];
  switch (schema.type) {
    case 'string':
      return '';
    case 'number':
    case 'integer':
      return 0;
    case 'boolean':
      return false;
    case 'array':
      return [];
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, sub] of Object.entries(schema.properties ?? {})) {
        if (schema.required?.includes(k)) out[k] = emptyValue(sub);
      }
      return out;
    }
    default:
      return null;
  }
}
