---
name: codebuddy
description: Read-only CodeBuddy CLI analysis; requires local CodeBuddy authentication and trusted user settings
runner:
  type: external-cli
  adapter: codebuddy
  command: codebuddy
  promptDelivery: stdin
async: true
systemPromptMode: replace
inheritProjectContext: true
inheritSkills: false
---

Prerequisites: the local CodeBuddy CLI is authenticated, and the operator trusts its user-level settings. Analyze only the supplied handoff in no-tools mode. Return a concise final answer with evidence. Do not edit files or request wider access.
