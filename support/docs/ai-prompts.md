## Spry AI Prompt & Usage Library

This document defines how AI should be used to support Spry developer relations
(DevRel) and improve developer experience. All AI usage must be human-reviewed
before merging or publishing.

## Principles

1. Source-first: Always provide logs, code, or notes to AI; avoid vague prompts.
2. Human-reviewed: AI output is a draft, never final.
3. Shared prompts only: Use these templates, don’t invent your own.
4. Transparency: Mark AI-generated content in PRs or docs as “AI-assisted draft,
   human-reviewed.”

## Categories & Prompt Examples

### 1. Release Notes & Changelogs

Outcome: consistent release communication.

- Prompt:

  ```
  Summarize these commit messages into a release note for Spry v0.x.x. 
  Use sections "Added", "Changed", "Fixed".
  ```

### 2. Troubleshooting Guides

Outcome: reduce time spent solving common issues.

- Prompt:

  ```
  This is the output of ./sqlpagectl.ts dev. 
  Identify the 3 most likely issues and provide shell commands to fix them.
  ```

### 3. Documentation

Outcome: scalable, opinionated docs at all skill levels.

Beginner (Quickstart):

```
Turn this terminal session into a beginner-friendly quickstart guide. 
Include prerequisites, commands, and expected outputs.
```

Intermediate (Patterns):

```
Expand this outline of Spry’s auth pattern into a tutorial 
showing configuration, tests, and extension points.
```

Advanced (Deep Dive):

```
Write an advanced guide for Spry plugin authors. 
Explain lifecycle hooks, testing, and versioning. 
Base it on these bullet points.
```

### 4. Opinionated Docs

Outcome: shared decisions captured clearly.

- Prompt:

  ```
  Summarize this Discord thread into a one-page "Spry Opinion Doc". 
  Capture what’s easy, what’s hard, and our recommendations.
  ```

### 5. Migration (Surveilr → Spry)

Outcome: unify all new and future patterns under Spry.

- Prompt:

  ```
  Here’s a legacy surveilr pattern. 
  Rewrite it as a Spry pattern with old vs new code side-by-side 
  and a migration explanation.
  ```

### 6. Example Code Generation

Outcome: expand Spry examples library quickly.

- Prompt:

  ```
  Modify the Spry CRUD example to include role-based access control. 
  Output the complete working code.
  ```

### 7. Metrics & DX Reports

Outcome: easy-to-digest summaries of developer health.

- Prompt:

  ```
  Here are build times, coverage, and issue counts for the last 4 weeks. 
  Write a 1-paragraph DX summary with key trends and next steps.
  ```

### 8. Docs Consistency Checks

Outcome: prevent doc/code drift.

- Prompt:

  ```
  Compare this API file with the Spry docs. 
  Highlight missing or inconsistent method descriptions.
  ```
