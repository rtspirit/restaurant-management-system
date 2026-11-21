// The add-and-change form as code, used by `list_detail` (with `form: true`) and by `form`.
import { lit, withArticle } from "../app-files.js";
import { type FormField, fieldInput, fieldSpecs, optionHooks, startValue } from "./fields.js";

export type FormCode = { name: string; noun: string; fields: FormField[] };

/** `MODEL` (the model key), `Problem` and the SDK and UI names it uses are imported by the caller. */
export const formComponent = ({ name, noun, fields }: FormCode): string[] => [
  `const FORM_FIELDS = ${fieldSpecs(fields)} as const;`,
  "",
  "// `masked`: fields this user may not see (the Data API leaves them out). They are left off the form and never sent.",
  "type FormProps = { row: Record<string, unknown> | null; masked: readonly string[]; onDone: (id?: string) => void };",
  "",
  `function ${name}({ row, masked, onDone }: FormProps) {`,
  "  const rms = useRms();",
  "  const save = useMutation();",
  ...optionHooks(fields, "  "),
  "  const [draft, setDraft] = useState<Record<string, string>>(() =>",
  "    row === null",
  `      ? { ${fields.map((f) => `${lit(f.key)}: ${startValue(f)}`).join(", ")} }`,
  "      : Object.fromEntries(FORM_FIELDS.filter((f) => !masked.includes(f.key)).map((f) => [f.key, toInput(row[f.key], f.type, rms)])),",
  "  );",
  "  const [errors, setErrors] = useState<Record<string, string>>({});",
  "  const set = (key: string, value: string) => setDraft((d) => ({ ...d, [key]: value }));",
  "",
  "  const submit = async () => {",
  "    const values: Record<string, unknown> = {};",
  "    const problems: Record<string, string> = {};",
  "    for (const f of FORM_FIELDS) {",
  "      if (masked.includes(f.key)) continue;",
  '      const read = fromInput(draft[f.key] ?? "", f.type, rms);',
  "      if (!read.ok) problems[f.key] = read.message;",
  '      else if (read.value === null && f.required) problems[f.key] = "Fill this in.";',
  "      else if (read.value !== null || row !== null) values[f.key] = read.value;",
  "    }",
  "    setErrors(problems);",
  "    if (Object.keys(problems).length > 0) return;",
  "    try {",
  "      const result = row === null ? await save.insert(MODEL, values) : await save.update(MODEL, String(row.id), values);",
  "      onDone(result.results[0]?.id);",
  "    } catch {",
  "      // The reason shows above the buttons, in RMS's own plain words.",
  "    }",
  "  };",
  "",
  "  return (",
  "    <FormLayout",
  `      title={row === null ? ${lit(`Add ${withArticle(noun)}`)} : ${lit(`Change this ${noun}`)}}`,
  "      onSubmit={() => void submit()}",
  "      message={<Problem error={save.error} />}",
  "      actions={",
  "        <>",
  '          <Button variant="secondary" type="button" onClick={() => onDone()}>',
  "            Cancel",
  "          </Button>",
  '          <Button type="submit" busy={save.busy}>',
  "            Save",
  "          </Button>",
  "        </>",
  "      }",
  "    >",
  ...fields.map((f) => `      {masked.includes(${lit(f.key)}) ? null : (\n${fieldInput(f, "        ")}\n      )}`),
  "    </FormLayout>",
  "  );",
  "}",
];

/** The UI names a form uses, for the import line. */
export const formUiNames = (fields: FormField[]): string[] => {
  const names = new Set(["Button", "FormLayout"]);
  for (const f of fields) {
    if (f.options || f.type === "enum") names.add("Select");
    else if (f.type === "boolean") names.add("Choice");
    else names.add("TextField");
  }
  return [...names];
};
