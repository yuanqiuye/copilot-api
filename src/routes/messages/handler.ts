import type { Context } from "hono"

import type { Model } from "~/services/copilot/get-models"

import { awaitApproval } from "~/lib/approval"
import { getSmallModel, isMessagesApiEnabled } from "~/lib/config"
import { createHandlerLogger, debugJson } from "~/lib/logger"
import { findEndpointModel } from "~/lib/models"
import { checkPremiumAfterRequest, trackRequest } from "~/lib/premium-tracking"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { generateRequestIdFromPayload, getRootSessionId } from "~/lib/utils"

import {
  type AnthropicMessagesPayload,
  type AnthropicTextBlock,
  type AnthropicToolResultBlock,
} from "./anthropic-types"
import {
  handleWithChatCompletions,
  handleWithMessagesApi,
  handleWithResponsesApi,
} from "./api-flows"
import {
  isAgentFrameworkText,
  isCompactRequest,
  isPostCompactionContinue,
  mergeToolResultForClaude,
  stripToolReferenceTurnBoundary,
} from "./preprocess"
import { parseSubagentMarkerFromFirstUser } from "./subagent-marker"

const logger = createHandlerLogger("messages-handler")

const MAX_CONTENT_LENGTH = 3000

const SYSTEM_REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g

const collapseSystemReminders = (text: string): string =>
  text.replaceAll(SYSTEM_REMINDER_RE, (match) => {
    const inner = match.replaceAll(/<\/?system-reminder>/g, "").trim()
    const firstLine = inner.split("\n")[0].slice(0, 80)
    return `[system-reminder: ${firstLine}${inner.length > 80 ? "…" : ""}]`
  })

const summarizeToolResult = (block: AnthropicToolResultBlock): string => {
  const errorTag = block.is_error ? " ERROR" : ""
  if (typeof block.content === "string") {
    const preview = block.content.slice(0, 120)
    return `[tool_result${errorTag} ${block.tool_use_id}: ${preview}${block.content.length > 120 ? "…" : ""}]`
  }
  const textParts = block.content
    .filter((b): b is AnthropicTextBlock => b.type === "text")
    .map((b) => b.text)
    .join(" ")
  const preview = textParts.slice(0, 120)
  return `[tool_result${errorTag} ${block.tool_use_id}: ${preview}${textParts.length > 120 ? "…" : ""}]`
}

const extractLastMessageContent = (
  payload: AnthropicMessagesPayload,
): string => {
  const lastMsg = payload.messages.at(-1)
  if (!lastMsg) return ""

  if (typeof lastMsg.content === "string") {
    const collapsed = collapseSystemReminders(lastMsg.content)
    return collapsed.length > MAX_CONTENT_LENGTH ?
        collapsed.slice(0, MAX_CONTENT_LENGTH) + "..."
      : collapsed
  }

  const parts: Array<string> = []
  for (const block of lastMsg.content) {
    switch (block.type) {
      case "text": {
        parts.push(collapseSystemReminders(block.text))

        break
      }
      case "tool_result": {
        parts.push(summarizeToolResult(block))

        break
      }
      case "tool_use": {
        parts.push(
          `[tool_use: ${block.name}(${JSON.stringify(block.input).slice(0, 100)}…)]`,
        )

        break
      }
      case "thinking": {
        parts.push("[thinking]")

        break
      }
      case "image": {
        parts.push("[image]")

        break
      }
      // No default
    }
  }

  const joined = parts.join("\n")
  return joined.length > MAX_CONTENT_LENGTH ?
      joined.slice(0, MAX_CONTENT_LENGTH) + "..."
    : joined
}

