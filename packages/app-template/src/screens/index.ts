// The mini-app's screens, in the order they show in its navigation.
// The generators add to this list (`rms gen ...`). Editable: reorder or rename here.
import type { ComponentType } from "react";
import { Welcome } from "./welcome";

export type Screen = {
  /** The screen's folder under src/screens/ and its address inside the mini-app. */
  name: string;
  /** What the navigation calls it. */
  title: string;
  component: ComponentType;
};

export const screens: Screen[] = [{ name: "welcome", title: "Welcome", component: Welcome }];
