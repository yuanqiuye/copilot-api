import consola from "consola"

import { getCopilotUsage } from "~/services/github/get-copilot-usage"

export interface TrackedRequest {
  id: number
  timestamp: string
  model: string
  initiator: "user" | "agent"
  isBackground: boolean
  isCompact: boolean
  isBackgroundContinue: boolean
  premiumBefore: number | null
  premiumAfter: number | null
  premiumConsumed: boolean | null
  messageCount: number
  lastMessageContent: string
}

export interface PremiumTrackingState {
  sessionStartedAt: string
  sessionStartPremiumRemaining: number | null
  currentPremiumRemaining: number | null
  totalPremiumConsumed: number
  requests: Array<TrackedRequest>
}

const logger = consola.withTag("premium-tracking")

let nextId = 1
const requests: Array<TrackedRequest> = []
let sessionStartPremiumRemaining: number | null = null
let lastKnownPremiumRemaining: number | null = null
const sessionStartedAt = new Date().toISOString()
let premiumCheckQueue: Promise<void> = Promise.resolve()

const fetchPremiumRemaining = async (): Promise<number | null> => {
  try {
    const usage = await getCopilotUsage()
    return usage.quota_snapshots.premium_interactions.remaining
  } catch {
    logger.debug("Failed to fetch premium remaining")
    return null
  }
}

export const initPremiumTracking = async (): Promise<void> => {
  const remaining = await fetchPremiumRemaining()
  if (remaining !== null) {
    sessionStartPremiumRemaining = remaining
    lastKnownPremiumRemaining = remaining
    logger.info(`Premium tracking initialized: ${remaining} remaining`)
  }
}

export const trackRequest = (metadata: {
  model: string
  initiator: "user" | "agent"
  isBackground: boolean
  isCompact: boolean
  isBackgroundContinue: boolean
  messageCount: number
  lastMessageContent: string
}): number => {
  const id = nextId++
  const record: TrackedRequest = {
    id,
    timestamp: new Date().toISOString(),
    model: metadata.model,
    initiator: metadata.initiator,
    isBackground: metadata.isBackground,
    isCompact: metadata.isCompact,
    isBackgroundContinue: metadata.isBackgroundContinue,
    premiumBefore: lastKnownPremiumRemaining,
    premiumAfter: null,
    premiumConsumed: null,
    messageCount: metadata.messageCount,
    lastMessageContent: metadata.lastMessageContent,
  }
  requests.push(record)
  return id
}

export const checkPremiumAfterRequest = (requestId: number): void => {
  // Queue premium checks sequentially so each check sees the updated
  // lastKnownPremiumRemaining from the previous check.
  // This prevents mis-attribution when GitHub's billing system has a delay.
  premiumCheckQueue = premiumCheckQueue.then(async () => {
    // Delay to allow GitHub's billing system to update
    await new Promise((resolve) => setTimeout(resolve, 3000))

    const remaining = await fetchPremiumRemaining()
    if (remaining === null) return

    const record = requests.find((r) => r.id === requestId)
    if (!record) return

    // Use the latest known premium (updated by previous queued checks)
    // instead of the snapshot taken at request start time
    record.premiumBefore = lastKnownPremiumRemaining
    record.premiumAfter = remaining

    if (record.premiumBefore !== null) {
      record.premiumConsumed = remaining < record.premiumBefore
    }

    lastKnownPremiumRemaining = remaining

    if (record.premiumConsumed) {
      logger.warn(
        `Request #${requestId} (model=${record.model}, bg=${String(record.isBackground)}) CONSUMED premium: ${String(record.premiumBefore)} → ${String(remaining)}`,
      )
    } else {
      logger.debug(
        `Request #${requestId} (model=${record.model}, bg=${String(record.isBackground)}) no premium change: ${String(remaining)}`,
      )
    }
  })
}

export const getTrackingState = (): PremiumTrackingState => {
  const consumed =
    (
      sessionStartPremiumRemaining !== null
      && lastKnownPremiumRemaining !== null
    ) ?
      sessionStartPremiumRemaining - lastKnownPremiumRemaining
    : 0
  return {
    sessionStartedAt,
    sessionStartPremiumRemaining,
    currentPremiumRemaining: lastKnownPremiumRemaining,
    totalPremiumConsumed: consumed,
    requests: [...requests].reverse(),
  }
}
