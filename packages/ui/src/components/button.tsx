import type { ButtonHTMLAttributes, ElementType, ReactNode } from "react";
import { cx } from "../cx";
import { Icon, type IconName } from "../icons";

type NativeButton = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "style" | "children">;

export type ButtonProps = NativeButton & {
  /** primary: the one filled action on a screen. secondary: outlined. quiet: words only. */
  variant?: "primary" | "secondary" | "quiet";
  /** l is the 52px size for the main action of a page. */
  size?: "m" | "l";
  /** On a phone, fill the width of its container so a thumb cannot miss it. No effect on wider screens. */
  block?: boolean;
  /** Leave the button out on a phone, for an action that needs a bigger screen in front of you. */
  hideOnPhone?: boolean;
  /** Work is under way: shows a turning ring and stops further presses. Change the words too. */
  busy?: boolean;
  icon?: IconName;
  /** Render as a link. Pass the app's router link as `linkAs` to keep navigation in-app. */
  href?: string;
  linkAs?: ElementType;
  children: ReactNode;
};

export function Button({
  variant = "secondary",
  size = "m",
  block = false,
  hideOnPhone = false,
  busy = false,
  icon,
  href,
  linkAs,
  children,
  disabled,
  type = "button",
  ...rest
}: ButtonProps) {
  const className = cx(
    "rms-button",
    variant !== "secondary" && `rms-button--${variant}`,
    size === "l" && "rms-button--l",
    block && "rms-button--block",
    hideOnPhone && "rms-button--wide-only",
  );
  const content = (
    <>
      {busy ? <span className="rms-spinner" aria-hidden="true" /> : icon ? <Icon name={icon} /> : null}
      {children}
    </>
  );

  if (href !== undefined && !disabled && !busy) {
    const Link: ElementType = linkAs ?? "a";
    return (
      <Link href={href} className={className} aria-label={rest["aria-label"]}>
        {content}
      </Link>
    );
  }

  return (
    <button {...rest} type={type} className={className} disabled={disabled || busy} aria-busy={busy || undefined}>
      {content}
    </button>
  );
}

export type IconButtonProps = NativeButton & {
  icon: IconName;
  /** Says what the button does. Read aloud, and shown as a tooltip. */
  label: string;
  outlined?: boolean;
};

export function IconButton({ icon, label, outlined = false, type = "button", ...rest }: IconButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      className={cx("rms-icon-button", outlined && "rms-icon-button--outlined")}
      aria-label={label}
      title={label}
    >
      <Icon name={icon} />
    </button>
  );
}
