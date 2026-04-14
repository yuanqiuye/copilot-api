import config from "@echristian/eslint-config"

export default config({
  ignores: ["claude-plugin/**", ".opencode/**", "plugins/**"],
  prettier: {
    plugins: ["prettier-plugin-packagejson"],
  },
})
