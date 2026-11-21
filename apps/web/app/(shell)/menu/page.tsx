import type { Metadata } from "next";
import { Card, Columns, DetailList, EmptyState, Page, Tag, Text } from "@rms/ui";
import { ListUnavailable } from "@/components/list-unavailable";
import { type ParentRow, count, loadParentLists, money, text, whole } from "@/lib/parent-server";

export const metadata: Metadata = { title: "Menu" };

const price = (row: ParentRow): string => money(whole(row, "price_minor"), text(row, "currency") || "USD");

/** The name, with what it is after it when the menu says. Long names wrap, they are never cut off. */
const itemLabel = (row: ParentRow): string => {
  const description = text(row, "description");
  return description ? `${text(row, "name")}: ${description.charAt(0).toLowerCase()}${description.slice(1)}` : text(row, "name");
};

// Read-only: the restaurant's menu as RMS holds it. Mini-apps read the same list.
export default async function MenuPage() {
  const load = await loadParentLists(["menu_categories", "menu_items", "menu_modifiers"]);
  if (load.status === "signed-out") return null; // The layout is showing something else.
  if (load.status === "unavailable") {
    return (
      <Page title="Menu" narrow>
        <ListUnavailable title="The menu is not loading just now" href="/menu" />
      </Page>
    );
  }

  const categories = [...load.lists.menu_categories.rows].sort((a, b) => (whole(a, "position") ?? 0) - (whole(b, "position") ?? 0) || text(a, "name").localeCompare(text(b, "name")));
  const items = load.lists.menu_items.rows;
  const extras = load.lists.menu_modifiers.rows;
  const itemName = new Map(items.map((i) => [text(i, "id"), text(i, "name")]));

  if (items.length === 0) {
    return (
      <Page title="Menu" narrow>
        <EmptyState title="Nothing on the menu yet">Dishes, drinks, prices and the groups they belong to will show here.</EmptyState>
      </Page>
    );
  }

  return (
    <Page title="Menu">
      <Text tone="muted">
        {count(items.length, "item", "items")} in {count(categories.length, "group", "groups")}. RMS keeps this list, and your mini-apps read from it so every number uses
        the same menu.
      </Text>
      <Columns>
        {categories.map((category) => {
          const mine = items.filter((i) => text(i, "category_id") === text(category, "id"));
          if (mine.length === 0) return null;
          return (
            <Card key={text(category, "id")} title={text(category, "name")} action={<Tag>{count(mine.length, "item", "items")}</Tag>} as="section">
              <DetailList rows={mine.map((i) => ({ label: i.active === false ? `${itemLabel(i)} (off the menu)` : itemLabel(i), value: price(i) }))} />
            </Card>
          );
        })}
        {extras.length > 0 ? (
          <Card title="Extras" action={<Tag>{count(extras.length, "extra", "extras")}</Tag>} as="section">
            <DetailList
              rows={extras.map((x) => {
                const goesWith = itemName.get(text(x, "item_id"));
                return { label: goesWith ? `${text(x, "name")}, on ${goesWith}` : text(x, "name"), value: whole(x, "price_minor") === 0 ? "No charge" : price(x) };
              })}
            />
          </Card>
        ) : null}
      </Columns>
    </Page>
  );
}
