import { describe, expect, test } from "bun:test"

import type { AnthropicMessagesPayload } from "../src/routes/messages/anthropic-types"

import {
  isCompactRequest,
  isPostCompactionContinue,
  mergeToolResultForClaude,
  prepareMessagesApiPayload,
  stripToolReferenceTurnBoundary,
} from "../src/routes/messages/preprocess"

describe("mergeToolResultForClaude", () => {
  test("removes tool reference turn boundaries before merging", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: [
                {
                  type: "tool_reference",
                  tool_name: "AskUserQuestion",
                },
              ],
            },
            {
              type: "text",
              text: "Tool loaded.",
            },
          ],
        },
      ],
    }

    stripToolReferenceTurnBoundary(payload)
    mergeToolResultForClaude(payload)

    expect(payload.messages[0]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          content: [
            {
              type: "tool_reference",
              tool_name: "AskUserQuestion",
            },
          ],
        },
      ],
    })
  })

  test("keeps Tool loaded text when the message has no tool_reference", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "Launching skill: foo",
            },
            {
              type: "text",
              text: "Tool loaded.",
            },
          ],
        },
      ],
    }

    stripToolReferenceTurnBoundary(payload)

    expect(payload.messages[0]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          content: "Launching skill: foo",
        },
        {
          type: "text",
          text: "Tool loaded.",
        },
      ],
    })
  })

  test("merges text blocks into matching tool_result blocks", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "Launching skill: foo",
            },
            {
              type: "text",
              text: "Follow-up details",
            },
          ],
        },
      ],
    }

    mergeToolResultForClaude(payload)

    expect(payload.messages[0]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          content: "Launching skill: foo\n\nFollow-up details",
        },
      ],
    })
  })

  test("appends all text blocks to the last tool_result when counts differ", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "first",
            },
            {
              type: "tool_result",
              tool_use_id: "tool-2",
              content: "second",
            },
            {
              type: "text",
              text: "extra one",
            },
            {
              type: "text",
              text: "extra two",
            },
            {
              type: "text",
              text: "extra three",
            },
          ],
        },
      ],
    }

    mergeToolResultForClaude(payload)

    expect(payload.messages[0]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          content: "first",
        },
        {
          type: "tool_result",
          tool_use_id: "tool-2",
          content: "second\n\nextra one\n\nextra two\n\nextra three",
        },
      ],
    })
  })
})

describe("prepareMessagesApiPayload", () => {
  test("strips cache_control scope, filters thinking blocks, and enables adaptive thinking", () => {
    const payload: AnthropicMessagesPayload = {
      model: "gpt-5.4",
      max_tokens: 128,
      system: [
        {
          type: "text",
          text: "system prompt",
          cache_control: {
            type: "ephemeral",
            scope: "user",
          },
        } as AnthropicMessagesPayload["system"] extends Array<infer T> ? T
        : never,
      ],
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "Thinking...",
              signature: "sig-1",
            },
            {
              type: "thinking",
              thinking: "Keep this",
              signature: "sig-2",
            },
            {
              type: "thinking",
              thinking: "Drop this too",
              signature: "bad@sig",
            },
            {
              type: "text",
              text: "Visible text",
            },
          ],
        },
        {
          role: "user",
          content: "hello",
        },
      ],
    }

    prepareMessagesApiPayload(payload, {
      capabilities: {
        supports: {
          adaptive_thinking: true,
        },
      },
    } as never)

    const systemBlock = (
      payload.system as unknown as Array<Record<string, unknown>>
    )[0]
    expect(systemBlock).toEqual({
      type: "text",
      text: "system prompt",
      cache_control: {
        type: "ephemeral",
      },
    })
    expect(payload.messages[0]).toEqual({
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "Keep this",
          signature: "sig-2",
        },
        {
          type: "text",
          text: "Visible text",
        },
      ],
    })
    expect(payload.thinking).toEqual({ type: "adaptive" })
    expect(payload.output_config).toEqual({ effort: "max" })
  })

  test("does not enable adaptive thinking when tool choice forces tool use", () => {
    const payload: AnthropicMessagesPayload = {
      model: "gpt-5.4",
      max_tokens: 128,
      messages: [{ role: "user", content: "hello" }],
      tool_choice: {
        type: "tool",
        name: "apply_patch",
      },
    }

    prepareMessagesApiPayload(payload, {
      capabilities: {
        supports: {
          adaptive_thinking: true,
        },
      },
    } as never)

    expect(payload.thinking).toBeUndefined()
    expect(payload.output_config).toBeUndefined()
  })
})

