// `form`: one form that adds a row. After saving it says so and starts again empty.
import type { RunGeneratorInput, SandboxCatalog } from "@rms/contracts";
import { ToolRefusal, jsx, lit } from "../app-files.js";
import { findModel, formFields, pickFields } from "./fields.js";
import { formComponent, formUiNames } from "./form-code.js";
import type { Generated } from "./types.js";

type Input = Extract<RunGeneratorInput, { generator: "form" }>;

export const form = (input: Input, catalog: SandboxCatalog, component: string): Generated => {
  const model = findModel(catalog, input.model);
  if (model.access !== "write") throw new ToolRefusal(`This mini-app may only read ${model.ref}, so it cannot add them. Say that the owner needs to allow changes.`);
  const { form: fields, skipped } = formFields(model, pickFields(model, input.fields, 20), catalog);
  if (fields.length === 0) throw new ToolRefusal(`${model.ref} has no fields a form can fill in.`);
  const noun = model.name.toLowerCase();
  const ui = [...new Set([...formUiNames(fields), "Notice", "Page", "Stack"])].sort((a, b) => a.localeCompare(b)).join(", ");
  const sdk = ["fromInput", "toInput", "useMutation", "useRms", ...(fields.some((f) => f.options?.kind === "model") ? ["showValue", "useQuery"] : [])];

  const lines = [
    `// Made by \`rms gen form\` for ${model.ref}. Editable: change anything in this file.`,
    `import { ${[...new Set(sdk)].sort((a, b) => a.localeCompare(b)).join(", ")} } from "@rms/sdk";`,
    `import { ${ui} } from "@rms/ui";`,
    'import { useState } from "react";',
    'import { Problem } from "../../rms/notices";',
    "",
    `const MODEL = ${lit(model.ref)};`,
    "",
    `export function ${component}() {`,
    "  const [saved, setSaved] = useState(0);",
    "  const [round, setRound] = useState(0);",
    "  return (",
    `    <Page title=${jsx(input.title)} narrow>`,
    '      <Stack gap="m">',
    `        {saved > 0 ? <Notice kind="status">{${lit(`Saved. You can add another ${noun} now.`)}}</Notice> : null}`,
    "        <AddForm",
    "          key={round}",
    "          row={null}",
    "          onDone={(id) => {",
    "            if (id) setSaved((n) => n + 1);",
    "            setRound((n) => n + 1);",
    "          }}",
    "        />",
    "      </Stack>",
    "    </Page>",
    "  );",
    "}",
    "",
    ...formComponent({ name: "AddForm", noun, fields }),
    "",
  ];
  return { code: lines.join("\n"), notes: [...skipped, `The form adds ${noun} records.`] };
};
