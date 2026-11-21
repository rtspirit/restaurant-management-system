// @rms/seed: fictional demo data for Marigold Kitchen and Slice Yard, and the reset command. Task B.
export { type DemoTemplate, DEMO_TEMPLATES, TEMPLATES, templateSpec, type TemplateSpec } from "./templates.js";
export { buildParentRows, type ParentRows, PARENT_SOURCE_TABLES } from "./parent-data.js";
export { createDemoRestaurant, removeRestaurants, insertRows, type CreatedRestaurant, type CreateDemoOptions } from "./demo.js";
export * from "./sales.js";
export {
  checkResetAllowed,
  checkDemoPassword,
  authAdminFromEnv,
  listAuthUsers,
  deleteAuthUsers,
  createDemoUsers,
  resetDemo,
  DEFAULT_DEMO_USERS,
  type AuthAdmin,
  type DemoUserSpec,
} from "./reset.js";