describe("isCompactRequest", () => {
  test("detects legacy compact request by system prompt", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      system:
        "You are a helpful AI assistant tasked with summarizing conversations for further context.",
      messages: [{ role: "user", content: "Summarize." }],
    }

    expect(isCompactRequest(payload)).toBe(true)
  })

  test("detects legacy compact request by system prompt array", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      system: [
        {
          type: "text",
          text: "You are a helpful AI assistant tasked with summarizing conversations for further context.",
        },
      ],
      messages: [{ role: "user", content: "Summarize." }],
    }

    expect(isCompactRequest(payload)).toBe(true)
  })

  test("detects legacy compact request by last message content", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.\nYour task is to create a detailed summary of the conversation so far\nPending Tasks:\n- Fix the bug",
            },
          ],
        },
      ],
    }

    expect(isCompactRequest(payload)).toBe(true)
  })

  test("detects opencode compact request by last message content", () => {
    const opencodeCompactPrompt = `Provide a detailed prompt for continuing our conversation above.
Focus on information that would be helpful for continuing the conversation, including what we did, what we're doing, which files we're working on, and what we're going to do next.
The summary that you construct will be used so that another agent can read it and continue the work.
Do not call any tools. Respond only with the summary text.
Respond in the same language as the user's messages in the conversation.

When constructing the summary, try to stick to this template:
---
## Goal

[What goal(s) is the user trying to accomplish?]

## Instructions

- [What important instructions did the user give you that are relevant]
- [If there is a plan or spec, include information about it so next agent can continue using it]

## Discoveries

[What notable things were learned during this conversation that would be useful for the next agent to know when continuing the work]

## Accomplished

[What work has been completed, what work is still in progress, and what work is left?]

## Relevant files / directories

[Construct a structured list of relevant files that have been read, edited, or created that pertain to the task at hand. If all the files in a directory are relevant, include the path to the directory.]
---`

    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [
        { role: "user", content: "Fix the authentication bug" },
        { role: "assistant", content: "I'll look into the auth module." },
        {
          role: "user",
          content: opencodeCompactPrompt,
        },
      ],
    }

    expect(isCompactRequest(payload)).toBe(true)
  })

  test("detects opencode compact request with content blocks", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Provide a detailed prompt for continuing our conversation above.\nDo not call any tools.\n## Goal\n[goals]\n## Accomplished\n[work done]\n## Relevant files / directories\n[files]",
            },
          ],
        },
      ],
    }

    expect(isCompactRequest(payload)).toBe(true)
  })

  test("ignores system-reminder blocks when detecting opencode compact", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "<system-reminder>Some reminder text</system-reminder>",
            },
            {
              type: "text",
              text: "Provide a detailed prompt for continuing our conversation above.\nDo not call any tools.\n## Goal\n[goals]\n## Accomplished\n[work done]\n## Relevant files / directories\n[files]",
            },
          ],
        },
      ],
    }

    expect(isCompactRequest(payload)).toBe(true)
  })

  test("does not detect normal user message as compact", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: "Please help me fix this bug in the authentication module.",
        },
      ],
    }

    expect(isCompactRequest(payload)).toBe(false)
  })

  test("does not detect tool result message as compact", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "Tool output here",
            },
          ],
        },
      ],
    }

    expect(isCompactRequest(payload)).toBe(false)
  })

  test("does not detect message with only some compaction markers", () => {
    // A user referencing compaction-related phrases should not trigger detection
    // unless ALL required markers are present simultaneously
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content:
            "Do not call any tools. Just explain the ## Goal section of the compaction summary.",
        },
      ],
    }

    // Missing "continuing our conversation" and other section markers
    expect(isCompactRequest(payload)).toBe(false)
  })
})

describe("isPostCompactionContinue", () => {
  test("detects standard opencode auto-continuation message", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [
        { role: "assistant", content: "Here is the compaction summary." },
        {
          role: "user",
          content:
            "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.",
        },
      ],
    }

    expect(isPostCompactionContinue(payload)).toBe(true)
  })

  test("detects overflow variant of auto-continuation", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content:
            "The previous request exceeded the provider's size limit due to large media attachments. The conversation was compacted and media files were removed from context. If the user was asking about attached images or files, explain that the attachments were too large to process and suggest they try again with smaller or fewer files.\n\nContinue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.",
        },
      ],
    }

    expect(isPostCompactionContinue(payload)).toBe(true)
  })

  test("detects older overflow variant (context window)", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content:
            "The previous request exceeded the context window. Any attached images, audio, video, PDFs, and any other non-text media files were removed from the conversation. Please inform the user that this happened and ask them to re-attach any important media files if needed. Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.",
        },
      ],
    }

    expect(isPostCompactionContinue(payload)).toBe(true)
  })

  test("detects auto-continuation in content block format", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.",
            },
          ],
        },
      ],
    }

    expect(isPostCompactionContinue(payload)).toBe(true)
  })

  test("ignores system-reminder blocks when detecting auto-continuation", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "<system-reminder>Some hook reminder</system-reminder>",
            },
            {
              type: "text",
              text: "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.",
            },
          ],
        },
      ],
    }

    expect(isPostCompactionContinue(payload)).toBe(true)
  })

  test("does not detect partial match as auto-continuation", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content:
            "Continue if you have next steps, please also fix the auth bug.",
        },
      ],
    }

    expect(isPostCompactionContinue(payload)).toBe(false)
  })

  test("does not detect normal user message as auto-continuation", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: "Please help me fix this bug in the authentication module.",
        },
      ],
    }

    expect(isPostCompactionContinue(payload)).toBe(false)
  })

  test("does not detect assistant message as auto-continuation", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [
        {
          role: "assistant",
          content:
            "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.",
        },
      ],
    }

    expect(isPostCompactionContinue(payload)).toBe(false)
  })
})
