// Seeded, fictional content for the gallery. The figures for the week of Nov 9 are the
// ones on the approved sketches (Marigold Kitchen), and every total adds up.

import type { BarChartItem, DataTableColumn, DataTableRow, ListDetailItem } from "@rms/ui";
import type { ShellData } from "@/components/shell-data";

/** The seeded demo restaurant the gallery screens are drawn for. Fictional. */
export const MARIGOLD_KITCHEN: ShellData = {
  restaurantName: "Marigold Kitchen",
  locations: [
    { id: "downtown", name: "Downtown" },
    { id: "riverside", name: "Riverside" },
  ],
  brandColour: null,
  userName: "Asha Verma",
  userInitials: "AV",
  role: "owner",
  miniApps: [],
};

const dollars = (amount: number) => `$${amount.toLocaleString("en-US")}`;
const share = (part: number, whole: number) => `${((part / whole) * 100).toFixed(1)}%`;
const toTen = (amount: number) => Math.round(amount / 10) * 10;

// Eight weeks of net sales. The third entry is what the week picker shows. The cost shares
// give each week its own believable prime cost; Nov 9 uses the sketch's exact figures.
const WEEK_FIGURES = [
  ["sep21", "Sep 21", "Sep 21 to Sep 27", 81940, 0.304, 0.316],
  ["sep28", "Sep 28", "Sep 28 to Oct 4", 83120, 0.301, 0.312],
  ["oct5", "Oct 5", "Oct 5 to Oct 11", 82560, 0.303, 0.314],
  ["oct12", "Oct 12", "Oct 12 to Oct 18", 84870, 0.299, 0.296],
  ["oct19", "Oct 19", "Oct 19 to Oct 25", 61480, 0.31, 0.389],
  ["oct26", "Oct 26", "Oct 26 to Nov 1", 80230, 0.305, 0.319],
  ["nov2", "Nov 2", "Nov 2 to Nov 8", 83790, 0.3, 0.313],
  ["nov9", "Nov 9", "Nov 9 to Nov 15", 84310, 0.302, 0.311],
] as const;

export const WEEK_IDS: string[] = WEEK_FIGURES.map(([id]) => id);
export const LATEST_WEEK = "nov9";

export const WEEKS: BarChartItem[] = WEEK_FIGURES.map(([id, label, , net]) => ({
  id,
  label,
  value: net,
  display: dollars(net),
  ...(id === "oct19" ? { state: "Slow week" } : {}),
}));

// One row per day for the week of Nov 9: net sales, food and drink cost, staff cost.
// Sums: 84,310 / 25,460 / 26,220.
const DAY_FIGURES = [
  ["Mon", 8140, 2470, 2890],
  ["Tue", 8960, 2710, 2960],
  ["Wed", 9870, 2980, 3150],
  ["Thu", 11420, 3450, 3520],
  ["Fri", 15830, 4770, 4540],
  ["Sat", 17950, 5410, 5010],
  ["Sun", 12140, 3670, 4150],
] as const;

export type WeekView = {
  range: string;
  net: string;
  goods: string;
  goodsShare: string;
  staff: string;
  staffShare: string;
  prime: string;
  /** Against the 60% target, in words, with the arrow that goes with it. */
  against: { words: string; icon: "up" | "fall" | "check" };
  days: BarChartItem[];
  locations: BarChartItem[];
};

/** Everything the Money mini-app shows for one week. The parts always add up to the total. */
export function weekView(id: string): WeekView {
  const row = WEEK_FIGURES.find(([weekId]) => weekId === id) ?? WEEK_FIGURES[WEEK_FIGURES.length - 1]!;
  const [weekId, , range, net, goodsRate, staffRate] = row;
  const sketchWeek = weekId === LATEST_WEEK;
  const goods = sketchWeek ? 25460 : toTen(net * goodsRate);
  const staff = sketchWeek ? 26220 : toTen(net * staffRate);
  const primePoints = Math.round(((goods + staff) / net) * 1000) / 10;
  const gap = Math.round((primePoints - 60) * 10) / 10;

  // Days keep the shape of the sketch week. Sunday takes up the rounding so the week adds up.
  const scaled = DAY_FIGURES.map(([day, base]) => [day, sketchWeek ? base : toTen((base * net) / 84310)] as const);
  const beforeSunday = scaled.slice(0, -1).reduce((total, [, amount]) => total + amount, 0);
  const days = scaled.map(([day, amount], index) => {
    const value = index === scaled.length - 1 ? net - beforeSunday : amount;
    return { id: day, label: day, value, display: dollars(value) };
  });

  const downtown = sketchWeek ? 51870 : toTen(net * 0.615);

  return {
    range,
    net: dollars(net),
    goods: dollars(goods),
    goodsShare: `${share(goods, net)} of sales`,
    staff: dollars(staff),
    staffShare: `${share(staff, net)} of sales`,
    prime: `${primePoints.toFixed(1)}%`,
    against:
      gap > 0
        ? { words: `${gap.toFixed(1)} points over`, icon: "up" }
        : gap < 0
          ? { words: `${Math.abs(gap).toFixed(1)} points under`, icon: "fall" }
          : { words: "On target", icon: "check" },
    days,
    locations: [
      { id: "downtown", label: "Downtown", value: downtown, display: dollars(downtown) },
      { id: "riverside", label: "Riverside", value: net - downtown, display: dollars(net - downtown) },
    ],
  };
}

