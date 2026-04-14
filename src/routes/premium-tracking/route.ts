import { Hono } from "hono"

import { getTrackingState } from "~/lib/premium-tracking"

export const premiumTrackingRoute = new Hono()

premiumTrackingRoute.get("/", (c) => {
  return c.json(getTrackingState())
})
