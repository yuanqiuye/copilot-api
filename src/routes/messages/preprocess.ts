import type { Model } from "~/services/copilot/get-models"

import { getReasoningEffortForModel } from "~/lib/config"

import type {
  AnthropicMessage,
  AnthropicMessagesPayload,
  AnthropicTextBlock,
  AnthropicToolResultBlock,
} from "./anthropic-types"

const compactSystemPromptStart =
  "You are a helpful AI assistant tasked with summarizing conversations"
const compactTextOnlyGuard =
  "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools."
const compactSummaryPromptStart =
  "Your task is to create a detailed summary of the conversation so far"
const compactMessageSections = ["Pending Tasks:", "Current Work:"] as const

// OpenCode compaction prompt markers (from opencode/src/session/compaction.ts)
const opencodeCompactNoTools = "Do not call any tools."
const opencodeCompactContinuing = "continuing our conversation"
const opencodeCompactSections = [
  "## Goal",
  "## Accomplished",
  "## Relevant files",
] as const

// OpenCode post-compaction synthetic continuation text
// (from opencode/src/session/compaction.ts – sent after compaction completes)
const opencodePostCompactContinueText =
  "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed."
// Overflow prefix — older versions used "exceeded the context window",
// current versions use "exceeded the provider's size limit".
// Match the common prefix "The previous request exceeded" for forward compat.
const opencodePostCompactOverflowPrefix = "The previous request exceeded"

export const TOOL_REFERENCE_TURN_BOUNDARY = "Tool loaded."

const getAnthropicEffortForModel = (
  model: string,
): "low" | "medium" | "high" | "max" => {
  const reasoningEffort = getReasoningEffortForModel(model)

  if (reasoningEffort === "xhigh") return "max"
  if (reasoningEffort === "none" || reasoningEffort === "minimal") return "low"

  return reasoningEffort
}

const getCompactCandidateText = (message: AnthropicMessage): string => {
  if (message.role !== "user") {
    return ""
  }

  if (typeof message.content === "string") {
    return message.content
  }

  return message.content
    .filter((block): block is AnthropicTextBlock => block.type === "text")
    .map((block) =>
      block.text.startsWith("<system-reminder>") ? "" : block.text,
    )
    .filter((text) => text.length > 0)
    .join("\n\n")
}

const isLegacyCompactMessage = (text: string): boolean => {
  return (
    text.includes(compactTextOnlyGuard)
    && text.includes(compactSummaryPromptStart)
    && compactMessageSections.some((section) => text.includes(section))
  )
}

const isOpencodeCompactMessage = (text: string): boolean => {
  return (
    text.includes(opencodeCompactNoTools)
    && text.includes(opencodeCompactContinuing)
    && opencodeCompactSections.some((section) => text.includes(section))
  )
}

const isCompactMessage = (lastMessage: AnthropicMessage): boolean => {
  const text = getCompactCandidateText(lastMessage)
  if (!text) {
    return false
  }

  return isLegacyCompactMessage(text) || isOpencodeCompactMessage(text)
}

export const isCompactRequest = (
  anthropicPayload: AnthropicMessagesPayload,
): boolean => {
  const lastMessage = anthropicPayload.messages.at(-1)
  if (lastMessage && isCompactMessage(lastMessage)) {
    return true
  }

  const system = anthropicPayload.system
  if (typeof system === "string") {
    return system.startsWith(compactSystemPromptStart)
  }
  if (!Array.isArray(system)) return false

  return system.some(
    (msg) =>
      typeof msg.text === "string"
      && msg.text.startsWith(compactSystemPromptStart),
  )
}

// Detect OpenCode's synthetic post-compaction continuation message.
// After compaction, OpenCode auto-sends a "Continue …" message that should
// not consume a premium request (equivalent to VS Code's
// X-Interaction-Type: conversation-background).
const isPostCompactionContinueMessage = (
  lastMessage: AnthropicMessage,
): boolean => {
  const text = getCompactCandidateText(lastMessage)
  if (!text) {
    return false
  }

  const trimmed = text.trim()

  // Standard auto-continuation (no overflow)
  if (trimmed === opencodePostCompactContinueText) {
    return true
  }

  // Overflow variant: overflow notice followed by the continuation text
  if (
    trimmed.startsWith(opencodePostCompactOverflowPrefix)
    && trimmed.endsWith(opencodePostCompactContinueText)
  ) {
    return true
  }

  return false
}

export const isPostCompactionContinue = (
  anthropicPayload: AnthropicMessagesPayload,
): boolean => {
  const lastMessage = anthropicPayload.messages.at(-1)
  if (!lastMessage) {
    return false
  }
  return isPostCompactionContinueMessage(lastMessage)
}

