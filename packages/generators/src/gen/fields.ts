// Which fields a generated screen shows, and the code for each one, by the field-type table in
// @rms/contracts data-api.ts. Every name and label goes into code through `lit` (JSON text).
import { type ModelCatalogEntry, SYSTEM_FIELDS, type SandboxCatalog } from "@rms/contracts";
import { ToolRefusal, jsx, lit } from "../app-files.js";

export type Field = ModelCatalogEntry["fields"][number];

const SYSTEM = new Set<string>(SYSTEM_FIELDS);

/** The owner's own fields of a model: no system fields. */
export const ownFields = (model: ModelCatalogEntry): Field[] => model.fields.filter((f) => !SYSTEM.has(f.key) && f.type !== "id");

/** The fields asked for, or the model's own fields. Refuses a field the model does not have. */
export const pickFields = (model: ModelCatalogEntry, wanted: readonly string[] | undefined, max: number): Field[] => {
  const own = ownFields(model);
  if (wanted === undefined) return own.slice(0, max);
  return wanted.map((key) => {
    const field = own.find((f) => f.key === key);
    if (!field) throw new ToolRefusal(`${model.ref} has no field "${key}" this mini-app can use. Its fields are: ${own.map((f) => f.key).join(", ")}.`);
    return field;
  });
};

export const findModel = (catalog: SandboxCatalog, ref: string): ModelCatalogEntry => {
  const model = catalog.models.find((m) => m.ref === ref);
  if (!model) {
    const known = catalog.models.map((m) => m.ref).join(", ") || "none";
    throw new ToolRefusal(`"${ref}" is not in this mini-app's catalog. The models it can use are: ${known}. If it needs another, say so: the owner changes the plan.`);
  }
  return model;
};

/** The field that names a row: the first text field, else the first field. */
export const titleField = (fields: Field[]): Field | undefined => fields.find((f) => f.type === "text") ?? fields[0];

/** "default_account" as "defaultAccount", for variable names. Keys are already `Ident`. */
export const camel = (key: string): string => {
  // Keys come from the catalog file. Only a plain key may ever become part of a variable name.
  if (!/^[a-z][a-z0-9_]{0,47}$/.test(key)) throw new ToolRefusal(`"${key.slice(0, 60)}" is not a usable name.`);
  return key.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
};

// ------------------------------------------------------------------ forms

export type FormField = Field & { options?: { kind: "locations" } | { kind: "model"; ref: string; labelKey: string | null } };

const TEXT_LIKE = new Set(["text", "integer", "decimal", "money", "date", "business_date"]);

/**
 * The fields a form can fill in, and the ones it leaves out with the reason. A ref is offered
 * only when the mini-app can read the model it points at. The location comes first for a model
 * kept per location.
 */
export const formFields = (model: ModelCatalogEntry, fields: Field[], catalog: SandboxCatalog): { form: FormField[]; skipped: string[] } => {
  const form: FormField[] = [];
  const skipped: string[] = [];
  if (model.fields.some((f) => f.key === "location_id")) form.push({ key: "location_id", label: "Location", type: "ref", required: true, refersTo: "parent.locations", options: { kind: "locations" } });
  for (const f of fields) {
    if (TEXT_LIKE.has(f.type) || f.type === "boolean" || (f.type === "enum" && f.values && f.values.length > 0)) form.push(f);
    else if ((f.type === "ref" || f.type === "parent_ref") && f.refersTo === "parent.locations") form.push({ ...f, options: { kind: "locations" } });
    else if ((f.type === "ref" || f.type === "parent_ref") && f.refersTo) {
      const target = catalog.models.find((m) => m.ref === f.refersTo);
      if (target) form.push({ ...f, options: { kind: "model", ref: target.ref, labelKey: titleField(ownFields(target))?.key ?? null } });
      else skipped.push(`"${f.label}" is not on the form: this mini-app cannot read ${f.refersTo}, which it points at.`);
    } else skipped.push(`"${f.label}" is not on the form: a ${f.type} field needs a screen of its own.`);
  }
  return { form, skipped };
};

/** What a new row's form starts with. */
export const startValue = (f: FormField): string => {
  if (f.options?.kind === "locations") return 'rms.locations[0]?.id ?? ""';
  if (f.type === "boolean") return lit(f.required ? "true" : "false");
  if (f.type === "enum" && f.required && f.values?.[0]) return lit(f.values[0]);
  return '""';
};

/** The hooks a form needs for its pick lists. */
export const optionHooks = (fields: FormField[], indent: string): string[] =>
  fields.flatMap((f) =>
    f.options?.kind === "model"
      ? [`${indent}const ${camel(f.key)}Rows = useQuery({ model: ${lit(f.options.ref)}, limit: 500 }).rows;`]
      : [],
  );

/** One field of a form as JSX. `draft`, `errors`, `set` and `rms` are in scope. */
export const fieldInput = (f: FormField, indent: string): string => {
  const k = lit(f.key);
  const label = jsx(f.label);
  const value = `draft[${k}] ?? ""`;
  const onChange = `(event) => set(${k}, event.target.value)`;
  const error = `errors[${k}] ?? ""`;
  if (f.options?.kind === "locations") {
    return `${indent}<Select label=${label} block options={rms.locations.map((l) => ({ value: l.id, label: l.name }))} value={${value}} onChange={${onChange}} hint={${error}} />`;
  }
  if (f.options?.kind === "model") {
    const labelOf = f.options.labelKey ? `showValue(row, ${lit(f.options.labelKey)}, "text", rms) || "Untitled"` : `String(row.id)`;
    return `${indent}<Select label=${label} block options={[{ value: "", label: "Choose one" }, ...${camel(f.key)}Rows.map((row) => ({ value: String(row.id), label: ${labelOf} }))]} value={${value}} onChange={${onChange}} hint={${error}} />`;
  }
  switch (f.type) {
    case "enum":
      return `${indent}<Select label=${label} block options={[${f.required ? "" : '{ value: "", label: "Not set" }, '}${(f.values ?? []).map((v) => `{ value: ${lit(v)}, label: ${lit(humanize(v))} }`).join(", ")}]} value={${value}} onChange={${onChange}} hint={${error}} />`;
    case "boolean":
      return `${indent}<Choice type="checkbox" label=${label} checked={draft[${k}] === "true"} onChange={(event) => set(${k}, event.target.checked ? "true" : "false")} />`;
    case "money":
      return `${indent}<TextField label=${label} money value={${value}} onChange={${onChange}} error={${error}} />`;
    case "integer":
      return `${indent}<TextField label=${label} inputMode="numeric" value={${value}} onChange={${onChange}} error={${error}} />`;
    case "decimal":
      return `${indent}<TextField label=${label} inputMode="decimal" value={${value}} onChange={${onChange}} error={${error}} />`;
    case "date":
    case "business_date":
      return `${indent}<TextField label=${label} type="date" value={${value}} onChange={${onChange}} error={${error}} />`;
    default:
      return `${indent}<TextField label=${label} value={${value}} onChange={${onChange}} error={${error}} />`;
  }
};

export const humanize = (value: string): string => {
  const words = value.replace(/[_-]+/g, " ").trim();
  return words.length === 0 ? "" : words[0]!.toUpperCase() + words.slice(1);
};

/** The submit handler's field list: key, type, required. */
export const fieldSpecs = (fields: FormField[]): string =>
  `[${fields.map((f) => `{ key: ${lit(f.key)}, type: ${lit(f.type)}, required: ${f.required ? "true" : "false"} }`).join(", ")}]`;