const determineInitiator = (
  payload: AnthropicMessagesPayload,
  opts: {
    isBackground: boolean
    subagentMarker: ReturnType<typeof parseSubagentMarkerFromFirstUser>
    omoInitiator: string | undefined
  },
): "user" | "agent" => {
  if (opts.isBackground || opts.subagentMarker) return "agent"
  if (opts.omoInitiator === "agent") return "agent"

  const lastMessage = payload.messages.at(-1)
  if (lastMessage?.role !== "user") return "agent"

  const isInitiateRequest =
    Array.isArray(lastMessage.content) ?
      lastMessage.content.some(
        (block) =>
          block.type !== "tool_result"
          && (block.type !== "text" || !isAgentFrameworkText(block.text)),
      )
    : !isAgentFrameworkText(lastMessage.content)

  return isInitiateRequest ? "user" : "agent"
}

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
  debugJson(logger, "Anthropic request payload:", anthropicPayload)

  const subagentMarker = parseSubagentMarkerFromFirstUser(anthropicPayload)
  if (subagentMarker) {
    debugJson(logger, "Detected Subagent marker:", subagentMarker)
  }

  const sessionId = getRootSessionId(anthropicPayload, c)
  logger.debug("Extracted session ID:", sessionId)

  // claude code and opencode compact request detection
  const isCompact = isCompactRequest(anthropicPayload)
  // opencode post-compaction synthetic continuation detection
  const isBackgroundContinue = isPostCompactionContinue(anthropicPayload)
  // Combined flag: any background/non-premium request
  const isBackground = isCompact || isBackgroundContinue

  // fix claude code 2.0.28+ warmup request consume premium request, forcing small model if no tools are used
  // set "CLAUDE_CODE_SUBAGENT_MODEL": "you small model" also can avoid this
  const anthropicBeta = c.req.header("anthropic-beta")
  logger.debug("Anthropic Beta header:", anthropicBeta)
  const noTools = !anthropicPayload.tools || anthropicPayload.tools.length === 0
  if (anthropicBeta && noTools && !isBackground) {
    anthropicPayload.model = getSmallModel()
  }

  if (isBackground) {
    logger.debug("Is background request:", {
      isCompact,
      isBackgroundContinue,
    })
  } else {
    stripToolReferenceTurnBoundary(anthropicPayload)

    // Merge tool_result and text blocks into tool_result to avoid consuming premium requests
    // (caused by skill invocations, edit hooks, plan or to do reminders)
    // e.g. {"role":"user","content":[{"type":"tool_result","content":"Launching skill: xxx"},{"type":"text","text":"xxx"}]}
    // not only for claude, but also for opencode
    // compact requests are excluded from this processing
    mergeToolResultForClaude(anthropicPayload)
  }

  const requestId = generateRequestIdFromPayload(anthropicPayload, sessionId)
  logger.debug("Generated request ID:", requestId)

  // Determine effective x-initiator value (mirrors create-messages.ts logic)
  // Priority: isBackground > subagent > omoInitiator header > content-based detection
  const omoInitiator = c.req.header("x-omo-initiator")
  const initiator = determineInitiator(anthropicPayload, {
    isBackground,
    subagentMarker,
    omoInitiator,
  })

  // Track request for premium debugging
  const trackingId = trackRequest({
    model: anthropicPayload.model,
    initiator,
    isBackground,
    isCompact,
    isBackgroundContinue,
    messageCount: anthropicPayload.messages.length,
    lastMessageContent: extractLastMessageContent(anthropicPayload),
  })

  if (state.manualApprove) {
    await awaitApproval()
  }

  const selectedModel = findEndpointModel(anthropicPayload.model)
  anthropicPayload.model = selectedModel?.id ?? anthropicPayload.model

  if (shouldUseMessagesApi(selectedModel)) {
    const response = await handleWithMessagesApi(c, anthropicPayload, {
      anthropicBetaHeader: anthropicBeta,
      subagentMarker,
      selectedModel,
      requestId,
      sessionId,
      isCompact: isBackground,
      omoInitiator,
      logger,
    })
    checkPremiumAfterRequest(trackingId)
    return response
  }

  if (shouldUseResponsesApi(selectedModel)) {
    const response = await handleWithResponsesApi(c, anthropicPayload, {
      subagentMarker,
      selectedModel,
      requestId,
      sessionId,
      isCompact: isBackground,
      omoInitiator,
      logger,
    })
    checkPremiumAfterRequest(trackingId)
    return response
  }

  const response = await handleWithChatCompletions(c, anthropicPayload, {
    subagentMarker,
    requestId,
    sessionId,
    isCompact: isBackground,
    omoInitiator,
    logger,
  })
  checkPremiumAfterRequest(trackingId)
  return response
}

const RESPONSES_ENDPOINT = "/responses"
const MESSAGES_ENDPOINT = "/v1/messages"

const shouldUseResponsesApi = (selectedModel: Model | undefined): boolean => {
  return (
    selectedModel?.supported_endpoints?.includes(RESPONSES_ENDPOINT) ?? false
  )
}

const shouldUseMessagesApi = (selectedModel: Model | undefined): boolean => {
  const useMessagesApi = isMessagesApiEnabled()
  if (!useMessagesApi) {
    return false
  }
  return (
    selectedModel?.supported_endpoints?.includes(MESSAGES_ENDPOINT) ?? false
  )
}
