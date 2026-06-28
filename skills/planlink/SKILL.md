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

1. Write the HTML file locally.
2. Run:

   ```sh
   bunx planlink upload <file path>
   ```

3. Return the PlanLink URL to the user.

If the same local file was uploaded before, the CLI updates the existing draft and creates a new PlanLink version. To force a new draft, use:

```sh
bunx planlink upload <file path> --new
```

PlanLink stores CLI auth and draft mappings in `~/.planlink`.

## Draft Cleanup

Use authenticated draft management when a user asks to list or remove PlanLink drafts:

```sh
bunx planlink drafts list
bunx planlink drafts delete <draft-id> --yes
bunx planlink drafts delete-all --yes
```

These commands require a configured API key and only affect drafts owned by that key's account.

## Viewer Behavior

Public PlanLink URLs show the draft inside a sandboxed viewer. Signed-out viewers see a persistent PlanLink banner outside the uploaded document.

Each draft also includes a bottom review panel. Viewers can switch between versions, read saved questions and answers, and copy an AI-ready prompt for any question. Owners can unlock the panel with a PlanLink API key, add questions, and save plain-text answers against the selected version.
