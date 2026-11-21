// Requests in flight, per restaurant.
//
// The server has a small pool of database connections shared by every restaurant, so one
// restaurant sending many slow requests at once must not be able to use them all. Above the
// cap a request is answered `limit` at once, without touching the database. The count is per
// server instance, and it is ONE count for everything a restaurant asks of the Data API engine:
// mini-app requests and RMS's own screens (the parent-data lists) alike.
//
// The cap must stay below the size of the restaurant-facing connection pool in @rms/db
// (`apiDb`, ten connections), or one restaurant at its cap could still hold every connection.

const inFlight = new Map<string, number>();

/** A real screen fires more than four requests at once, so the default leaves room for that. */
export const DEFAULT_MAX_IN_FLIGHT = 8;

export const maxInFlight = (): number => {
  const n = Number(process.env.RMS_DATA_MAX_INFLIGHT);
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_MAX_IN_FLIGHT;
};

/**
 * Takes one slot for this restaurant. Returns the function that gives it back (call it exactly
 * once, in a `finally`), or null when the restaurant is already at its cap.
 * `org` MUST come from a verified token or session.
 */
export const enterRestaurant = (org: string): (() => void) | null => {
  const now = inFlight.get(org) ?? 0;
  if (now >= maxInFlight()) return null;
  inFlight.set(org, now + 1);
  let left = false;
  return () => {
    if (left) return;
    left = true;
    const remaining = (inFlight.get(org) ?? 1) - 1;
    if (remaining <= 0) inFlight.delete(org);
    else inFlight.set(org, remaining);
  };
};
