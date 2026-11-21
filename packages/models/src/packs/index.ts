import { ModelDefinition, NamedActionDefinition, NamedQueryDefinition } from "@rms/contracts";
import { namedActionInputs } from "./actions.js";
import { costs } from "./costs.js";
import { finance } from "./finance.js";
import { foundation } from "./foundation.js";
import { namedQueryInputs } from "./queries.js";
import { sales } from "./sales.js";

/**
 * The library packs restaurants share: Foundation, Sales and Finance, plus the four cost-side
 * models the accounts mini-app needs (vendors, bills, stock items and stock counts from Inventory, daily staff cost from
 * Labour). See docs/plan/02-restaurant-domain.md.
 *
 * Every definition is parsed here with its schema from `@rms/contracts`, so defaults are filled
 * in and a definition that breaks the format stops the library from loading at all.
 *
 * Models are listed so that a model always comes after the models it points at.
 */
export const models: ModelDefinition[] = [...foundation, ...sales, ...finance, ...costs].map((m) => ModelDefinition.parse(m));

export const namedQueries: NamedQueryDefinition[] = namedQueryInputs.map((q) => NamedQueryDefinition.parse(q));

export const namedActions: NamedActionDefinition[] = namedActionInputs.map((a) => NamedActionDefinition.parse(a));

export { DEFAULT_CHART_OF_ACCOUNTS, DEFAULT_POSTING_RULES, STANDARD_CALENDAR_NAME } from "./actions.js";
export type { DefaultAccount, DefaultPostingRule } from "./actions.js";
