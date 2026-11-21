// `run_generator`: writes one working screen and adds it to the screen list. It writes only
// `src/screens/<screen>/index.tsx` and `src/screens/index.ts`, and refuses to write through a
// link that leads anywhere else.
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { APP_TEMPLATE, type RunGeneratorInput, type RunGeneratorOutput } from "@rms/contracts";
import { ToolRefusal, componentName, readCatalogFile } from "./app-files.js";
import { dashboard } from "./gen/dashboard.js";
import { form } from "./gen/form.js";
import { listDetail } from "./gen/list-detail.js";
import { reportTable } from "./gen/report-table.js";
import type { Generated } from "./gen/types.js";
import { upsertScreen } from "./screens-list.js";

const SCREENS_DIR = "src/screens";

const assertPlainPath = (appDir: string, relative: string): void => {
  const root = realpathSync(appDir);
  let current = appDir;
  for (const part of relative.split("/")) {
    current = join(current, part);
    if (!existsSync(current)) return;
    if (lstatSync(current).isSymbolicLink()) throw new ToolRefusal(`${relative} goes through a link. Screens must be plain folders.`);
  }
  const real = realpathSync(current);
  if (real !== root && !real.startsWith(root + sep)) throw new ToolRefusal(`${relative} is outside the app folder.`);
};

export const generate = async (appDir: string, input: RunGeneratorInput): Promise<RunGeneratorOutput> => {
  try {
    const catalog = await readCatalogFile(appDir);
    const component = componentName(input.screen);
    let made: Generated;
    switch (input.generator) {
      case "list_detail":
        made = listDetail(input, catalog, component);
        break;
      case "form":
        made = form(input, catalog, component);
        break;
      case "dashboard":
        made = dashboard(input, catalog, component);
        break;
      case "report_table":
        made = reportTable(input, catalog, component);
        break;
    }

    const screenFile = `${SCREENS_DIR}/${input.screen}/index.tsx`;
    assertPlainPath(appDir, screenFile);
    assertPlainPath(appDir, APP_TEMPLATE.screensFile);
    const existed = existsSync(join(appDir, screenFile));
    await mkdir(join(appDir, SCREENS_DIR, input.screen), { recursive: true });
    assertPlainPath(appDir, screenFile);
    await writeFile(join(appDir, screenFile), made.code);
    const listChange = await upsertScreen(appDir, { name: input.screen, title: input.title, component, from: `./${input.screen}` });

    return {
      ok: true,
      files: [
        { path: screenFile, change: existed ? "update" : "add" },
        { path: APP_TEMPLATE.screensFile, change: listChange },
      ],
      route: `/${input.screen}`,
      notes: [...made.notes, "Run `npx --no-install rms check` before you finish."].slice(0, 10).map((n) => n.slice(0, 280)),
    };
  } catch (error) {
    if (error instanceof ToolRefusal) return { ok: false, files: [], notes: [error.message.slice(0, 280)] };
    throw error;
  }
};
