"use client";
import { useRouter } from "next/navigation";
import { Button } from "@rms/ui";
import { supabaseBrowser } from "@/lib/supabase/client";

export type SignOutButtonProps = {
  /** quiet in the console's header. primary when signing out is the one thing left to do. */
  variant?: "quiet" | "primary";
  label?: string;
};

export function SignOutButton({ variant = "quiet", label = "Sign out" }: SignOutButtonProps) {
  const router = useRouter();
  const onClick = async () => {
    await supabaseBrowser().auth.signOut();
    router.replace("/sign-in");
    router.refresh();
  };
  return (
    <Button variant={variant} onClick={onClick}>
      {label}
    </Button>
  );
}
