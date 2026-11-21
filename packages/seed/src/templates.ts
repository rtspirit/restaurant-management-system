// The two fictional demo restaurants. Every name, address, number and email here is made up.
// Phone numbers use the 555-01xx range reserved for fiction. Emails end in .test.
import type { ServiceStyle } from "@rms/contracts";

export type DemoTemplate = "marigold" | "slice_yard";
export const DEMO_TEMPLATES = ["marigold", "slice_yard"] as const satisfies readonly DemoTemplate[];

export type SalesGroup = "food" | "beverage" | "alcohol" | "merchandise" | "other";
export type House = "front" | "back" | "management";

type Hours = Record<"mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun", { open: string; close: string } | null>;

export type LocationSpec = {
  key: string;
  name: string;
  address: string;
  seats: number;
  hours: Hours;
};
export type JobSpec = { name: string; house: House; tipped: boolean };
export type StaffSpec = {
  name: string;
  job: string;
  location: string;
  /** Hourly rate in cents. */
  rate: number;
  startedOn: string;
};
export type CategorySpec = { name: string; salesGroup: SalesGroup; items: readonly (readonly [name: string, priceMinor: number, description?: string])[] };
export type ModifierSpec = { name: string; priceMinor: number; item?: string };
export type LicenceSpec = { name: string; issuer: string; number: string; location: string | null; expiresInDays: number };
export type EquipmentSpec = { name: string; kind: string; make: string; location: string; installedOn: string };

export type TemplateSpec = {
  template: DemoTemplate;
  name: string;
  slugBase: string;
  brandColour: string;
  emailDomain: string;
  profile: {
    concept: string;
    cuisine: string;
    serviceStyle: ServiceStyle;
    priceBand: "low" | "mid" | "high" | "premium";
    systemsUsed: string[];
  };
  locations: readonly LocationSpec[];
  jobs: readonly JobSpec[];
  staff: readonly StaffSpec[];
  categories: readonly CategorySpec[];
  modifiers: readonly ModifierSpec[];
  /** Sales tax the restaurant collects and remits, in basis points. Also used by generateSales. */
  salesTaxBps: number;
  licences: readonly LicenceSpec[];
  equipment: readonly EquipmentSpec[];
};

const dinner = (sunday: { open: string; close: string }): Hours => ({
  mon: { open: "17:00", close: "22:00" },
  tue: { open: "17:00", close: "22:00" },
  wed: { open: "17:00", close: "22:00" },
  thu: { open: "17:00", close: "22:30" },
  fri: { open: "17:00", close: "23:30" },
  sat: { open: "16:00", close: "23:30" },
  sun: sunday,
});

