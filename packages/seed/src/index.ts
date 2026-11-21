// @rms/seed: fictional demo data for Marigold Kitchen and Slice Yard, and the reset command. Task B.
export { DemoTemplate, DEMO_TEMPLATES, TEMPLATES, templateSpec, type TemplateSpec } from "./templates.js";
export { buildParentRows, type ParentRows, PARENT_SOURCE_TABLES } from "./parent-data.js";
export { createDemoRestaurant, removeRestaurants, type CreatedRestaurant, type CreateDemoOptions } from "./demo.js";
export * from "./sales.js";
export { COST_GROUPS, FOOD_AND_DRINK, costGroupsFor, stockItems } from "./stock.js";
export {
  checkResetAllowed,
  checkDemoPassword,
  authAdminFromEnv,
  listAuthUsers,
  deleteAuthUsers,
  checkConnectionIsLocal,
  checkSameDatabase,
  createDemoUsers,
  resetDemo,
  DEFAULT_DEMO_USERS,
  type AuthAdmin,
  type DemoUserSpec,
  type ResetOptions,
} from "./reset.js";
export { runResetCli } from "./reset-cli.js";
export { checkLibraryTemplates, installPlatformLibrary, type TemplateProblem } from "./library.js";
export {
  type BooksApp,
  type BooksClient,
  type BooksRoute,
  type LoadBooksOptions,
  type LoadBooksResult,
  type SeedBooksOptions,
  type SeededBooks,
  booksManifest,
  ensureBooksApp,
  loadDemoBooks,
  seedDemoBooks,
} from "./books.js";
