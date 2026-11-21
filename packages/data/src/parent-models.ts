// What the Data API knows about the ten parent-data tables in o_<id>_parent.
//
// The columns mirror the parent source tables in the platform migration, minus org_id
// (see platform.provision_store). Nothing here is read from a request.
//
// NOTE FOR THE LEAD: no shared ParentModelDefinition list exists yet, so this file holds the
// column list. It should move to @rms/contracts or @rms/parent, next to the table definitions.
import type { ParentModelKey, Role, Sensitivity } from "@rms/contracts";
import type { Kind } from "./shape.js";

export type ParentColumn = {
  key: string;
  label: string;
  kind: Kind;
  /** Roles that may read it. Omitted = everyone who can read the table. */
  readableBy?: Role[];
  sensitivity?: Sensitivity;
  /** The draft (build and preview) database role has no grant on this column. Hidden in draft. */
  liveOnly?: boolean;
};

export type ParentSpec = {
  key: ParentModelKey;
  name: string;
  description: string;
  /** Shown when another row points at this one. Readable by every role, in live and draft. */
  labelColumn: string;
  /** The column that says which location a row belongs to, if any. */
  locationColumn: "location_id" | "id" | null;
  columns: ParentColumn[];
};

const id: ParentColumn = { key: "id", label: "Id", kind: "uuid" };
const updated: ParentColumn = { key: "updated_at", label: "Last updated", kind: "timestamp" };
const loc: ParentColumn = { key: "location_id", label: "Location", kind: "uuid" };
const text = (key: string, label: string): ParentColumn => ({ key, label, kind: "text" });
const ownerOnly = (c: ParentColumn, sensitivity: Sensitivity): ParentColumn => ({ ...c, readableBy: ["owner"], sensitivity, liveOnly: true });

export const PARENT_SPECS: Record<ParentModelKey, ParentSpec> = {
  profile: {
    key: "profile", name: "Restaurant profile", description: "The restaurant's name, concept, cuisine and service style.",
    labelColumn: "name", locationColumn: null,
    columns: [id, text("name", "Name"), text("concept", "Concept"), text("cuisine", "Cuisine"), text("service_style", "Service style"),
      { key: "seats", label: "Seats", kind: "integer" }, text("price_band", "Price band"),
      { key: "systems_used", label: "Systems used", kind: "json" }, updated],
  },
  locations: {
    key: "locations", name: "Locations", description: "Each place the restaurant trades from, with its hours and day cutoff.",
    labelColumn: "name", locationColumn: "id",
    columns: [id, text("name", "Name"), text("address", "Address"), text("timezone", "Time zone"), text("currency", "Currency"),
      { key: "day_cutoff", label: "Day cutoff", kind: "json" }, { key: "seats", label: "Seats", kind: "integer" },
      { key: "hours", label: "Opening hours", kind: "json" }, text("status", "Status"), { key: "created_at", label: "Created", kind: "timestamp" }],
  },
  jobs: {
    key: "jobs", name: "Jobs", description: "The jobs people do here, such as server or line cook.",
    labelColumn: "name", locationColumn: null,
    columns: [id, text("name", "Name"), text("house", "Front or back of house"), { key: "tipped", label: "Tipped", kind: "boolean" }, updated],
  },
  staff: {
    key: "staff", name: "Staff", description: "The people who work here, their job and their location.",
    labelColumn: "full_name", locationColumn: "location_id",
    columns: [id, loc, text("full_name", "Name"), { key: "job_id", label: "Job", kind: "uuid" },
      ownerOnly(text("email", "Email"), "personal"), ownerOnly(text("phone", "Phone"), "personal"),
      ownerOnly({ key: "hourly_rate_minor", label: "Hourly rate", kind: "money" }, "payroll"),
      text("currency", "Currency"), { key: "started_on", label: "Started on", kind: "date" }, text("status", "Status"), updated],
  },
  menu_categories: {
    key: "menu_categories", name: "Menu categories", description: "Groups of menu items, such as starters or the bar.",
    labelColumn: "name", locationColumn: null,
    columns: [id, text("name", "Name"), text("sales_group", "Sales group"), { key: "position", label: "Position", kind: "integer" }, updated],
  },
  menu_items: {
    key: "menu_items", name: "Menu items", description: "What the restaurant sells, with its price.",
    labelColumn: "name", locationColumn: null,
    columns: [id, { key: "category_id", label: "Category", kind: "uuid" }, text("name", "Name"), text("description", "Description"),
      { key: "price_minor", label: "Price", kind: "money" }, text("currency", "Currency"), { key: "active", label: "On the menu", kind: "boolean" }, updated],
  },
  menu_modifiers: {
    key: "menu_modifiers", name: "Menu modifiers", description: "Extras and changes a guest can ask for on a menu item.",
    labelColumn: "name", locationColumn: null,
    columns: [id, { key: "item_id", label: "Menu item", kind: "uuid" }, text("name", "Name"),
      { key: "price_minor", label: "Price", kind: "money" }, text("currency", "Currency"), updated],
  },
  tax_rates: {
    key: "tax_rates", name: "Tax rates", description: "Sales tax rates and what they apply to.",
    labelColumn: "name", locationColumn: "location_id",
    columns: [id, loc, text("name", "Name"), { key: "rate_bps", label: "Rate (hundredths of a percent)", kind: "integer" },
      text("applies_to", "Applies to"), text("remitted_by", "Paid over by"), updated],
  },
  licences: {
    key: "licences", name: "Licences", description: "Licences and permits, with their expiry dates.",
    labelColumn: "name", locationColumn: "location_id",
    columns: [id, loc, text("name", "Name"), text("issuer", "Issued by"), text("number", "Number"), { key: "expires_on", label: "Expires on", kind: "date" }, updated],
  },
  equipment: {
    key: "equipment", name: "Equipment", description: "Kitchen and front-of-house equipment.",
    labelColumn: "name", locationColumn: "location_id",
    columns: [id, loc, text("name", "Name"), text("kind", "Kind"), text("make", "Make"), { key: "installed_on", label: "Installed on", kind: "date" }, updated],
  },
};
