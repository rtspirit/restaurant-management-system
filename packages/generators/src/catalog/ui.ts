// What the build agent can use from @rms/ui, written by hand from packages/ui/src. Components
// take no className and no style: layout comes from Stack, Row and the patterns.
import type { GeneratorCatalogEntry, UiCatalogEntry } from "@rms/contracts";

type Prop = UiCatalogEntry["props"][number];
const p = (name: string, type: string, required: boolean, note?: string): Prop => (note ? { name, type, required, note } : { name, type, required });

export const PATTERNS: UiCatalogEntry[] = [
  {
    kind: "pattern",
    name: "ListDetail",
    summary: "A list of rows on the left and the open row on the right. On a phone the list and the detail are separate screens with a way back. Pair with DetailList inside a Card for the detail.",
    props: [
      p("label", "string", true, "Names the list for screen readers"),
      p("items", "{ id: string; title: string; subtitle?: string; meta?: string }[]", true, "meta is a figure on the right, already formatted"),
      p("selectedId", "string", false, "The open row. Empty shows only the list on a phone"),
      p("onSelect", "(id: string) => void", true),
      p("onBack", "() => void", true),
      p("detail", "ReactNode", true),
      p("empty", "ReactNode", false, "Shown instead of the list when there are no rows. Pass an EmptyState"),
    ],
    example: `<ListDetail label="Vendors" items={rows.map((row) => ({ id: String(row.id), title: showValue(row, "name", "text", rms) }))} selectedId={selectedId} onSelect={setSelectedId} onBack={() => setSelectedId("")} detail={<Card title="Hill Farm"><DetailList rows={[{ label: "Phone", value: "555 0100" }]} /></Card>} empty={<EmptyState title="No vendors yet">Add the first one.</EmptyState>} />`,
  },
  {
    kind: "pattern",
    name: "FormLayout",
    summary: "One card, one column, labels above fields, the main action last. Errors go under the field they belong to, in plain words.",
    props: [
      p("title", "string", true, 'What the form is for: "Add a vendor"'),
      p("description", "string", false, "One sentence on what happens when it is saved"),
      p("children", "ReactNode", true, "TextField, Select, Choice, FieldPair"),
      p("message", "ReactNode", false, "A Notice about the whole form"),
      p("actions", "ReactNode", true, "Buttons. Main action last"),
      p("onSubmit", "(event) => void", false, "The page does not reload"),
    ],
    example: `<FormLayout title="Add a vendor" onSubmit={() => void save()} actions={<><Button variant="secondary" type="button" onClick={cancel}>Cancel</Button><Button type="submit">Save</Button></>}>\n  <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} error={nameError} />\n</FormLayout>`,
  },
  {
    kind: "pattern",
    name: "Dashboard",
    summary: "A title, the period controls, then a stack of one-idea cards: a Card with a StatLead first, then a StatGroup, then charts.",
    props: [p("title", "string", true), p("titleLevel", "1 | 2 | 3", false), p("controls", "ReactNode", false, "Such as a Pager for the week"), p("children", "ReactNode", true), p("foot", "ReactNode", false)],
    example: `<Dashboard title="Money" controls={<Pager label="Week of 9 Nov" previousLabel="Week before" nextLabel="Week after" onPrevious={back} onNext={next} />}>\n  <Card><StatLead label="Prime cost" value="61.3%" /></Card>\n  <Card><StatGroup><Stat label="Net sales" value="$84,310" /></StatGroup></Card>\n</Dashboard>`,
  },
  {
    kind: "pattern",
    name: "ReportTable",
    summary: "A compact table of figures with a heading, right-aligned numbers, an optional total line and a line saying where the numbers came from.",
    props: [
      p("title", "string", true),
      p("columns", '{ key: string; label: string; align?: "start" | "end"; strong?: boolean }[]', true),
      p("rows", "{ id: string; cells: Record<string, ReactNode> }[]", true),
      p("total", "Record<string, ReactNode>", false, "The total line, by column key"),
      p("controls", "ReactNode", false),
      p("source", "string", false, "Where the numbers came from, in one sentence"),
    ],
    example: `<ReportTable title="Sales by day" columns={[{ key: "day", label: "Day" }, { key: "net", label: "Net sales", align: "end" }]} rows={[{ id: "1", cells: { day: "Mon 9 Nov", net: "$4,210.00" } }]} total={{ day: "Total", net: "$4,210.00" }} source="From your books." />`,
  },
];