const mergeContentWithText = (
  tr: AnthropicToolResultBlock,
  textBlock: AnthropicTextBlock,
): AnthropicToolResultBlock => {
  if (typeof tr.content === "string") {
    return { ...tr, content: `${tr.content}\n\n${textBlock.text}` }
  }
  // Unable to merge, discard other text blocks, wait for the next round of re-request
  if (hasToolRef(tr)) {
    return tr
  }
  return {
    ...tr,
    content: [...tr.content, textBlock],
  }
}

const mergeContentWithTexts = (
  tr: AnthropicToolResultBlock,
  textBlocks: Array<AnthropicTextBlock>,
): AnthropicToolResultBlock => {
  if (typeof tr.content === "string") {
    const appendedTexts = textBlocks.map((tb) => tb.text).join("\n\n")
    return { ...tr, content: `${tr.content}\n\n${appendedTexts}` }
  }
  // Unable to merge, discard other text blocks, wait for the next round of re-request
  if (hasToolRef(tr)) {
    return tr
  }
  return { ...tr, content: [...tr.content, ...textBlocks] }
}

const mergeToolResult = (
  toolResults: Array<AnthropicToolResultBlock>,
  textBlocks: Array<AnthropicTextBlock>,
): Array<AnthropicToolResultBlock> => {
  if (toolResults.length === textBlocks.length) {
    return toolResults.map((tr, i) => mergeContentWithText(tr, textBlocks[i]))
  }

  const lastIndex = toolResults.length - 1
  return toolResults.map((tr, i) =>
    i === lastIndex ? mergeContentWithTexts(tr, textBlocks) : tr,
  )
}

export const stripToolReferenceTurnBoundary = (
  anthropicPayload: AnthropicMessagesPayload,
): void => {
  for (const msg of anthropicPayload.messages) {
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue

    const hasToolReference = msg.content.some(
      (block) => block.type === "tool_result" && hasToolRef(block),
    )
    if (!hasToolReference) continue

    msg.content = msg.content.filter(
      (block) =>
        block.type !== "text"
        || block.text.trim() !== TOOL_REFERENCE_TURN_BOUNDARY,
    )
  }
}

export const mergeToolResultForClaude = (
  anthropicPayload: AnthropicMessagesPayload,
): void => {
  for (const msg of anthropicPayload.messages) {
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue

    const toolResults: Array<AnthropicToolResultBlock> = []
    const textBlocks: Array<AnthropicTextBlock> = []
    let valid = true

    for (const block of msg.content) {
      if (block.type === "tool_result") {
        toolResults.push(block)
      } else if (block.type === "text") {
        textBlocks.push(block)
      } else {
        valid = false
        break
      }
    }

    if (!valid || toolResults.length === 0 || textBlocks.length === 0) continue

    msg.content = mergeToolResult(toolResults, textBlocks)
  }
}

const hasToolRef = (block: AnthropicToolResultBlock) => {
  return (
    Array.isArray(block.content)
    && block.content.some((c) => c.type === "tool_reference")
  )
}

// Strip cache_control from system content blocks as the
// Copilot Messages API does not support them (rejects extra fields like scope).
// commit by nicktogo
const stripCacheControl = (payload: AnthropicMessagesPayload): void => {
  if (Array.isArray(payload.system)) {
    for (const block of payload.system) {
      const systemBlock = block as AnthropicTextBlock & {
        cache_control?: Record<string, unknown>
      }
      const cacheControl = systemBlock.cache_control
      if (cacheControl && typeof cacheControl === "object") {
        const { scope, ...rest } = cacheControl
        systemBlock.cache_control = rest
      }
    }
  }
}

// Pre-request processing: filter thinking blocks for Claude models so only
// valid thinking blocks are sent to the Copilot Messages API.
const filterAssistantThinkingBlocks = (
  payload: AnthropicMessagesPayload,
): void => {
  for (const msg of payload.messages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      msg.content = msg.content.filter((block) => {
        if (block.type !== "thinking") return true
        return (
          block.thinking
          && block.thinking !== "Thinking..."
          && block.signature
          && !block.signature.includes("@")
        )
      })
    }
  }
}

export const prepareMessagesApiPayload = (
  payload: AnthropicMessagesPayload,
  selectedModel?: Model,
): void => {
  stripCacheControl(payload)
  filterAssistantThinkingBlocks(payload)

  // https://platform.claude.com/docs/en/build-with-claude/extended-thinking#extended-thinking-with-tool-use
  // Using tool_choice: {"type": "any"} or tool_choice: {"type": "tool", "name": "..."} will result in an error because these options force tool use, which is incompatible with extended thinking.
  const toolChoice = payload.tool_choice
  const disableThink = toolChoice?.type === "any" || toolChoice?.type === "tool"

  if (selectedModel?.capabilities.supports.adaptive_thinking && !disableThink) {
    payload.thinking = {
      type: "adaptive",
    }
    payload.output_config = {
      effort: getAnthropicEffortForModel(payload.model),
    }
  }
}
