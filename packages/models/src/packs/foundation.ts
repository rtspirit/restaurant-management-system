import { ACCESS, and, boolean, check, date, f, gte, integer, lit, lte, oneOf, parentRef, ref, text } from "./helpers.js";
import type { ModelInput } from "./helpers.js";

/**
 * Foundation pack: the lists and calendars every other pack groups its numbers by.
 * See docs/plan/02-restaurant-domain.md section 3.
 */

/** Same groups as the parent menu categories, so a sales category can follow the menu. */
export const SALES_GROUPS = ["food", "beverage", "alcohol", "merchandise", "other"];

/** How money can arrive. Gift card redemptions are NOT a payment kind: see `gift_card_activity`. */
export const PAYMENT_KINDS = ["cash", "card", "delivery_platform", "house_account", "other"];

export const REASON_KINDS = ["discount", "comp", "void", "paid_in", "paid_out", "waste", "other"];

const unit: ModelInput = {
  key: "unit",
  pack: "foundation",
  version: 1,
  name: "Unit of measure",
  description:
    "The units things are counted, weighed or measured in: each, case, kg, litre, hour. Every quantity in the restaurant's data names one of these by its short code, so a number never stands alone. Retire one by marking it not in use: it is never removed.",
  locationScoped: false,
  softDelete: false,
  defaultAccess: ACCESS.ownerWritesStaffReads,
  labelField: "name",
  unique: [["code"]],
  fields: [
    text("code", "Short code", { required: true, maxLength: 16, description: "What quantities store beside the number, for example kg, l, each, case." }),
    text("name", "Name", { required: true, maxLength: 60 }),
    oneOf("kind", "Kind", ["count", "weight", "volume", "length", "time", "other"], { required: true, description: "What the unit measures. Units only convert to others of the same kind." }),
    boolean("active", "In use", { required: true }),
  ],
};

const taxRate: ModelInput = {
  key: "tax_rate",
  pack: "foundation",
  version: 1,
  name: "Tax rate",
  description:
    "A sales tax the restaurant charges guests: its name, the rate, what it applies to and who pays it to the government. Tax that a delivery platform pays over itself is marked here so it is never counted as owed by the restaurant. Retire one by marking it not in use: it is never removed.",
  locationScoped: true,
  softDelete: false,
  defaultAccess: ACCESS.ownerWritesStaffReads,
  labelField: "name",
  unique: [["location_id", "name"]],
  fields: [
    text("name", "Name", { required: true, maxLength: 60 }),
    integer("rate_bps", "Rate (hundredths of a percent)", { required: true, description: "825 means 8.25%." }),
    oneOf("applies_to", "Applies to", ["all", ...SALES_GROUPS], { required: true }),
    oneOf("remitted_by", "Who pays it over", ["restaurant", "platform"], {
      required: true,
      description: "restaurant: the restaurant owes this tax. platform: a delivery platform collects and pays it, so it is recorded but never added to what the restaurant owes.",
    }),
    parentRef("parent_tax_rate", "Tax rate from head office", "tax_rates", { description: "The matching rate in the restaurant's set-up data, when there is one." }),
    date("effective_from", "Applies from"),
    date("effective_to", "Applies until"),
    boolean("active", "In use", { required: true }),
  ],
  rules: [
    check("tax_rate_in_range", and(gte(f("rate_bps"), lit(0)), lte(f("rate_bps"), lit(10000))), "A tax rate must be between 0% and 100%."),
    check("tax_rate_dates_in_order", gte(f("effective_to"), f("effective_from")), "The end date cannot be before the start date."),
  ],
};

