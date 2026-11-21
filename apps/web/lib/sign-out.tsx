// A plain sign-out control. Posts to /sign-out, which clears the session and goes to sign-in.
export function SignOutForm() {
  return (
    <form action="/sign-out" method="post">
      <button type="submit">Sign out</button>
    </form>
  );
}
