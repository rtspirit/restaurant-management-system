"use client";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";

export function SignOutButton() {
  const router = useRouter();
  const onClick = async () => {
    await supabaseBrowser().auth.signOut();
    router.replace("/sign-in");
    router.refresh();
  };
  return (
    <button type="button" onClick={onClick}>
      Sign out
    </button>
  );
}
