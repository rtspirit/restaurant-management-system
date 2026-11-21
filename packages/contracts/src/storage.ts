import type { FieldDef } from "./models.js";

/**
 * The storage contract: how a model definition maps to a table. ONE place, used by the model
 * compiler (which creates the columns) and the Data API (which reads and writes them).
 *
 * - Table name = model key. Schema = the restaurant's live or draft schema.
 * - One column per field, named by the field key, except:
 *     quantity   -> `<key>` numeric(18,6) + `<key>_unit` text
 *     parent_ref -> `<key>` uuid          + `<key>_label` text (snapshot, set by the server)
 * - System columns are added by the compiler (see SYSTEM_COLUMNS).
 */

export type ColumnSpec = { name: string; sqlType: string; nullable: boolean };

export const columnsForField = (f: FieldDef): ColumnSpec[] => {
  const nullable = !f.required;
  switch (f.type) {
    case "text":
      return [{ name: f.key, sqlType: "text", nullable }];
    case "integer":
      return [{ name: f.key, sqlType: "bigint", nullable }];
    case "decimal":
      return [{ name: f.key, sqlType: `numeric(18,${f.scale})`, nullable }];
    case "boolean":
      return [{ name: f.key, sqlType: "boolean", nullable }];
    case "money":
      return [{ name: f.key, sqlType: "bigint", nullable }];
    case "quantity":
      return [
        { name: f.key, sqlType: "numeric(18,6)", nullable },
        { name: `${f.key}_unit`, sqlType: "text", nullable },
      ];
    case "date":
    case "business_date":
      return [{ name: f.key, sqlType: "date", nullable }];
    case "timestamp":
      return [{ name: f.key, sqlType: "timestamptz", nullable }];
    case "enum":
      return [{ name: f.key, sqlType: "text", nullable }];
    case "ref":
      return [{ name: f.key, sqlType: "uuid", nullable }];
    case "parent_ref":
      return [
        { name: f.key, sqlType: "uuid", nullable },
        { name: `${f.key}_label`, sqlType: "text", nullable: true },
      ];
    case "json":
      return [{ name: f.key, sqlType: "jsonb", nullable }];
  }
};

/**
 * System columns, in table order. `when` says which models get the column.
 * `updated_at` is truncated to milliseconds by the `rms.touch_updated_at()` trigger.
 */
export const SYSTEM_COLUMNS = [
  { name: "id", sqlType: "uuid", nullable: false, when: "always" },
  { name: "location_id", sqlType: "uuid", nullable: false, when: "locationScoped" },
  { name: "currency", sqlType: "char(3)", nullable: false, when: "hasMoney" },
  { name: "source", sqlType: "text", nullable: false, when: "always" },
  { name: "source_id", sqlType: "text", nullable: true, when: "always" },
  { name: "created_at", sqlType: "timestamptz", nullable: false, when: "always" },
  { name: "created_by", sqlType: "text", nullable: false, when: "always" },
  { name: "updated_at", sqlType: "timestamptz", nullable: false, when: "always" },
  { name: "updated_by", sqlType: "text", nullable: false, when: "always" },
  { name: "deleted_at", sqlType: "timestamptz", nullable: true, when: "softDelete" },
] as const;

/** Per-transaction settings the database reads. Set with set_config(name, value, true). */
export const SESSION_SETTINGS = {
  org: "rms.org",
  locations: "rms.locations",
  actor: "rms.actor",
} as const;

/** Row-level security on location-scoped tables calls this function with the row's location_id. */
export const LOCATION_POLICY_FN = "rms.location_ok";
