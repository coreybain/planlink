# PlanLink

PlanLink is a Bun-powered TypeScript service and CLI for publishing static HTML
drafts from agents.

The app keeps the original behavior:

- Validate static HTML locally before upload.
- Upload drafts through a CLI.
- Store draft metadata and versions in Postgres.
- Store HTML documents in S3-compatible object storage.
- Sanitize and server-render public drafts without nested browsing contexts.
- Show draft versions and anchored review feedback in a persistent review panel.
- Read section run-throughs aloud in Chrome with browser-native text-to-speech.
- Support optional API keys for admin and authenticated ownership flows.

## CLI

Install dependencies:

```sh
bun install
```

Build the project, then run the CLI:

```sh
bun run build
bun dist/bin/planlink.js upload ./plan.html
```

During development you can run the TypeScript CLI directly with Bun:

```sh
bun run cli upload ./plan.html --api-url http://localhost:3000
```

Set optional credentials:

```sh
bun run cli auth set <api-key> --api-url http://localhost:3000
```

The CLI stores optional credentials and draft mappings in `~/.planlink`.

Once published, the package can also be run directly:

```sh
bunx planlink upload ./plan.html
```

By default the CLI uploads to `https://planlink.spiritdevs.com`. Use `--api-url`
or `PLANLINK_API_URL` to point the CLI at another PlanLink deployment.

Manage drafts uploaded with the configured API key:

```sh
bunx planlink drafts list
bunx planlink drafts delete <draft-id> --yes
bunx planlink drafts delete-all --yes
```

Draft management requires `planlink auth set <api-key>` and only applies to
drafts owned by that key's account.

## Review feedback

Every public draft includes a bottom review panel. Viewers can switch between
saved plan versions, select plan text, attach named feedback to that selection,
read questions and answers, and copy an AI-ready prompt for any thread.

Owner mode can answer feedback, resolve or reopen threads, and mark feedback as
addressed in a selected plan version. Re-uploading the same local HTML file
updates the existing draft and creates a new version; use `--new` when you want
a separate draft instead.

## Audio Run-Throughs

PlanLink extracts narrated section notes from static HTML and exposes them in
the bottom panel. In Chrome, the panel can read the selected section aloud using
the browser's built-in `speechSynthesis` API.

For best results, add an `aside` at the bottom of each plan section:

```html
<aside data-planlink-narration>
  A detailed listener-friendly explanation of this section.
</aside>
```

If a draft does not include explicit narration blocks, PlanLink falls back to
the visible heading text and section body.

## Service

Required service variables:

- `DATABASE_URL`
- `PLANLINK_BOOTSTRAP_API_KEY`
- `AWS_ENDPOINT_URL`
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `AWS_S3_BUCKET_NAME`
- `AWS_DEFAULT_REGION`

Optional service variables:

- `PORT`
- `PLANLINK_PUBLIC_BASE_URL`
- `MAX_HTML_BYTES`
- `UPLOAD_BODY_LIMIT`
- `UPLOAD_IP_RATE_LIMIT_WINDOW_MS`
- `UPLOAD_IP_RATE_LIMIT_MAX`
- `UPLOAD_RATE_LIMIT_WINDOW_MS`
- `UPLOAD_RATE_LIMIT_MAX`
- `AWS_S3_FORCE_PATH_STYLE`

Run the service:

```sh
bun run build
bun start
```

Development mode:

```sh
bun run dev
```

## Railway

PlanLink is ready for Railway using the included `railway.json` and
`nixpacks.toml` files. The service still needs Railway Postgres and a Railway
Storage Bucket wired through the required environment variables above.

## Scripts

```sh
bun run build
bun run typecheck
bun test
```

## Original Source

The npm tarball used for this port is kept under `downloads/` for reference.
The new TypeScript implementation lives in `src/` and is the app code intended
for ongoing Git-based development.

## Credits

PlanLink is based on the original [postplan npm package](https://www.npmjs.com/package/postplan) by [Theo](https://github.com/t3dotgg).
