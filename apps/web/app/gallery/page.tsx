import type { Metadata } from "next";
import { Gallery } from "./gallery";

export const metadata: Metadata = { title: "Gallery" };

// Every @rms/ui component and pattern on one page, with seeded content, so the look can
// be reviewed without signing in. Not linked from the product.
export default function GalleryPage() {
  return <Gallery />;
}
