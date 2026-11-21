import type { ReactNode } from "react";
import { cx } from "../cx";
import { Heading } from "./text";

export type AppShellProps = {
  /** Desktop and wide tablets: the side rail. Pass a Rail. */
  rail: ReactNode;
  /** Phones and upright tablets: the strip at the top. Pass a TopBar. */
  topBar: ReactNode;
  /** Phones and upright tablets: thumb-reach navigation. Pass a BottomBar. */
  bottomBar: ReactNode;
  skipLabel?: string;
  children: ReactNode;
};

/**
 * The frame every RMS screen sits in. A light side rail on the slate ground from 900px up,
 * a top strip and a bottom bar below that. Only one set of navigation is shown at a time.
 */
export function AppShell({ rail, topBar, bottomBar, skipLabel = "Skip to the page", children }: AppShellProps) {
  return (
    <div className="rms-shell">
      <a className="rms-button rms-button--primary rms-shell__skip" href="#rms-main">
        {skipLabel}
      </a>
      <div className="rms-shell__rail">{rail}</div>
      <div className="rms-shell__top">{topBar}</div>
      <main className="rms-shell__main" id="rms-main" tabIndex={-1}>
        {children}
      </main>
      <div className="rms-shell__bottom">{bottomBar}</div>
    </div>
  );
}

export type RailProps = {
  /** Names the navigation for screen readers: "Main". */
  label: string;
  logo: ReactNode;
  /** The restaurant's name. */
  placeName: string;
  /** The location switcher. */
  place?: ReactNode;
  /** A NavList of NavItem. */
  children: ReactNode;
  /** Who is signed in. Pass an Account. */
  foot?: ReactNode;
};

export function Rail({ label, logo, placeName, place, children, foot }: RailProps) {
  return (
    <div className="rms-rail">
      <div className="rms-rail__logo">{logo}</div>
      <div className="rms-rail__place">
        <strong className="rms-place-name">{placeName}</strong>
        {place}
      </div>
      <nav aria-label={label}>{children}</nav>
      {foot ? <div className="rms-rail__foot">{foot}</div> : null}
    </div>
  );
}

export type TopBarProps = {
  /** Left: the logo, or a way back. */
  start: ReactNode;
  /** Under the logo: the restaurant's name. */
  placeName?: string;
  /** Right: the location switcher. */
  end?: ReactNode;
};

export function TopBar({ start, placeName, end }: TopBarProps) {
  return (
    <header className="rms-top-bar">
      <div className="rms-top-bar__start">
        {start}
        {placeName ? <span className="rms-place-name">{placeName}</span> : null}
      </div>
      {end ? <div className="rms-top-bar__end">{end}</div> : null}
    </header>
  );
}

export type PageProps = {
  title: string;
  /** Tabs beside the title. Pass TabLinks. */
  tabs?: ReactNode;
  /** One or two buttons on the right of the title. */
  actions?: ReactNode;
  /** Keep the page to a comfortable reading width (forms, settings). */
  narrow?: boolean;
  /** No space under the title: the content (a Workbench) draws right up to the tabs. */
  flush?: boolean;
  children: ReactNode;
};

/** One screen inside the shell: a title, optional tabs, then the work. */
export function Page({ title, tabs, actions, narrow = false, flush = false, children }: PageProps) {
  return (
    <div className="rms-page">
      <header className="rms-page__head">
        <Heading level={1} size="page">
          {title}
        </Heading>
        {tabs}
        {actions ? <div className="rms-page__actions">{actions}</div> : null}
      </header>
      <div className={cx("rms-page__body", narrow && "rms-page__body--narrow", flush && "rms-page__body--flush")}>{children}</div>
    </div>
  );
}

export type SectionProps = {
  title: string;
  /** Extra words beside the title, such as a Tag. */
  aside?: ReactNode;
  children: ReactNode;
};

/** A titled part of a page. */
export function Section({ title, aside, children }: SectionProps) {
  return (
    <section className="rms-section">
      <div className="rms-row rms-row--s">
        <Heading level={2} size="section">
          {title}
        </Heading>
        {aside}
      </div>
      {children}
    </section>
  );
}

export type DockProps = { children: ReactNode };

/** Keeps its child (the Composer) at the bottom of the page, within thumb reach. */
export function Dock({ children }: DockProps) {
  return <div className="rms-dock">{children}</div>;
}

export type CanvasProps = {
  /** A single narrow column, for sign-in and onboarding. */
  narrow?: boolean;
  /** What sits above the page: usually the Logo. Pass a CanvasHeader for more. */
  header?: ReactNode;
  children: ReactNode;
};

/** A plain page with no rail around it: sign-in, onboarding, the gallery, the maintainer console. */
export function Canvas({ narrow = false, header, children }: CanvasProps) {
  return (
    <div className={cx("rms-canvas", narrow && "rms-canvas--narrow")}>
      {header ? <header className="rms-canvas__head">{header}</header> : null}
      <main className="rms-canvas__main">{children}</main>
    </div>
  );
}

export type CanvasHeaderProps = {
  logo: ReactNode;
  /** A few words beside the logo, such as "Maintainer console". */
  title?: string;
  /** Navigation. Pass TabLinks. */
  nav?: ReactNode;
  /** On the right: sign out. */
  end?: ReactNode;
};

/** Logo, a name, navigation and one action, for pages that have no side rail. */
export function CanvasHeader({ logo, title, nav, end }: CanvasHeaderProps) {
  return (
    <>
      {logo}
      {title ? <p className="rms-canvas__title">{title}</p> : null}
      {nav}
      {end ? <div className="rms-canvas__head-end">{end}</div> : null}
    </>
  );
}

export type NarrowProps = { children: ReactNode };

/** Keeps its children to a comfortable reading and typing width inside a wide page. */
export function Narrow({ children }: NarrowProps) {
  return <div className="rms-narrow">{children}</div>;
}
