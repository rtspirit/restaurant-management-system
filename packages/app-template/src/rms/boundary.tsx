// Locked. If a screen breaks while drawing, say so plainly instead of showing a blank page.
import { EmptyState } from "@rms/ui";
import { Component, type ReactNode } from "react";

type Props = { children: ReactNode };

export class ScreenBoundary extends Component<Props, { broken: boolean }> {
  override state = { broken: false };

  static getDerivedStateFromError(): { broken: boolean } {
    return { broken: true };
  }

  override render(): ReactNode {
    if (this.state.broken) {
      return (
        <EmptyState title="This screen did not open">
          Something went wrong while showing it. Try another screen, or ask for it to be fixed.
        </EmptyState>
      );
    }
    return this.props.children;
  }
}
