/** @jsxImportSource @opentui/solid */
import { createSignal } from "solid-js"
import type {
  TuiPlugin,
  TuiPluginModule,
  TuiSlotPlugin,
} from "@opencode-ai/plugin/tui"

type QuotaSnapshot = {
  remaining: number
  entitlement: number
  percent_remaining: number
  unlimited: boolean
  overage_count: number
  overage_permitted: boolean
}

type UsageResponse = {
  login: string
  quota_reset_date: string
  quota_snapshots: {
    chat: QuotaSnapshot
    completions: QuotaSnapshot
    premium_interactions: QuotaSnapshot
  }
}

const BAR_WIDTH = 20

const look = (map: Record<string, unknown>) => ({
  panel: (map.backgroundPanel || "#1d1d1d") as string,
  border: (map.border || "#4a4a4a") as string,
  text: (map.text || "#f0f0f0") as string,
  muted: (map.textMuted || "#a5a5a5") as string,
  accent: (map.primary || "#5f87ff") as string,
  success: (map.success || "#5fff87") as string,
  warning: (map.warning || "#ffaf5f") as string,
  error: (map.error || "#ff5f5f") as string,
})

const tui: TuiPlugin = async (api, options, _meta) => {
  const endpoint =
    (options?.endpoint as string) || "http://localhost:4141/usage"

  const [usage, setUsage] = createSignal<QuotaSnapshot | null>(null)
  const [resetDate, setResetDate] = createSignal("")
  const [fetchError, setFetchError] = createSignal("")
  const [lastUpdated, setLastUpdated] = createSignal("")
  const [sessionUsed, setSessionUsed] = createSignal(0)

  // Snapshot remaining at plugin init to compute per-session delta
  let initialRemaining: number | undefined

  const fetchUsage = async () => {
    try {
      const res = await fetch(endpoint)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data: UsageResponse = await res.json()
      const premium = data.quota_snapshots?.premium_interactions
      if (premium) {
        // Capture baseline on first successful fetch
        if (initialRemaining === undefined) {
          initialRemaining = premium.remaining
        }
        setUsage(premium)
        setSessionUsed(Math.max(0, initialRemaining - premium.remaining))
        setResetDate(data.quota_reset_date ?? "")
        setFetchError("")
        const now = new Date()
        setLastUpdated(
          `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`,
        )
      }
    } catch (e: unknown) {
      setFetchError(e instanceof Error ? e.message : "fetch failed")
    }
  }

  // Debounce: avoid hammering the API when multiple tool parts update rapidly
  let debounceTimer: ReturnType<typeof setTimeout> | undefined
  const debouncedFetch = () => {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => fetchUsage(), 800)
  }

  // Initial fetch
  await fetchUsage()

  // Update on every tool call completion
  const unsub1 = api.event.on("message.part.updated", (evt) => {
    const part = evt.properties.part
    if (part.type === "tool" && part.state.status === "completed") {
      debouncedFetch()
    }
  })
  api.lifecycle.onDispose(unsub1)

  // Also update when session goes idle (fallback for non-tool completions)
  const unsub2 = api.event.on("session.idle", () => {
    debouncedFetch()
  })
  api.lifecycle.onDispose(unsub2)

  // Cleanup debounce timer on dispose
  api.lifecycle.onDispose(() => {
    if (debounceTimer) clearTimeout(debounceTimer)
  })

  const slotPlugin: TuiSlotPlugin = {
    order: 150,
    slots: {
      sidebar_content(ctx, _value) {
        const skin = look(
          ctx.theme.current as unknown as Record<string, unknown>,
        )

        const color = () => {
          const u = usage()
          if (!u) return skin.muted
          if (u.percent_remaining > 50) return skin.success
          if (u.percent_remaining > 20) return skin.warning
          return skin.error
        }

        const bar = () => {
          const u = usage()
          if (!u || u.entitlement === 0) return "\u2591".repeat(BAR_WIDTH)
          const used = u.entitlement - u.remaining
          const filled = Math.round((used / u.entitlement) * BAR_WIDTH)
          return (
            "\u2588".repeat(filled) + "\u2591".repeat(BAR_WIDTH - filled)
          )
        }

        return (
          <box
            border
            borderColor={skin.border}
            backgroundColor={skin.panel}
            paddingTop={1}
            paddingBottom={1}
            paddingLeft={2}
            paddingRight={2}
            flexDirection="column"
            gap={1}
          >
            <text fg={skin.accent}>
              <b>Premium Usage</b>
            </text>

            {fetchError() ? (
              <text fg={skin.error}>Error: {fetchError()}</text>
            ) : usage() ? (
              <>
                <text fg={skin.text}>
                  <b>{usage()!.remaining}</b>
                  <span style={{ fg: skin.muted }}>
                    /{usage()!.entitlement}
                  </span>{" "}
                  remaining
                </text>

                <text fg={color()}>
                  <b>{usage()!.percent_remaining.toFixed(1)}%</b> left
                </text>

                <text fg={color()}>[{bar()}]</text>

                {usage()!.overage_count > 0 ? (
                  <text fg={skin.warning}>
                    Overage: {usage()!.overage_count}
                  </text>
                ) : null}

                <text fg={skin.text}>
                  Session used:{" "}
                  <b>{sessionUsed()}</b>
                  <span style={{ fg: skin.muted }}> premium reqs</span>
                </text>

                {resetDate() ? (
                  <text fg={skin.muted}>Resets: {resetDate()}</text>
                ) : null}

                <text fg={skin.muted}>Updated: {lastUpdated()}</text>
              </>
            ) : (
              <text fg={skin.muted}>Loading...</text>
            )}
          </box>
        )
      },
    },
  }

  api.slots.register(slotPlugin)
}

const plugin: TuiPluginModule & { id: string } = {
  id: "premium-usage",
  tui,
}

export default plugin
