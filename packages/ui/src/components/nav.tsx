import type { ElementType, ReactNode } from "react";
import { cx } from "../cx";
import { Icon, type IconName } from "../icons";
import { IconButton } from "./button";

export type LogoProps = {
  size?: "m" | "s";
  /** Where the mark leads. With a link the full stop takes the action colour, because it can be pressed. */
  href?: string;
  linkAs?: ElementType;
  /** Read aloud for the link: "RMS home". */
  label?: string;
};

/**
 * The RMS wordmark: three heavy letters and a full stop. The full stop is the brand's one
 * idea in miniature. It is the only thing with colour, and only when you can press it.
 */
export function Logo({ size = "m", href, linkAs, label = "RMS home" }: LogoProps) {
  const className = cx("rms-logo", size === "s" && "rms-logo--s");
  const mark = (
    <>
      RMS
      <span className="rms-logo__dot" aria-hidden="true" />
    </>
  );
  if (href === undefined) return <span className={className}>{mark}</span>;
  const Link: ElementType = linkAs ?? "a";
  return (
    <Link href={href} className={className} aria-label={label}>
      {mark}
    </Link>
  );
}

export type TabLink = { href: string; label: string; current?: boolean };

export type TabLinksProps = {
  /** Names the set for screen readers: "Mini-apps". */
  label: string;
  items: TabLink[];
  linkAs?: ElementType;
};

/** Tabs that are separate pages, each with its own address (Build, Marketplace). */
export function TabLinks({ label, items, linkAs }: TabLinksProps) {
  const Link: ElementType = linkAs ?? "a";
  return (
    <nav aria-label={label}>
      <ul className="rms-tabs">
        {items.map((item) => (
          <li key={item.href}>
            <Link href={item.href} className="rms-tab" data-label={item.label} aria-current={item.current ? "page" : undefined}>
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export type NavItemProps = {
  icon: IconName;
  label: string;
  href: string;
  /** The page the owner is on. Shown as a white pill with coloured, heavier words. */
  current?: boolean;
  linkAs?: ElementType;
};

/** One line in the side rail. Wrap several in a NavList. */
export function NavItem({ icon, label, href, current = false, linkAs }: NavItemProps) {
  const Link: ElementType = linkAs ?? "a";
  return (
    <li>
      <Link href={href} className="rms-nav-item" aria-current={current ? "page" : undefined}>
        <Icon name={icon} />
        {label}
      </Link>
    </li>
  );
}

export type NavListProps = { children: ReactNode };

export function NavList({ children }: NavListProps) {
  return <ul className="rms-nav-list">{children}</ul>;
}

export type BottomBarItemProps = {
  icon: IconName;
  label: string;
  /** A link to a page... */
  href?: string;
  /** The place the owner is in. On a button (More), set it when the current page is one of the places behind the button. */
  current?: boolean;
  linkAs?: ElementType;
  /** ...or a button that opens something, such as the More sheet. */
  onPress?: () => void;
  expanded?: boolean;
};

export function BottomBarItem({ icon, label, href, current = false, linkAs, onPress, expanded }: BottomBarItemProps) {
  const body = (
    <>
      <Icon name={icon} size="l" />
      {label}
    </>
  );
  if (href !== undefined) {
    const Link: ElementType = linkAs ?? "a";
    return (
      <Link href={href} className="rms-bottom-bar__item" aria-current={current ? "page" : undefined}>
        {body}
      </Link>
    );
  }
  return (
    <button type="button" className="rms-bottom-bar__item" onClick={onPress} aria-haspopup="dialog" aria-expanded={expanded} aria-current={current ? "true" : undefined}>
      {body}
    </button>
  );
}

export type BottomBarProps = {
  /** Names the bar for screen readers: "Main". */
  label: string;
  /** Three to five BottomBarItem components. */
  children: ReactNode;
};

/** Thumb-reach navigation on a phone. */
export function BottomBar({ label, children }: BottomBarProps) {
  return (
    <nav className="rms-bottom-bar" aria-label={label}>
      {children}
    </nav>
  );
}

export type AvatarProps = { initials: string };

export function Avatar({ initials }: AvatarProps) {
  return (
    <span className="rms-avatar" aria-hidden="true">
      {initials.slice(0, 2).toUpperCase()}
    </span>
  );
}

export type AccountProps = { name: string; initials: string; role: string };

/** Who is signed in: initials, name and role in plain words. */
export function Account({ name, initials, role }: AccountProps) {
  return (
    <div className="rms-account">
      <Avatar initials={initials} />
      <span>
        <span className="rms-account__name">{name}</span>
        <span className="rms-account__role">{role}</span>
      </span>
    </div>
  );
}

export type PagerProps = {
  /** What is on screen now: "Nov 9 to Nov 15". */
  label: string;
  previousLabel: string;
  nextLabel: string;
  onPrevious?: () => void;
  onNext?: () => void;
  /** Leave a handler out, or set these, when there is nowhere further to go. */
  previousDisabled?: boolean;
  nextDisabled?: boolean;
};

/** Step back and forward through weeks, days or pages. */
export function Pager({ label, previousLabel, nextLabel, onPrevious, onNext, previousDisabled, nextDisabled }: PagerProps) {
  return (
    <div className="rms-pager" role="group" aria-label={label}>
      <IconButton icon="prev" label={previousLabel} onClick={onPrevious} disabled={previousDisabled ?? !onPrevious} />
      <span className="rms-pager__label" aria-live="polite">
        {label}
      </span>
      <IconButton icon="next" label={nextLabel} onClick={onNext} disabled={nextDisabled ?? !onNext} />
    </div>
  );
}