const fiscalCalendar: ModelInput = {
  key: "fiscal_calendar",
  pack: "foundation",
  version: 1,
  name: "Fiscal calendar",
  description:
    "How the restaurant divides its year for reporting: calendar months, 4-4-5 or thirteen four-week periods, and the day the week starts. Weeks and periods on every report come from this calendar, never from a guess. Retire one by marking it not in use: it is never removed.",
  locationScoped: false,
  softDelete: false,
  defaultAccess: ACCESS.ownerWritesStaffReads,
  labelField: "name",
  unique: [["name"]],
  fields: [
    text("name", "Name", { required: true, maxLength: 60 }),
    oneOf("kind", "Kind", ["calendar_months", "four_four_five", "four_five_four", "five_four_four", "thirteen_periods"], { required: true }),
    oneOf("week_starts_on", "Week starts on", ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"], { required: true }),
    boolean("active", "In use", { required: true, description: "Reports use the calendar that is in use. Keep one calendar in use at a time." }),
  ],
};

const fiscalPeriod: ModelInput = {
  key: "fiscal_period",
  pack: "foundation",
  version: 1,
  name: "Fiscal period",
  description:
    "One reporting period of the fiscal calendar (a month, or a four or five week block), with its first and last day and whether the books for it are open or closed. Nothing new can be posted to the ledger in a closed period. A period is never removed: close it instead.",
  locationScoped: false,
  softDelete: false,
  defaultAccess: ACCESS.ownerWritesStaffReads,
  labelField: "name",
  unique: [["calendar", "fiscal_year", "period_number"]],
  indexes: [["start_date", "end_date"]],
  fields: [
    ref("calendar", "Calendar", "fiscal_calendar", { required: true }),
    integer("fiscal_year", "Fiscal year", { required: true }),
    integer("period_number", "Period number", { required: true }),
    text("name", "Name", { required: true, maxLength: 60, description: "For example Period 11, 2026 or November 2026." }),
    date("start_date", "First day", { required: true }),
    date("end_date", "Last day", { required: true }),
    oneOf("status", "Books", ["open", "closed"], { required: true, description: "closed: the period is finished and the ledger accepts nothing new dated inside it." }),
  ],
  rules: [
    check("fiscal_period_dates_in_order", gte(f("end_date"), f("start_date")), "The last day cannot be before the first day."),
    check("fiscal_period_number_in_range", and(gte(f("period_number"), lit(1)), lte(f("period_number"), lit(13))), "A period number must be between 1 and 13."),
  ],
};

const fiscalWeek: ModelInput = {
  key: "fiscal_week",
  pack: "foundation",
  version: 1,
  name: "Fiscal week",
  description:
    "One week of the fiscal calendar, with its first and last day and the period it belongs to. Weekly reports such as the weekly profit and loss and prime cost group business dates by these weeks. A week that has sales or entries in it must never be removed.",
  locationScoped: false,
  softDelete: false,
  defaultAccess: ACCESS.ownerWritesStaffReads,
  labelField: "name",
  unique: [
    ["calendar", "fiscal_year", "week_number"],
    ["calendar", "start_date"],
  ],
  indexes: [["start_date", "end_date"]],
  fields: [
    ref("calendar", "Calendar", "fiscal_calendar", { required: true }),
    ref("period", "Period", "fiscal_period", { required: true }),
    integer("fiscal_year", "Fiscal year", { required: true }),
    integer("week_number", "Week number", { required: true }),
    text("name", "Name", { required: true, maxLength: 60, description: "For example Week of Nov 9." }),
    date("start_date", "First day", { required: true }),
    date("end_date", "Last day", { required: true }),
  ],
  rules: [
    check("fiscal_week_dates_in_order", gte(f("end_date"), f("start_date")), "The last day cannot be before the first day."),
    check("fiscal_week_number_in_range", and(gte(f("week_number"), lit(1)), lte(f("week_number"), lit(53))), "A week number must be between 1 and 53."),
  ],
};

const dayPart: ModelInput = {
  key: "day_part",
  pack: "foundation",
  version: 1,
  name: "Day part",
  description: "The stretches of the day the restaurant trades in, such as breakfast, lunch, dinner and late night, with when each starts and ends. Used to split sales and staffing within a day. Retire one by marking it not in use: it is never removed.",
  locationScoped: false,
  softDelete: false,
  defaultAccess: ACCESS.ownerWritesStaffReads,
  labelField: "name",
  unique: [["name"]],
  fields: [
    text("name", "Name", { required: true, maxLength: 60 }),
    integer("start_minute", "Starts (minutes after midnight)", { required: true, description: "690 means 11:30am." }),
    integer("end_minute", "Ends (minutes after midnight)", { required: true, description: "May be smaller than the start when the day part runs past midnight." }),
    integer("position", "Order in lists"),
    boolean("active", "In use", { required: true }),
  ],
  rules: [
    check("day_part_start_in_day", and(gte(f("start_minute"), lit(0)), lte(f("start_minute"), lit(1439))), "The start must be a time of day."),
    check("day_part_end_in_day", and(gte(f("end_minute"), lit(0)), lte(f("end_minute"), lit(1439))), "The end must be a time of day."),
  ],
};

const revenueCentre: ModelInput = {
  key: "revenue_centre",
  pack: "foundation",
  version: 1,
  name: "Revenue centre",
  description: "A part of one location that takes sales on its own, such as the dining room, the bar, the patio or the takeout counter. Used to see where in the building the money comes from. Retire one by marking it not in use: it is never removed.",
  locationScoped: true,
  softDelete: false,
  defaultAccess: ACCESS.ownerWritesStaffReads,
  labelField: "name",
  unique: [["location_id", "name"]],
  fields: [text("name", "Name", { required: true, maxLength: 60 }), boolean("active", "In use", { required: true })],
};

const salesCategory: ModelInput = {
  key: "sales_category",
  pack: "foundation",
  version: 1,
  name: "Sales category",
  description:
    "The groups daily sales are reported in, such as food, soft drinks, beer, wine, spirits and merchandise. Each belongs to a broad group (food, beverage, alcohol, merchandise, other) that decides which sales account it posts to. Retire one by marking it not in use: it is never removed.",
  locationScoped: false,
  softDelete: false,
  defaultAccess: ACCESS.ownerWritesStaffReads,
  labelField: "name",
  unique: [["name"]],
  fields: [
    text("name", "Name", { required: true, maxLength: 60 }),
    oneOf("sales_group", "Broad group", SALES_GROUPS, { required: true, description: "Decides the sales account and the matching cost account." }),
    parentRef("menu_category", "Menu category", "menu_categories", { description: "The menu category this follows, when there is one." }),
    integer("position", "Order in lists"),
    boolean("active", "In use", { required: true }),
  ],
};

const paymentType: ModelInput = {
  key: "payment_type",
  pack: "foundation",
  version: 1,
  name: "Payment type",
  description:
    "The ways guests pay: cash, each card type, house accounts and each delivery platform. Its kind decides where the money sits until it reaches the bank. Paying with a gift card is not a payment type: it is recorded as gift card activity. Retire one by marking it not in use: it is never removed.",
  locationScoped: false,
  softDelete: false,
  defaultAccess: ACCESS.ownerWritesStaffReads,
  labelField: "name",
  unique: [["name"]],
  fields: [
    text("name", "Name", { required: true, maxLength: 60 }),
    oneOf("kind", "Kind", PAYMENT_KINDS, {
      required: true,
      description: "cash: in the drawer. card: paid by the card processor later. delivery_platform: paid by the platform later, less its fees. house_account: billed to the guest later.",
    }),
    boolean("active", "In use", { required: true }),
  ],
};

const reasonCode: ModelInput = {
  key: "reason_code",
  pack: "foundation",
  version: 1,
  name: "Reason code",
  description:
    "The reasons staff pick when they discount or comp something, void a mistake, take cash out of or put cash into the drawer, or throw food away. Every discount, comp and cash movement carries one. Retire one by marking it not in use: it is never removed.",
  locationScoped: false,
  softDelete: false,
  defaultAccess: ACCESS.ownerWritesStaffReads,
  labelField: "name",
  unique: [["kind", "code"]],
  fields: [
    text("code", "Short code", { required: true, maxLength: 32 }),
    text("name", "Name", { required: true, maxLength: 60 }),
    oneOf("kind", "Used for", REASON_KINDS, { required: true }),
    boolean("active", "In use", { required: true }),
  ],
};

export const foundation: ModelInput[] = [unit, taxRate, fiscalCalendar, fiscalPeriod, fiscalWeek, dayPart, revenueCentre, salesCategory, paymentType, reasonCode];
