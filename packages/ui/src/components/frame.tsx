import type { ReactNode, Ref } from "react";

/**
 * What every mini-app frame carries. Scripts, its own storage and forms: nothing else. No
 * camera, microphone, location, pop-ups or top-level navigation. The same values as
 * FRAME_ATTRIBUTES in @rms/contracts (this package cannot import it; a test keeps them in step).
 */
export const FRAME_SANDBOX = "allow-scripts allow-same-origin allow-forms";
export const FRAME_REFERRER_POLICY = "no-referrer";
export const FRAME_ALLOW = "";

export type FrameProps = {
  /** Says what is inside, for screen readers: "Preview of Money". */
  title: string;
  /** The address to show. Leave it out until there is one. */
  src?: string;
  /**
   * empty: nothing to show yet. Say what belongs here in `children`.
   * loading: on its way. The frame is in place and covered until it is ready.
   * ready: showing.
   */
  state: "empty" | "loading" | "ready";
  /** What is happening while it loads, in plain words: "Getting your preview ready". */
  loadingLabel?: string;
  /** The frame element itself, for the code that talks to what is inside. */
  frameRef?: Ref<HTMLIFrameElement>;
  /** For the empty state: a heading and a sentence, or a Notice and a button. */
  children?: ReactNode;
};

/**
 * A mini-app shown inside RMS: a window with the card's corners. Empty is a dashed slot that
 * says what will show there. Loading is a turning ring and words. Never a blank box.
 */
export function Frame({ title, src, state, loadingLabel = "Loading", frameRef, children }: FrameProps) {
  return (
    <div className="rms-frame" data-state={state}>
      {src !== undefined && state !== "empty" ? (
        <iframe
          ref={frameRef}
          className="rms-frame__view"
          title={title}
          src={src}
          sandbox={FRAME_SANDBOX}
          referrerPolicy={FRAME_REFERRER_POLICY}
          allow={FRAME_ALLOW}
        />
      ) : null}
      {state === "loading" ? (
        <div className="rms-frame__cover" role="status">
          <span className="rms-spinner" aria-hidden="true" />
          {loadingLabel}
        </div>
      ) : null}
      {state === "empty" ? <div className="rms-frame__empty">{children}</div> : null}
    </div>
  );
}
