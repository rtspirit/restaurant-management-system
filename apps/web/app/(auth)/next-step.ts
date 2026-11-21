// After signing in or up: owners without a restaurant answer the onboarding questions first.
import type { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { parseMe } from "@/lib/me";

export async function goToNextStep(router: ReturnType<typeof useRouter>) {
  const res = await apiFetch("/auth/me");
  if (!res.ok) throw new Error("me_failed");
  const me = parseMe(await res.json());
  router.replace(me.restaurant ? "/" : "/onboarding");
  router.refresh();
}