export const COMPONENTS: UiCatalogEntry[] = [
  { kind: "component", name: "Page", summary: "One screen: a title, optional tabs and actions, then the work.", props: [p("title", "string", true), p("actions", "ReactNode", false, "One or two buttons on the right"), p("narrow", "boolean", false, "Reading width, for forms"), p("children", "ReactNode", true)], example: `<Page title="Vendors" actions={<Button icon="plus">Add a vendor</Button>}>...</Page>` },
  { kind: "component", name: "Card", summary: "A surface for one idea, with an optional title and one action.", props: [p("title", "string", false), p("action", "ReactNode", false), p("density", '"comfortable" | "compact"', false), p("children", "ReactNode", true)], example: `<Card title="Hill Farm" action={<Button variant="secondary">Change</Button>}>...</Card>` },
  { kind: "component", name: "DetailList", summary: "Facts about one thing: a name on the left, its value on the right.", props: [p("rows", "{ label: string; value: ReactNode }[]", true)], example: `<DetailList rows={[{ label: "Phone", value: "555 0100" }]} />` },
  { kind: "component", name: "Stack", summary: "Puts children one under another with even space.", props: [p("gap", '"xs" | "s" | "m" | "l" | "xl"', false), p("children", "ReactNode", true)], example: `<Stack gap="m">...</Stack>` },
  { kind: "component", name: "Row", summary: "Puts children side by side, wrapping on a phone.", props: [p("gap", '"s" | "m"', false), p("justify", '"start" | "between" | "end"', false), p("align", '"center" | "top" | "bottom"', false), p("children", "ReactNode", true)], example: `<Row justify="end"><Button>Save</Button></Row>` },
  { kind: "component", name: "Button", summary: "Something to press. One primary button per screen area; the main action last.", props: [p("variant", '"primary" | "secondary" | "quiet"', false), p("icon", "IconName", false, "plus, check, close, next, prev, ..."), p("busy", "boolean", false), p("type", '"button" | "submit"', false), p("onClick", "() => void", false), p("children", "ReactNode", true)], example: `<Button icon="plus" onClick={() => setEditing("new")}>Add a vendor</Button>` },
  { kind: "component", name: "TextField", summary: "A labelled text box. Use money for amounts, type=\"date\" for dates.", props: [p("label", "string", true), p("value", "string", false), p("onChange", "(event) => void", false), p("error", "string", false, "Plain words under the field"), p("hint", "string", false), p("money", "boolean", false), p("type", "string", false), p("inputMode", "string", false)], example: `<TextField label="Phone" value={draft.phone ?? ""} onChange={(e) => set("phone", e.target.value)} error={errors.phone ?? ""} />` },
  { kind: "component", name: "Select", summary: "Pick one from a list.", props: [p("label", "string", true), p("options", "{ value: string; label: string }[]", true), p("value", "string", false), p("onChange", "(event) => void", false), p("block", "boolean", false), p("hint", "string", false)], example: `<Select label="Status" block options={[{ value: "open", label: "Open" }]} value={status} onChange={(e) => setStatus(e.target.value)} />` },
  { kind: "component", name: "Choice", summary: "A checkbox or radio row the whole width of the form.", props: [p("type", '"checkbox" | "radio"', true), p("label", "string", true), p("checked", "boolean", false), p("onChange", "(event) => void", false)], example: `<Choice type="checkbox" label="In use" checked={active} onChange={(e) => setActive(e.target.checked)} />` },
  { kind: "component", name: "Dialog", summary: "A decision that needs full attention, such as confirming a removal. Every confirmation says what will happen.", props: [p("open", "boolean", true), p("onClose", "() => void", true), p("title", "string", true), p("actions", "ReactNode", false), p("children", "ReactNode", true)], example: `<Dialog open={confirming} onClose={() => setConfirming(false)} title="Remove this vendor?" actions={<Button onClick={remove}>Remove</Button>}>It goes from the list for good.</Dialog>` },
  { kind: "component", name: "EmptyState", summary: "An empty place that says what belongs in it and how to fill it.", props: [p("title", "string", true), p("children", "ReactNode", true), p("action", "ReactNode", false)], example: `<EmptyState title="No vendors yet" action={<Button>Add a vendor</Button>}>Add the first one and it shows here.</EmptyState>` },
  { kind: "component", name: "Notice", summary: "A plain message about the whole screen or form: a problem, or a status such as Saved.", props: [p("kind", '"problem" | "status"', true), p("children", "ReactNode", true)], example: `<Notice kind="status">Saved.</Notice>` },
  { kind: "component", name: "Skeleton", summary: "A placeholder while something loads.", props: [p("shape", '"text" | "figure" | "block"', false), p("width", '"s" | "m" | "l" | "full"', false), p("label", "string", false)], example: `<Skeleton shape="block" label="Loading vendors" />` },
  { kind: "component", name: "Stat", summary: "A label, a big figure and a note. Several go in a StatGroup.", props: [p("label", "string", true), p("value", "string", true, "Already formatted"), p("note", "string", false)], example: `<StatGroup><Stat label="Net sales" value="$84,310" /></StatGroup>` },
  { kind: "component", name: "StatLead", summary: "The one lead figure of a screen, large, with what it is measured against beside it.", props: [p("label", "string", true), p("value", "string", true), p("note", "string", false), p("aside", "ReactNode", false)], example: `<Card><StatLead label="Prime cost" value="61.3%" note="of net sales" /></Card>` },
  { kind: "component", name: "StatGroup", summary: "Two to four Stats side by side; rows on a narrow card.", props: [p("children", "ReactNode", true)], example: `<StatGroup><Stat label="Food" value="$9,120" /><Stat label="Staff" value="$21,400" /></StatGroup>` },
  { kind: "component", name: "BarChart", summary: "Bars for a few values, each with its figure written on it.", props: [p("label", "string", true), p("items", "{ id: string; label: string; value: number; display: string; current?: boolean }[]", true), p("direction", '"columns" | "rows"', false)], example: `<BarChart label="Net sales by day" items={[{ id: "mon", label: "Mon", value: 421000, display: "$4,210" }]} />` },
  { kind: "component", name: "Pager", summary: "Step back and forward through weeks, days or pages.", props: [p("label", "string", true, "What is on screen now"), p("previousLabel", "string", true), p("nextLabel", "string", true), p("onPrevious", "() => void", false), p("onNext", "() => void", false)], example: `<Pager label="Week of 9 Nov" previousLabel="Week before" nextLabel="Week after" onPrevious={back} onNext={next} />` },
  { kind: "component", name: "Tag", summary: "A short word about state, such as Paid or Overdue.", props: [p("weight", '"quiet" | "outline" | "solid"', false), p("children", "ReactNode", true)], example: `<Tag>Paid</Tag>` },
  { kind: "component", name: "Text", summary: "A paragraph of plain words.", props: [p("tone", '"ink" | "muted"', false), p("size", '"m" | "s"', false), p("children", "ReactNode", true)], example: `<Text tone="muted">Bills are due 30 days after delivery.</Text>` },
  { kind: "component", name: "Heading", summary: "A heading inside a screen.", props: [p("level", "1 | 2 | 3 | 4", true), p("size", '"page" | "app" | "section" | "card" | "small"', false), p("children", "ReactNode", true)], example: `<Heading level={2} size="section">This week</Heading>` },
];

