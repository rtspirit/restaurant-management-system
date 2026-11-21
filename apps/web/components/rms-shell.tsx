"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import {
  Account,
  AppShell,
  BottomBar,
  BottomBarItem,
  Button,
  DEFAULT_BRAND,
  Dialog,
  Logo,
  NavItem,
  NavList,
  Rail,
  Select,
  Stack,
  Text,
  Theme,
  TopBar,
  type IconName,
} from "@rms/ui";
import type { ShellData } from "./shell-data";

type Destination = { href: string; label: string; icon: IconName };

// The six places in RMS, in the order they appear in the side rail.
const DESTINATIONS: Destination[] = [
  { href: "/", label: "Home", icon: "home" },
  { href: "/menu", label: "Menu", icon: "menu" },
  { href: "/staff", label: "Staff", icon: "staff" },
  { href: "/locations", label: "Locations", icon: "locations" },
  { href: "/mini-apps", label: "Mini-apps", icon: "apps" },
  { href: "/settings", label: "Settings", icon: "settings" },
];

// A phone has room for four places and "More". The rest live in the More sheet.
const ON_BOTTOM_BAR = ["/", "/menu", "/staff", "/mini-apps"];

const ROLE_WORDS: Record<ShellData["role"], string> = { owner: "Owner", staff: "Staff" };

/** Posts to /sign-out, which clears the session and goes to sign-in (task A's route). */
function SignOut() {
  return (
    <form action="/sign-out" method="post">
      <Button type="submit" variant="quiet">
        Sign out
      </Button>
    </form>
  );
}

const ALL_LOCATIONS = "all";

function isCurrent(href: string, path: string): boolean {
  return href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`);
}

export type RmsShellProps = {
  data: ShellData;
  /** Force which place is marked as current. Used by the gallery, whose pages live outside the six places. */
  currentHref?: string;
  /** Replaces the logo at the top of a phone screen, for a mini-app opened on its own. */
  phoneStart?: ReactNode;
  children: ReactNode;
};

/**
 * The RMS frame: side rail on a desktop, top strip and bottom bar on a phone. It draws
 * only what it is given in `data`. It fetches nothing.
 */
export function RmsShell({ data, currentHref, phoneStart, children }: RmsShellProps) {
  const pathname = usePathname();
  const path = currentHref ?? pathname;
  const [moreOpen, setMoreOpen] = useState(false);

  // Going somewhere from the More sheet closes it.
  useEffect(() => setMoreOpen(false), [pathname]);

  // STUB: the chosen location is kept here only so the control works. Wave 2 moves it
  // to wherever the data loaders read it from.
  const [location, setLocation] = useState(ALL_LOCATIONS);

  const locationSwitcher =
    data.locations.length > 1 ? (
      <Select
        label="Location"
        hideLabel
        block
        value={location}
        onChange={(event) => setLocation(event.target.value)}
        options={[{ value: ALL_LOCATIONS, label: "All locations" }, ...data.locations.map((place) => ({ value: place.id, label: place.name }))]}
      />
    ) : null;

  // RMS may not know a name yet. Then the role stands in for it, and the avatar shows the restaurant's initial.
  // A name that is only the role again ("Owner", from owner@...) is not a name: never print "Owner" under "Owner".
  const role = ROLE_WORDS[data.role];
  const named = data.userName !== "" && data.userName.toLowerCase() !== role.toLowerCase();
  const account = (
    <Stack gap="s">
      <Account name={named ? data.userName : role} initials={data.userInitials || data.restaurantName.slice(0, 1)} role={named ? role : data.restaurantName} />
      <SignOut />
    </Stack>
  );
  const inMore = DESTINATIONS.filter((place) => !ON_BOTTOM_BAR.includes(place.href));

  return (
    <Theme brand={data.brandColour ?? DEFAULT_BRAND}>
      <AppShell
        rail={
          <Rail label="Main" logo={<Logo href="/" linkAs={Link} />} placeName={data.restaurantName} place={locationSwitcher} foot={account}>
            <NavList>
              {DESTINATIONS.map((place) => (
                <NavItem key={place.href} {...place} current={isCurrent(place.href, path)} linkAs={Link} />
              ))}
            </NavList>
          </Rail>
        }
        topBar={
          phoneStart ? (
            <TopBar start={phoneStart} end={locationSwitcher} />
          ) : (
            <TopBar start={<Logo size="s" href="/" linkAs={Link} />} placeName={data.restaurantName} end={locationSwitcher} />
          )
        }
        bottomBar={
          <BottomBar label="Main">
            {DESTINATIONS.filter((place) => ON_BOTTOM_BAR.includes(place.href)).map((place) => (
              <BottomBarItem key={place.href} {...place} current={isCurrent(place.href, path)} linkAs={Link} />
            ))}
            <BottomBarItem icon="more" label="More" onPress={() => setMoreOpen(true)} expanded={moreOpen} current={inMore.some((place) => isCurrent(place.href, path))} />
          </BottomBar>
        }
      >
        {children}
      </AppShell>

      <Dialog open={moreOpen} onClose={() => setMoreOpen(false)} title="More">
        <Stack gap="l">
          <NavList>
            {inMore.map((place) => (
              <NavItem key={place.href} {...place} current={isCurrent(place.href, path)} linkAs={Link} />
            ))}
          </NavList>
          <Stack gap="s">
            <Text tone="muted" size="s">
              Signed in to {data.restaurantName}
            </Text>
            {account}
          </Stack>
        </Stack>
      </Dialog>
    </Theme>
  );
}

export type BackToRmsProps = { href?: string };

/** The way back to RMS from a mini-app opened on its own on a phone. */
export function BackToRms({ href = "/mini-apps" }: BackToRmsProps) {
  return (
    <Button href={href} linkAs={Link} icon="prev" aria-label="Back to RMS">
      <Logo size="s" />
    </Button>
  );
}
