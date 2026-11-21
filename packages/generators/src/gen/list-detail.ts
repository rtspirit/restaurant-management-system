// `list_detail`: a list with a detail view, from the ListDetail pattern and the SDK hooks.
// With `form: true` (and write access) also add, change and remove, with FormLayout.
import type { RunGeneratorInput, SandboxCatalog } from "@rms/contracts";
import { ToolRefusal, jsx, lit, withArticle } from "../app-files.js";
import { type Field, findModel, formFields, pickFields, titleField } from "./fields.js";
import { formComponent, formUiNames } from "./form-code.js";
import type { Generated } from "./types.js";

type Input = Extract<RunGeneratorInput, { generator: "list_detail" }>;

const sortImports = (names: Iterable<string>): string => [...new Set(names)].sort((a, b) => a.localeCompare(b)).join(", ");

export const listDetail = (input: Input, catalog: SandboxCatalog, component: string): Generated => {
  const model = findModel(catalog, input.model);
  const fields = pickFields(model, input.fields, 8);
  if (fields.length === 0) throw new ToolRefusal(`${model.ref} has no fields this mini-app can show.`);
  const withForm = input.form === true;
  if (withForm && model.access !== "write") {
    throw new ToolRefusal(`This mini-app may only read ${model.ref}, so it cannot have a form to add or change them. Run it without the form, or say that the owner needs to allow changes.`);
  }

  const noun = model.name.toLowerCase();
  const title = titleField(fields) as Field;
  const rest = fields.filter((f) => f !== title);
  const subtitle = rest.find((f) => ["text", "enum", "ref", "parent_ref", "date", "business_date"].includes(f.type));
  const meta = rest.find((f) => f.type === "money");
  const readsMoney = fields.some((f) => f.type === "money");
  const notes: string[] = [];

  const form = withForm ? formFields(model, fields, catalog) : null;
  if (form) notes.push(...form.skipped);

  const sdk = new Set(["showValue", "useQuery", "useRms"]);
  const ui = new Set(["Card", "DetailList", "EmptyState", "ListDetail", "Page", "Skeleton", "Stack"]);
  const local = new Set(["Problem"]);
  if (form) {
    for (const n of ["fromInput", "toInput", "useMutation"]) sdk.add(n);
    for (const n of [...formUiNames(form.form), "Button", "Dialog", "Row"]) ui.add(n);
  }
  if (!withForm && readsMoney) local.add("NoNumbers");

  const item = [
    `id: String(row.id)`,
    `title: showValue(row, ${lit(title.key)}, ${lit(title.type)}, rms) || "Untitled"`,
    ...(subtitle ? [`subtitle: showValue(row, ${lit(subtitle.key)}, ${lit(subtitle.type)}, rms)`] : []),
    ...(meta ? [`meta: showValue(row, ${lit(meta.key)}, ${lit(meta.type)}, rms)`] : []),
  ];
  const sort = title.type === "text" ? `, sort: [{ field: ${lit(title.key)}, dir: "asc" }]` : "";
  const add = lit(`Add ${withArticle(noun)}`);

  const empty = withForm
    ? [
        `          empty={`,
        `            <EmptyState title=${jsx(`No ${input.title.toLowerCase()} yet`)} action={<Button icon="plus" onClick={() => setEditing("new")}>{${add}}</Button>}>`,
        "              Add the first one and it shows here.",
        "            </EmptyState>",
        "          }",
      ]
    : readsMoney
      ? [`          empty={<NoNumbers what=${jsx(input.title.toLowerCase())} />}`]
      : [`          empty={<EmptyState title=${jsx(`No ${input.title.toLowerCase()} yet`)}>They show here once they are added.</EmptyState>}`];

  const lines: string[] = [
    `// Made by \`rms gen list_detail\` for ${model.ref}. Editable: change anything in this file.`,
    `import { ${sortImports([...sdk])} } from "@rms/sdk";`,
    `import { ${sortImports(ui)} } from "@rms/ui";`,
    `import { useState } from "react";`,
    `import { ${sortImports(local)} } from "../../rms/notices";`,
    "",
    `const MODEL = ${lit(model.ref)};`,
    `const FIELDS = [${fields.map((f) => `{ key: ${lit(f.key)}, label: ${lit(f.label)}, type: ${lit(f.type)} }`).join(", ")}] as const;`,
    "",
    `export function ${component}() {`,
    "  const rms = useRms();",
    `  const list = useQuery({ model: MODEL${sort}, limit: 500 });`,
    '  const [selectedId, setSelectedId] = useState("");',
    ...(withForm ? ['  const [editing, setEditing] = useState<Record<string, unknown> | "new" | null>(null);'] : []),
    "  const selected = list.rows.find((row) => String(row.id) === selectedId);",
    "",
    ...(withForm
      ? [
          "  if (editing !== null) {",
          "    return (",
          `      <Page title=${jsx(input.title)} narrow>`,
          "        <EditForm",
          '          row={editing === "new" ? null : editing}',
          "          onDone={(id) => {",
          "            setEditing(null);",
          "            if (id) setSelectedId(id);",
          "          }}",
          "        />",
          "      </Page>",
          "    );",
          "  }",
          "",
        ]
      : []),
    "  return (",
    `    <Page title=${jsx(input.title)}${withForm ? ` actions={<Button icon="plus" onClick={() => setEditing("new")}>{${add}}</Button>}` : ""}>`,
    '      <Stack gap="m">',
    "        <Problem error={list.error} />",
    "        {list.loading && list.data === null ? (",
    `          <Skeleton shape="block" label=${jsx(`Loading ${input.title.toLowerCase()}`)} />`,
    "        ) : (",
    "          <ListDetail",
    `            label=${jsx(input.title)}`,
    `            items={list.rows.map((row) => ({ ${item.join(", ")} }))}`,
    "            selectedId={selectedId}",
    "            onSelect={setSelectedId}",
    '            onBack={() => setSelectedId("")}',
    "            detail={",
    "              selected ? (",
    `                <Detail row={selected}${withForm ? ' onEdit={() => setEditing(selected)} onRemoved={() => setSelectedId("")}' : ""} />`,
    "              ) : (",
    `                <EmptyState title=${jsx(`Pick ${withArticle(noun)}`)}>Choose one from the list to see everything about it.</EmptyState>`,
    "              )",
    "            }",
    ...empty.map((l) => `  ${l}`),
    "          />",
    "        )}",
    "      </Stack>",
    "    </Page>",
    "  );",
    "}",
    "",
    ...(withForm
      ? ["type DetailProps = { row: Record<string, unknown>; onEdit: () => void; onRemoved: () => void };", "", "function Detail({ row, onEdit, onRemoved }: DetailProps) {"]
      : ["function Detail({ row }: { row: Record<string, unknown> }) {"]),
    "  const rms = useRms();",
    ...(withForm ? ["  const save = useMutation();", "  const [confirming, setConfirming] = useState(false);"] : []),
    "  return (",
    `    <Card title={showValue(row, ${lit(title.key)}, ${lit(title.type)}, rms) || "Untitled"}${withForm ? ' action={<Button variant="secondary" onClick={onEdit}>Change</Button>}' : ""}>`,
    '      <Stack gap="m">',
    '        <DetailList rows={FIELDS.map((f) => ({ label: f.label, value: showValue(row, f.key, f.type, rms) || "Not set" }))} />',
    ...(withForm
      ? [
          "        <Problem error={save.error} />",
          "        <Row>",
          '          <Button variant="quiet" onClick={() => setConfirming(true)}>',
          `            {${lit(`Remove this ${noun}`)}}`,
          "          </Button>",
          "        </Row>",
          "        <Dialog",
          "          open={confirming}",
          "          onClose={() => setConfirming(false)}",
          `          title=${jsx(`Remove this ${noun}?`)}`,
          "          actions={",
          "            <>",
          '              <Button variant="secondary" onClick={() => setConfirming(false)}>',
          "                Keep it",
          "              </Button>",
          "              <Button",
          "                busy={save.busy}",
          "                onClick={() => {",
          "                  setConfirming(false);",
          "                  save.remove(MODEL, String(row.id)).then(onRemoved, () => undefined);",
          "                }}",
          "              >",
          "                Remove",
          "              </Button>",
          "            </>",
          "          }",
          "        >",
          "          It goes from the list for good. You can add it again later.",
          "        </Dialog>",
        ]
      : []),
    "      </Stack>",
    "    </Card>",
    "  );",
    "}",
    ...(form ? ["", ...formComponent({ name: "EditForm", noun, fields: form.form })] : []),
    "",
  ];

  if (withForm) notes.push(`The list, the detail and the form for ${noun} are on the screen. Change labels or the order of fields in this file if the owner asks.`);
  else notes.push(`The list and the detail for ${noun} are on the screen. It only reads: run it with "form": true to add and change them.`);
  return { code: lines.join("\n"), notes };
};