export const GENERATORS: GeneratorCatalogEntry[] = [
  { kind: "generator", name: "list_detail", summary: "A list of one model's records with a detail view. With form: true (and write access) also add, change and remove.", example: JSON.stringify({ generator: "list_detail", screen: "vendors", title: "Vendors", model: "vendor", fields: ["name", "contact_name", "phone", "terms_days", "active"], form: true }) },
  { kind: "generator", name: "form", summary: "One form that adds a record, then starts again empty.", example: JSON.stringify({ generator: "form", screen: "add-vendor", title: "Add a vendor", model: "vendor", fields: ["name", "phone", "terms_days"] }) },
  { kind: "generator", name: "dashboard", summary: "Big figures from the latest row of a report, and an optional bar chart of every row. Dates the report needs start at last week, with a pager.", example: JSON.stringify({ generator: "dashboard", screen: "money", title: "Money", query: "prime_cost_by_week", stats: [{ label: "Prime cost", column: "prime_cost_pct", format: "percent" }, { label: "Net sales", column: "net_sales", format: "money" }], chart: { label: "Net sales by week", category: "week_start", value: "net_sales", format: "money" } }) },
  { kind: "generator", name: "report_table", summary: "A table of a report's rows with a total line for money and counts. Dates the report needs start at last week, with a pager.", example: JSON.stringify({ generator: "report_table", screen: "sales", title: "Sales", query: "sales_by_day", columns: ["business_date", "net_sales", "guests", "checks"] }) },
];
