import { ACCESS, boolean, businessDate, check, date, decimal, f, gte, integer, lit, money, oneOf, quantity, ref, text } from "./helpers.js";
import type { ModelInput } from "./helpers.js";
import { JOB_GROUPS } from "./finance.js";

/**
 * The cost side the accounts mini-app needs today (ADR 0002): vendors and their bills from the
 * Inventory pack, and daily staff cost from the Labour pack. The rest of those packs comes later
 * and will reuse these models.
 */

const vendor: ModelInput = {
  key: "vendor",
  pack: "inventory",
  version: 1,
  name: "Vendor",
  description: "A company the restaurant buys from, such as a produce supplier, a meat supplier, a drinks distributor or a linen service, with its contact details and how many days the restaurant has to pay.",
  locationScoped: false,
  defaultAccess: ACCESS.ownerWritesStaffReads,
  labelField: "name",
  unique: [["name"]],
  fields: [
    text("name", "Name", { required: true, maxLength: 120 }),
    text("contact_name", "Contact", { maxLength: 120, sensitivity: "personal" }),
    text("email", "Email", { maxLength: 200, sensitivity: "personal" }),
    text("phone", "Phone", { maxLength: 40, sensitivity: "personal" }),
    integer("terms_days", "Days to pay", { description: "How many days after the bill date payment is due. 0 means on delivery." }),
    text("account_number", "Our account number with them", { maxLength: 60, sensitivity: "financial", readableBy: ["owner"] }),
    ref("default_account", "Usual cost account", "account", { description: "The account most of this vendor's bills are coded to, such as Food cost." }),
    boolean("active", "In use", { required: true }),
    text("note", "Note", { maxLength: 500 }),
  ],
  rules: [check("vendor_terms_not_negative", gte(f("terms_days"), lit(0)), "Days to pay cannot be negative.")],
};

const vendorBill: ModelInput = {
  key: "vendor_bill",
  pack: "inventory",
  version: 1,
  name: "Vendor bill",
  description: "A bill from a vendor for one location: who it is from, the business date it counts in, when it is due, the total and whether it has been paid. Its lines say what was bought and which cost account each part belongs to.",
  locationScoped: true,
  defaultAccess: ACCESS.ownerWritesStaffReads,
  unique: [["vendor", "bill_number"]],
  indexes: [["business_date"], ["vendor"], ["status"]],
  fields: [
    ref("vendor", "Vendor", "vendor", { required: true }),
    text("bill_number", "Bill number", { maxLength: 60 }),
    businessDate("The restaurant day the cost counts in, usually the delivery or bill date."),
    date("due_date", "Due"),
    money("total_amount", "Total", { required: true, description: "Must equal the sum of the bill's lines. A credit note is a negative total." }),
    oneOf("status", "Status", ["open", "paid", "void"], { required: true, description: "open: owed. paid: settled. void: entered by mistake, never posted to the books." }),
    text("note", "Note", { maxLength: 500 }),
  ],
};

const vendorBillLine: ModelInput = {
  key: "vendor_bill_line",
  pack: "inventory",
  version: 1,
  name: "Vendor bill line",
  description: "One line of a vendor bill: what was bought, how much of it, what it cost and the cost account it belongs to, such as Food cost, Alcohol cost or Supplies. A credit for a short or damaged delivery is a negative line.",
  locationScoped: true,
  defaultAccess: ACCESS.ownerWritesStaffReads,
  indexes: [["vendor_bill"], ["account"]],
  fields: [
    ref("vendor_bill", "Vendor bill", "vendor_bill", { required: true, description: "The bill this line belongs to. The business date comes from it." }),
    integer("line_number", "Line"),
    text("description", "What was bought", { required: true, maxLength: 200 }),
    ref("account", "Cost account", "account", { required: true, description: "The cost category this line is coded to." }),
    quantity("quantity", "Quantity", { description: "How much was bought, with its unit, for example 12 case or 40 kg." }),
    money("amount", "Amount", { required: true, description: "The cost of this line. Negative for a credit." }),
  ],
  rules: [
    {
      kind: "ref_value_in",
      name: "vendor_bill_line_cost_account",
      field: "account",
      refField: "type",
      allowed: ["expense", "asset"],
      message: "A bill line must be coded to a cost account or a stock account.",
    },
  ],
};

const labourDay: ModelInput = {
  key: "labour_day",
  pack: "labour",
  version: 1,
  name: "Daily staff hours and cost",
  description: "Hours worked and what they cost for one job group (front of house, back of house or management) at one location on one business date. The cost side of prime cost. Only the owner can see the cost.",
  locationScoped: true,
  defaultAccess: ACCESS.ownerWritesStaffReads,
  unique: [["location_id", "business_date", "job_group"]],
  indexes: [["business_date"]],
  fields: [
    businessDate("The restaurant day the hours were worked."),
    oneOf("job_group", "Job group", JOB_GROUPS, { required: true }),
    decimal("hours", "Hours worked", { required: true, scale: 2, description: "All hours worked that day, in hours, including overtime." }),
    decimal("overtime_hours", "Overtime hours", { scale: 2, description: "The part of the hours worked that was overtime, in hours." }),
    integer("staff_count", "People who worked"),
    money("labour_cost", "Staff cost", { required: true, sensitivity: "payroll", readableBy: ["owner"], description: "Wages for these hours. A fact from the schedule or payroll system, not a payroll calculation." }),
  ],
  rules: [
    check("labour_day_hours_not_negative", gte(f("hours"), lit(0)), "Hours cannot be negative."),
    check("labour_day_overtime_within_hours", gte(f("hours"), f("overtime_hours")), "Overtime hours cannot be more than the hours worked."),
    check("labour_day_cost_not_negative", gte(f("labour_cost"), lit(0)), "Staff cost cannot be negative."),
  ],
};

export const costs: ModelInput[] = [vendor, vendorBill, vendorBillLine, labourDay];