export const MARIGOLD: TemplateSpec = {
  template: "marigold",
  name: "Marigold Kitchen",
  slugBase: "marigold-kitchen",
  brandColour: "#E8892B",
  emailDomain: "marigold.test",
  profile: {
    concept: "Seasonal American dinner house with a cocktail bar",
    cuisine: "Modern American",
    serviceStyle: "full_service",
    priceBand: "mid",
    systemsUsed: ["Demo POS", "Payroll export", "Spreadsheets"],
  },
  locations: [
    { key: "downtown", name: "Downtown", address: "118 Larkspur Street, Fairhaven", seats: 110, hours: dinner({ open: "11:00", close: "21:00" }) },
    { key: "riverside", name: "Riverside", address: "42 Wharf Road, Fairhaven", seats: 72, hours: dinner({ open: "16:00", close: "21:00" }) },
  ],
  jobs: [
    { name: "General Manager", house: "management", tipped: false },
    { name: "Assistant Manager", house: "management", tipped: false },
    { name: "Head Chef", house: "back", tipped: false },
    { name: "Sous Chef", house: "back", tipped: false },
    { name: "Line Cook", house: "back", tipped: false },
    { name: "Prep Cook", house: "back", tipped: false },
    { name: "Dishwasher", house: "back", tipped: false },
    { name: "Server", house: "front", tipped: true },
    { name: "Bartender", house: "front", tipped: true },
    { name: "Host", house: "front", tipped: false },
    { name: "Busser", house: "front", tipped: true },
  ],
  staff: [
    { name: "Priya Castellano", job: "General Manager", location: "downtown", rate: 3450, startedOn: "2021-03-15" },
    { name: "Dario Lindqvist", job: "Head Chef", location: "downtown", rate: 3200, startedOn: "2021-02-01" },
    { name: "Hana Brightwater", job: "Sous Chef", location: "downtown", rate: 2550, startedOn: "2022-06-20" },
    { name: "Tomasz Achterberg", job: "Line Cook", location: "downtown", rate: 2050, startedOn: "2023-01-09" },
    { name: "Leila Marchetti", job: "Line Cook", location: "downtown", rate: 2000, startedOn: "2024-04-22" },
    { name: "Rafael Okafor", job: "Prep Cook", location: "downtown", rate: 1825, startedOn: "2023-09-11" },
    { name: "Bao Whitley", job: "Dishwasher", location: "downtown", rate: 1650, startedOn: "2025-02-03" },
    { name: "Celeste Moreau-Hart", job: "Server", location: "downtown", rate: 925, startedOn: "2022-05-16" },
    { name: "Jonah Pemberton", job: "Server", location: "downtown", rate: 900, startedOn: "2024-08-05" },
    { name: "Amara Solberg", job: "Server", location: "downtown", rate: 900, startedOn: "2025-03-17" },
    { name: "Felix Ndiaye", job: "Bartender", location: "downtown", rate: 1125, startedOn: "2022-11-28" },
    { name: "Greta Vasquez-Holm", job: "Bartender", location: "downtown", rate: 1100, startedOn: "2024-10-14" },
    { name: "Ines Kowalczyk", job: "Host", location: "downtown", rate: 1600, startedOn: "2025-06-02" },
    { name: "Theo Abernathy", job: "Busser", location: "downtown", rate: 1000, startedOn: "2025-07-21" },
    { name: "Owen Feldhaus", job: "Assistant Manager", location: "riverside", rate: 2650, startedOn: "2023-04-03" },
    { name: "Sunniva Park", job: "Sous Chef", location: "riverside", rate: 2500, startedOn: "2023-04-03" },
    { name: "Kofi Lindgren", job: "Line Cook", location: "riverside", rate: 2000, startedOn: "2023-05-15" },
    { name: "Rosalind Ferraro", job: "Prep Cook", location: "riverside", rate: 1800, startedOn: "2024-02-26" },
    { name: "Mateo Kristiansen", job: "Dishwasher", location: "riverside", rate: 1650, startedOn: "2025-01-13" },
    { name: "Nadia Oyelaran", job: "Server", location: "riverside", rate: 925, startedOn: "2023-04-10" },
    { name: "Callum Rourke-Silva", job: "Server", location: "riverside", rate: 900, startedOn: "2024-09-09" },
    { name: "Yusra Halvorsen", job: "Bartender", location: "riverside", rate: 1100, startedOn: "2023-08-21" },
    { name: "Elodie Banerjee-Cole", job: "Host", location: "riverside", rate: 1600, startedOn: "2025-04-28" },
    { name: "Jasper Quintero", job: "Busser", location: "riverside", rate: 1000, startedOn: "2025-08-18" },
  ],
  categories: [
    {
      name: "Starters",
      salesGroup: "food",
      items: [
        ["Charred Corn Fritters", 1200, "Lime crema, chili salt"],
        ["Burrata and Stone Fruit", 1600],
        ["Crispy Brussels Sprouts", 1100, "Maple, chili, toasted pecans"],
        ["Tuna Crudo", 1800],
        ["Marigold Wings", 1400, "Hot honey glaze"],
        ["French Onion Soup", 1100],
        ["Little Gem Caesar", 1300],
        ["Warm Sourdough and Cultured Butter", 700],
      ],
    },
    {
      name: "Mains",
      salesGroup: "food",
      items: [
        ["Roast Half Chicken", 2800, "Salsa verde, charred lemon"],
        ["Hanger Steak Frites", 3600],
        ["Seared Salmon", 3200, "Fennel, citrus, brown butter"],
        ["Braised Short Rib", 3800],
        ["Wild Mushroom Risotto", 2600],
        ["Pork Chop and Apple Mostarda", 3400],
        ["Shrimp and Grits", 2900],
        ["Marigold Burger", 2200, "Aged cheddar, onion jam, fries"],
        ["Ricotta Gnocchi", 2500],
        ["Market Fish", 3500],
      ],
    },
    {
      name: "Sides",
      salesGroup: "food",
      items: [
        ["Hand-cut Fries", 700],
        ["Garlic Greens", 800],
        ["Whipped Potatoes", 800],
        ["Roasted Carrots and Hot Honey", 900],
        ["Baked Mac and Cheese", 1000],
      ],
    },
    {
      name: "Desserts",
      salesGroup: "food",
      items: [
        ["Sticky Toffee Pudding", 1100],
        ["Chocolate Pot de Creme", 1000],
        ["Seasonal Fruit Crisp", 1000],
        ["Olive Oil Cake", 900],
        ["Affogato", 800],
      ],
    },
    {
      name: "Soft Drinks and Coffee",
      salesGroup: "beverage",
      items: [
        ["House Lemonade", 500],
        ["Iced Tea", 400],
        ["Sparkling Water", 600],
        ["Espresso", 400],
        ["Cappuccino", 550],
      ],
    },
    {
      name: "Bar",
      salesGroup: "alcohol",
      items: [
        ["Marigold Spritz", 1400],
        ["Smoked Old Fashioned", 1600],
        ["Classic Martini", 1500],
        ["House Margarita", 1300],
        ["Draft IPA", 900],
        ["Glass of Red", 1400],
        ["Glass of White", 1300],
      ],
    },
  ],
  modifiers: [
    { name: "Add grilled chicken", priceMinor: 700, item: "Little Gem Caesar" },
    { name: "Add shrimp", priceMinor: 900, item: "Little Gem Caesar" },
    { name: "Peppercorn sauce", priceMinor: 300, item: "Hanger Steak Frites" },
    { name: "Add bacon", priceMinor: 300, item: "Marigold Burger" },
    { name: "Add fried egg", priceMinor: 200, item: "Marigold Burger" },
    { name: "Gluten-free bun", priceMinor: 200, item: "Marigold Burger" },
    { name: "Make it a double", priceMinor: 700, item: "Smoked Old Fashioned" },
    { name: "Add a shot of amaro", priceMinor: 600, item: "Affogato" },
    { name: "Extra sauce on the side", priceMinor: 100 },
    { name: "No onions", priceMinor: 0 },
    { name: "Oat milk", priceMinor: 75 },
  ],
  salesTaxBps: 875,
  licences: [
    { name: "Food service establishment permit", issuer: "Fairhaven Health Department", number: "FSP-2026-0418", location: "downtown", expiresInDays: 214 },
    { name: "Liquor licence", issuer: "State Liquor Authority", number: "SLA-1187420", location: "downtown", expiresInDays: 301 },
    { name: "Food service establishment permit", issuer: "Fairhaven Health Department", number: "FSP-2026-0731", location: "riverside", expiresInDays: 167 },
    { name: "Liquor licence", issuer: "State Liquor Authority", number: "SLA-1190356", location: "riverside", expiresInDays: 21 },
    { name: "Fire safety certificate", issuer: "Fairhaven Fire Marshal", number: "FS-55120", location: "downtown", expiresInDays: 96 },
    { name: "Music performance licence", issuer: "Performing Rights Office", number: "MPL-88213", location: null, expiresInDays: 248 },
  ],
  equipment: [
    { name: "Walk-in cooler", kind: "refrigeration", make: "Coldline", location: "downtown", installedOn: "2021-01-18" },
    { name: "Six-burner range", kind: "cooking", make: "Ardent", location: "downtown", installedOn: "2021-01-25" },
    { name: "Combi oven", kind: "cooking", make: "Northfield", location: "downtown", installedOn: "2022-09-12" },
    { name: "Char grill", kind: "cooking", make: "Ardent", location: "downtown", installedOn: "2021-01-25" },
    { name: "Double fryer", kind: "cooking", make: "Brightwell", location: "downtown", installedOn: "2023-03-06" },
    { name: "Dish machine", kind: "warewashing", make: "Kettering", location: "downtown", installedOn: "2021-02-01" },
    { name: "Ice machine", kind: "refrigeration", make: "Coldline", location: "downtown", installedOn: "2021-02-01" },
    { name: "Espresso machine", kind: "beverage", make: "Brightwell", location: "downtown", installedOn: "2024-05-20" },
    { name: "Reach-in cooler", kind: "refrigeration", make: "Coldline", location: "riverside", installedOn: "2023-03-20" },
    { name: "Six-burner range", kind: "cooking", make: "Ardent", location: "riverside", installedOn: "2023-03-20" },
    { name: "Convection oven", kind: "cooking", make: "Northfield", location: "riverside", installedOn: "2023-03-20" },
    { name: "Flat-top griddle", kind: "cooking", make: "Ardent", location: "riverside", installedOn: "2023-03-27" },
    { name: "Dish machine", kind: "warewashing", make: "Kettering", location: "riverside", installedOn: "2023-03-27" },
  ],
};

