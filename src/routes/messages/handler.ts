import type { Context } from "hono"

import type { Model } from "~/services/copilot/get-models"

import { awaitApproval } from "~/lib/approval"
import { getSmallModel, isMessagesApiEnabled } from "~/lib/config"
import { createHandlerLogger, debugJson } from "~/lib/logger"
import { findEndpointModel } from "~/lib/models"
import {
  checkPremiumAfterRequest,
  trackRequest,
} from "~/lib/premium-tracking"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { generateRequestIdFromPayload, getRootSessionId } from "~/lib/utils"

import {
  type AnthropicMessagesPayload,
  type AnthropicTextBlock,
} from "./anthropic-types"
import {
  handleWithChatCompletions,
  handleWithMessagesApi,
  handleWithResponsesApi,
} from "./api-flows"
import {
  isCompactRequest,
  isPostCompactionContinue,
  mergeToolResultForClaude,
  stripToolReferenceTurnBoundary,
} from "./preprocess"
import { parseSubagentMarkerFromFirstUser } from "./subagent-marker"

const logger = createHandlerLogger("messages-handler")

const MAX_CONTENT_LENGTH = 500

const extractLastUserMessageContent = (
  payload: AnthropicMessagesPayload,
): string => {
  for (let i = payload.messages.length - 1; i >= 0; i--) {
    const msg = payload.messages[i]
    if (msg.role !== "user") continue

    if (typeof msg.content === "string") {
      return msg.content.length > MAX_CONTENT_LENGTH
        ? msg.content.slice(0, MAX_CONTENT_LENGTH) + "..."
        : msg.content
    }

    const textBlocks = msg.content.filter(
      (block): block is AnthropicTextBlock => block.type === "text",
    )
    if (textBlocks.length > 0) {
      const text = textBlocks.map((b) => b.text).join("\n")
      return text.length > MAX_CONTENT_LENGTH
        ? text.slice(0, MAX_CONTENT_LENGTH) + "..."
        : text
    }
  }
  return ""
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

  let initiator: "user" | "agent" = "agent"
  if (!isBackground && !subagentMarker) {
    const lastMessage = anthropicPayload.messages.at(-1)
    if (lastMessage?.role === "user") {
      const isInitiateRequest =
        Array.isArray(lastMessage.content) ?
          lastMessage.content.some((block) => block.type !== "tool_result")
        : true
      initiator = isInitiateRequest ? "user" : "agent"
    }
  }

  const trackingId = trackRequest({
    model: anthropicPayload.model,
    initiator,
    isBackground,
    isCompact,
    isBackgroundContinue,
    messageCount: anthropicPayload.messages.length,
    lastMessageContent: extractLastUserMessageContent(anthropicPayload),
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
      logger,
    })
    void checkPremiumAfterRequest(trackingId)
    return response
  }

  if (shouldUseResponsesApi(selectedModel)) {
    const response = await handleWithResponsesApi(c, anthropicPayload, {
      subagentMarker,
      selectedModel,
      requestId,
      sessionId,
      isCompact: isBackground,
      logger,
    })
    void checkPremiumAfterRequest(trackingId)
    return response
  }

  const response = await handleWithChatCompletions(c, anthropicPayload, {
    subagentMarker,
    requestId,
    sessionId,
    isCompact: isBackground,
    logger,
  })
  void checkPremiumAfterRequest(trackingId)
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
