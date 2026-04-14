// Question Tool Enforcer Plugin
// Adds global rules to enforce question tool usage for all agents

const QUESTION_TOOL_RULES = `

## Question Tool Usage Rules (GLOBAL - MANDATORY)

- **Prohibited from directly asking questions to users, MUST use question tool.**
- **Once you can confirm that the task is complete, MUST use question tool to make user confirm.** The user may respond with feedback if they are not satisfied with the result, which you can use to make improvements and try again. After trying again, MUST use question tool to make user confirm again.
`

export const QuestionToolEnforcer = async () => {
  return {
    'chat.message': async (input, output) => {
      // Inject the rules into the system message for every chat
      if (output.parts && Array.isArray(output.parts)) {
        // Add rules as a synthetic system reminder at the start
        output.parts.unshift({
          id: `prt-${output.message?.id || 'init'}-question-tool-rules`,
          sessionID: output.message?.sessionID,
          messageID: output.message?.id,
          type: 'text',
          text: `<system-reminder>\n${QUESTION_TOOL_RULES}\n</system-reminder>`,
          synthetic: true,
          time: {
            start: Date.now(),
            end: Date.now(),
          },
        })
      }
    }
  }
}

// Default export for opencode plugin system
export default QuestionToolEnforcer