export const REPORT_COLUMNS: DataTableColumn[] = [
  { key: "day", label: "Day", sortable: true },
  { key: "net", label: "Net sales", align: "end", sortable: true },
  { key: "goods", label: "Food and drink", align: "end" },
  { key: "staff", label: "Staff", align: "end" },
  { key: "prime", label: "Prime cost", align: "end", strong: true, sortable: true },
];

export type ReportDay = { id: string; day: string; order: number; net: number; goods: number; staff: number; prime: number };

export const REPORT_DAYS: ReportDay[] = DAY_FIGURES.map(([day, net, goods, staff], order) => ({
  id: day,
  day,
  order,
  net,
  goods,
  staff,
  prime: (goods + staff) / net,
}));

export const reportRow = (row: ReportDay): DataTableRow => ({
  id: row.id,
  cells: { day: row.day, net: dollars(row.net), goods: dollars(row.goods), staff: dollars(row.staff), prime: share(row.goods + row.staff, row.net) },
});

const sum = (pick: (row: ReportDay) => number) => REPORT_DAYS.reduce((total, row) => total + pick(row), 0);

export const REPORT_TOTAL = {
  day: "Week",
  net: dollars(sum((row) => row.net)),
  goods: dollars(sum((row) => row.goods)),
  staff: dollars(sum((row) => row.staff)),
  prime: share(
    sum((row) => row.goods + row.staff),
    sum((row) => row.net),
  ),
};

// A restaurant that already has mini-apps, and what the Marketplace recommends. All made up.
export const MINI_APPS = [
  { id: "money", name: "Money", summary: "Sales, costs and prime cost, week by week.", href: "/gallery/money" },
  { id: "bills", name: "Bills", summary: "What you owe suppliers and when it is due.", href: "/gallery" },
];

export const LISTINGS = [
  { id: "closeout", name: "Close-out count", summary: "Count the till at close and see what is over or short.", why: "Popular with full-service" },
  { id: "tips", name: "Tip share", summary: "Split the night’s tips by hours worked, ready for payday.", why: "Fits a team of 24" },
  { id: "prep", name: "Prep list", summary: "Tomorrow’s prep, worked out from what you usually sell.", why: "Good for two locations" },
];

// Supplier bills. Every name is made up.
export type Bill = ListDetailItem & { due: string; forWhat: string; location: string; status: string };

export const BILLS: Bill[] = [
  { id: "b1", title: "Harbor Lane Produce", subtitle: "Due Nov 18", meta: "$1,284.50", due: "Nov 18", forWhat: "Vegetables and herbs", location: "Downtown", status: "Not paid" },
  { id: "b2", title: "Copper Kettle Dairy", subtitle: "Due Nov 20", meta: "$642.00", due: "Nov 20", forWhat: "Milk, cream and butter", location: "Both locations", status: "Not paid" },
  { id: "b3", title: "Northside Linen", subtitle: "Due Nov 24", meta: "$318.75", due: "Nov 24", forWhat: "Napkins and aprons", location: "Riverside", status: "Not paid" },
  { id: "b4", title: "Tidewater Fish Co.", subtitle: "Paid Nov 12", meta: "$2,095.20", due: "Nov 14", forWhat: "Fresh fish, two deliveries", location: "Downtown", status: "Paid Nov 12" },
];

// Maintainer change feed, as the console shows it. Tiers are maintainer words. Owners never see them.
export type Change = {
  id: string;
  tier: "T0" | "T1" | "T2" | "T3";
  tierWords: string;
  restaurant: string;
  shortId: string;
  summary: string;
  detail: string;
  when: string;
  flag?: string;
  waiting?: boolean;
};

export const CHANGES: Change[] = [
  { id: "c1", tier: "T3", tierWords: "T3 platform", restaurant: "Slice Yard", shortId: "9c41e2", summary: "Asked to share “Close-out count” in the Marketplace", detail: "Waiting for us · From marketplace · Signals: public_listing · By owner", when: "2 min ago", waiting: true },
  { id: "c2", tier: "T2", tierWords: "T2 major", restaurant: "Marigold Kitchen", shortId: "4be7a0", summary: "Published “Money” to all staff", detail: "Waiting for owner · From build · Signals: publish, role_change · By owner", when: "14 min ago" },
  { id: "c3", tier: "T1", tierWords: "T1 minor", restaurant: "Marigold Kitchen", shortId: "4be7a0", summary: "Added a “Target” field to “Money”", detail: "Applied · From build · Signals: add_field · By owner", when: "1 hr ago", flag: "Needs a look: tier does not match its signals" },
  { id: "c4", tier: "T0", tierWords: "T0 cosmetic", restaurant: "Slice Yard", shortId: "9c41e2", summary: "Renamed a column in “Close-out count”", detail: "Applied · From build · Signals: label_change · By owner", when: "3 hr ago" },
];
