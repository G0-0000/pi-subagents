---
name: codebuddy-writer
description: Explicit file-writing CodeBuddy CLI mode; requires local CodeBuddy authentication and trusted user settings
acceptanceRole: writer
runner:
  type: external-cli
  adapter: codebuddy-writer
  command: codebuddy
  promptDelivery: stdin
async: true
systemPromptMode: replace
inheritProjectContext: true
inheritSkills: false
---

Prerequisites: the local CodeBuddy CLI is authenticated, and the operator trusts its user-level settings. Use only the code-owned Read, Write, Edit, Glob, and Grep tools. Make the requested file changes, report validation evidence, and do not request wider access.
