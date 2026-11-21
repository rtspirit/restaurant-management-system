import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SessionId } from "@rms/contracts";
import { BuildSession } from "@/components/build/build-session";
import { loadShellData } from "@/components/shell-data";

export const metadata: Metadata = { title: "Build a mini-app" };

// One build conversation with its live preview. The id in the address names a session, never
// a restaurant: the API looks it up for whoever is signed in, and anyone else's is not found.
export default async function BuildSessionPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  if (!SessionId.safeParse(sessionId).success) notFound();
  const data = await loadShellData();
  if (!data) return null; // The layout is showing something else (signing out, or not answering).
  return (
    <BuildSession
      sessionId={sessionId}
      profile={{
        restaurantName: data.restaurantName,
        brandColour: data.brandColour,
        userName: data.userName,
        role: data.role,
        locations: data.locations.map((location) => ({ name: location.name })),
      }}
    />
  );
}