export const SLICE_YARD: TemplateSpec = {
  template: "slice_yard",
  name: "Slice Yard",
  slugBase: "slice-yard",
  brandColour: "#C8372D",
  emailDomain: "sliceyard.test",
  profile: {
    concept: "Counter-service pizza by the slice and the whole pie",
    cuisine: "Pizza",
    serviceStyle: "counter_service",
    priceBand: "low",
    systemsUsed: ["Demo POS", "Delivery apps"],
  },
  locations: [
    {
      key: "mill_street",
      name: "Mill Street",
      address: "305 Mill Street, Fairhaven",
      seats: 28,
      hours: {
        mon: { open: "11:00", close: "22:00" },
        tue: { open: "11:00", close: "22:00" },
        wed: { open: "11:00", close: "22:00" },
        thu: { open: "11:00", close: "23:00" },
        fri: { open: "11:00", close: "01:00" },
        sat: { open: "11:00", close: "01:00" },
        sun: { open: "12:00", close: "21:00" },
      },
    },
  ],
  jobs: [
    { name: "Manager", house: "management", tipped: false },
    { name: "Shift Lead", house: "management", tipped: false },
    { name: "Pizzaiolo", house: "back", tipped: false },
    { name: "Prep Cook", house: "back", tipped: false },
    { name: "Dishwasher", house: "back", tipped: false },
    { name: "Cashier", house: "front", tipped: true },
    { name: "Counter Server", house: "front", tipped: true },
  ],
  staff: [
    { name: "Gianna Holloway", job: "Manager", location: "mill_street", rate: 2800, startedOn: "2022-08-01" },
    { name: "Ravi Albrecht", job: "Shift Lead", location: "mill_street", rate: 2100, startedOn: "2023-02-13" },
    { name: "Mika Sorensen", job: "Pizzaiolo", location: "mill_street", rate: 2000, startedOn: "2022-08-01" },
    { name: "Dmitri Faulkes", job: "Pizzaiolo", location: "mill_street", rate: 1900, startedOn: "2024-03-04" },
    { name: "Luz Carrington", job: "Prep Cook", location: "mill_street", rate: 1750, startedOn: "2024-06-17" },
    { name: "Tessa Lindahl", job: "Dishwasher", location: "mill_street", rate: 1600, startedOn: "2025-05-05" },
    { name: "Ezra Whitcombe", job: "Cashier", location: "mill_street", rate: 1550, startedOn: "2024-11-11" },
    { name: "Noor Valderrama", job: "Cashier", location: "mill_street", rate: 1550, startedOn: "2025-08-25" },
    { name: "Bram Okoye", job: "Counter Server", location: "mill_street", rate: 1500, startedOn: "2025-09-15" },
  ],
  categories: [
    {
      name: "Pizzas",
      salesGroup: "food",
      items: [
        ["Margherita Pie", 1800],
        ["Pepperoni Pie", 2000],
        ["White Clam Pie", 2400],
        ["Hot Honey Soppressata Pie", 2300],
        ["Mushroom and Truffle Pie", 2200],
        ["Garden Veggie Pie", 2000],
        ["Cheese Slice", 400],
        ["Pepperoni Slice", 450],
      ],
    },
    {
      name: "Sides and Salads",
      salesGroup: "food",
      items: [
        ["Garlic Knots", 700],
        ["Caesar Salad", 1000],
        ["Arugula and Parmesan Salad", 1000],
        ["Meatballs in Marinara", 1100],
        ["Wings, eight pieces", 1300],
      ],
    },
    {
      name: "Drinks",
      salesGroup: "beverage",
      items: [
        ["Fountain Soda", 300],
        ["Bottled Water", 250],
        ["Italian Soda", 400],
        ["Iced Tea", 350],
      ],
    },
    {
      name: "Desserts",
      salesGroup: "food",
      items: [
        ["Cannoli", 450],
        ["Tiramisu Cup", 650],
        ["Chocolate Chip Cookie", 300],
      ],
    },
  ],
  modifiers: [
    { name: "Extra cheese", priceMinor: 200 },
    { name: "Gluten-free crust", priceMinor: 300 },
    { name: "Extra dipping sauce", priceMinor: 100 },
    { name: "Well done", priceMinor: 0 },
    { name: "Add marinara", priceMinor: 100, item: "Garlic Knots" },
    { name: "Add chicken", priceMinor: 400, item: "Caesar Salad" },
    { name: "Extra ranch", priceMinor: 75, item: "Wings, eight pieces" },
  ],
  salesTaxBps: 825,
  licences: [
    { name: "Food service establishment permit", issuer: "Fairhaven Health Department", number: "FSP-2026-1102", location: "mill_street", expiresInDays: 24 },
    { name: "Business licence", issuer: "City of Fairhaven", number: "BL-302877", location: "mill_street", expiresInDays: 252 },
    { name: "Fire safety certificate", issuer: "Fairhaven Fire Marshal", number: "FS-56004", location: "mill_street", expiresInDays: 138 },
  ],
  equipment: [
    { name: "Deck oven, two decks", kind: "cooking", make: "Northfield", location: "mill_street", installedOn: "2022-07-11" },
    { name: "Deck oven, three decks", kind: "cooking", make: "Northfield", location: "mill_street", installedOn: "2023-10-02" },
    { name: "Spiral dough mixer", kind: "preparation", make: "Kettering", location: "mill_street", installedOn: "2022-07-11" },
    { name: "Walk-in cooler", kind: "refrigeration", make: "Coldline", location: "mill_street", installedOn: "2022-07-18" },
    { name: "Pizza prep table", kind: "refrigeration", make: "Coldline", location: "mill_street", installedOn: "2022-07-18" },
    { name: "Dish machine", kind: "warewashing", make: "Kettering", location: "mill_street", installedOn: "2022-07-25" },
    { name: "Soda fountain", kind: "beverage", make: "Brightwell", location: "mill_street", installedOn: "2022-07-25" },
  ],
};

export const TEMPLATES: Record<DemoTemplate, TemplateSpec> = { marigold: MARIGOLD, slice_yard: SLICE_YARD };

export const templateSpec = (template: DemoTemplate): TemplateSpec => {
  const spec = TEMPLATES[template];
  if (!spec) throw new Error("Unknown demo template");
  return spec;
};
