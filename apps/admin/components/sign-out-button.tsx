"use client";
import { useRouter } from "next/navigation";
import { Button } from "@rms/ui";
import { supabaseBrowser } from "@/lib/supabase/client";

export function SignOutButton() {
  const router = useRouter();
  const onClick = async () => {
    await supabaseBrowser().auth.signOut();
    router.replace("/sign-in");
    router.refresh();
  };
  return (
    <Button variant="quiet" onClick={onClick}>
      Sign out
    </Button>
  );
}
