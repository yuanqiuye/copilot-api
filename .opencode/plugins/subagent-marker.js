const MARKER_PREFIX = "__SUBAGENT_MARKER__"
const OMO_INTERNAL_INITIATOR = "<!-- OMO_INTERNAL_INITIATOR -->"

// Short continuation phrases that should not consume premium requests.
// Matched against the user's actual text content (after stripping system-reminder blocks).
const CONTINUATION_PHRASES = new Set([
  "continue",
  "繼續",
  "继续",
  "go on",
  "keep going",
  "proceed",
  "go ahead",
  "next",
  "ok",
  "okay",
  "yes",
  "y",
])

const subagentSessions = new Set()
const markedSessions = new Set()
const sessionParentMap = new Map()
// Per-session flag: set by chat.message when OMO_INTERNAL_INITIATOR is detected
// or when the user message is a short continuation phrase,
// consumed by chat.headers to set x-omo-initiator header on the same request.
const omoAgentSessions = new Set()

const getSessionInfo = (event) => {
  if (!event || typeof event !== "object") return undefined
  const properties = event.properties
  if (!properties || typeof properties !== "object") return undefined
  const info = properties.info
  if (!info || typeof info !== "object") return undefined
  return info
}

export const SubagentMarkerPlugin = async () => {
  return {
    event: async ({ event }) => {
      if (event.type === "session.created") {
        const info = getSessionInfo(event)
        if (info?.id) {
          if (info.parentID) {
            subagentSessions.add(info.id)
            sessionParentMap.set(info.id, info.parentID)
          } else {
            sessionParentMap.set(info.id, info.id)
          }
        }
        return
      }

      if (event.type === "session.deleted") {
        const info = getSessionInfo(event)
        if (info?.id) {
          subagentSessions.delete(info.id)
          markedSessions.delete(info.id)
          sessionParentMap.delete(info.id)
        }
      }
    },
    "chat.message": async (input, output) => {
      const { sessionID } = input

      // Detect OhMyOpenCode internal initiator marker in message parts.
      // When present, the message is agent-framework-initiated (not user),
      // so we flag the session for the upcoming chat.headers hook.
      const hasOmoMarker = output.parts.some(
        (p) =>
          p.type === "text" &&
          typeof p.text === "string" &&
          p.text.includes(OMO_INTERNAL_INITIATOR),
      )
      if (hasOmoMarker) {
        omoAgentSessions.add(sessionID)
      }

      // Detect short continuation phrases (e.g. "continue", "繼續").
      // These are user-typed but semantically equivalent to "keep going" and
      // should not consume premium requests.
      if (!hasOmoMarker) {
        const userTexts = output.parts
          .filter(
            (p) =>
              p.type === "text" &&
              typeof p.text === "string" &&
              !p.text.includes("<system-reminder>"),
          )
          .map((p) => p.text.trim().toLowerCase())
        const isContinuation =
          userTexts.length > 0 &&
          userTexts.every((t) => CONTINUATION_PHRASES.has(t))
        if (isContinuation) {
          omoAgentSessions.add(sessionID)
        }
      }

      if (!subagentSessions.has(sessionID) || markedSessions.has(sessionID)) {
        return
      }
      if (!output.message?.id || !output.message?.sessionID) {
        return
      }

      const marker = `${MARKER_PREFIX}${JSON.stringify({
        session_id: sessionID,
        agent_id: sessionID,
        agent_type: input.agent ?? "opencode-subagent",
      })}`

      output.parts.unshift({
        id: `prt-${output.message.id}-subagent-marker`,
        sessionID: output.message.sessionID,
        messageID: output.message.id,
        type: "text",
        text: `<system-reminder>\nSubagentStart hook additional context: ${marker}\n</system-reminder>`,
        synthetic: true,
        time: {
          start: Date.now(),
          end: Date.now(),
        },
      })
      markedSessions.add(sessionID)
    },
    "chat.headers": async (input, output) => {
      const { sessionID } = input
      const sessionIdValue = sessionParentMap.get(sessionID)
      if (sessionIdValue) {
        output.headers["x-session-id"] = sessionIdValue
      }
      // Set agent initiator header when OMO_INTERNAL_INITIATOR was detected
      // in the preceding chat.message hook for this session.
      if (omoAgentSessions.has(sessionID)) {
        output.headers["x-omo-initiator"] = "agent"
        omoAgentSessions.delete(sessionID)
      }
    },
  }
}
