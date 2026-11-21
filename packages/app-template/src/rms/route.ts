// Locked. Which screen is open: the part of the address after "#/". A screen's address is its
// folder name. Anything unknown opens the first screen.
import { useEffect, useState } from "react";

const read = (names: string[]): string | undefined => {
  const wanted = window.location.hash.replace(/^#\/?/, "").split(/[/?]/)[0] ?? "";
  return names.includes(wanted) ? wanted : names[0];
};

export const useScreenName = (names: string[]): string | undefined => {
  const [name, setName] = useState(() => read(names));
  const key = names.join(",");
  useEffect(() => {
    const onChange = (): void => setName(read(key.split(",")));
    onChange();
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, [key]);
  return name;
};
