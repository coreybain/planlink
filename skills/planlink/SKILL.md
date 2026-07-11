---
name: planlink
description: Create a safe static HTML draft and upload it to PlanLink.
---

# PlanLink

Use this skill when a user asks for a plan, proposal, brief, architecture note, or similar artifact as a shareable HTML draft.

## Document Rules

Create one complete static HTML document.

Allowed:

- Semantic HTML.
- Inline CSS or a `<style>` block.
- Normal document metadata such as charset, viewport, and title.
- Links to ordinary HTTPS pages.
- Images from HTTPS or data URLs when necessary.
- Static section narration in `<aside data-planlink-narration>...</aside>`.

Do not include:

- JavaScript.
- `<script>` tags.
- Inline event handlers such as `onclick`, `onload`, or `onerror`.
- `javascript:` URLs.
- Forms.
- Iframes, embeds, objects, or applets.
- Meta refresh redirects.
- Secrets, tokens, private URLs, or local filesystem paths.

## Upload Flow

Always invoke the CLI as `bunx planlink@latest` so Codex uses the newest published package instead of a cached Bun resolution.

1. Write the HTML file locally.
2. Run:

   ```sh
   bunx planlink@latest upload <file path>
   ```

3. Return the PlanLink URL to the user.

If the same local file was uploaded before, the CLI updates the existing draft and creates a new PlanLink version. To force a new draft, use:

```sh
bunx planlink@latest upload <file path> --new
```

PlanLink stores CLI auth and draft mappings in `~/.planlink`.

## Draft Cleanup

Use authenticated draft management when a user asks to list or remove PlanLink drafts:

```sh
bunx planlink@latest drafts list
bunx planlink@latest drafts delete <draft-id> --yes
bunx planlink@latest drafts delete-all --yes
```

These commands require a configured API key and only affect drafts owned by that key's account.

## Viewer Behavior

Public PlanLink URLs show a sanitized, server-rendered draft with persistent PlanLink controls. Signed-out viewers see a persistent PlanLink banner.

Each draft also includes a bottom review panel. Viewers can switch between versions, select plan text, attach named feedback, read saved questions and answers, and copy an AI-ready prompt for any thread. Owners can answer feedback, resolve or reopen threads, and mark feedback as addressed in a selected version.

## Audio Run-Throughs

When creating plans, add a listener-friendly run-through at the bottom of every major section:

```html
<aside data-planlink-narration>
  Explain the section in plain language, including the intent, key tradeoffs,
  and any important details that are easier to absorb by listening.
</aside>
```

The narration must be static HTML text, not JavaScript. PlanLink extracts these blocks and exposes Listen/Pause/Resume/Stop controls in the bottom panel through the browser's text-to-speech support.
