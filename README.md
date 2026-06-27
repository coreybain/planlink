# PlanLink

PlanLink is a Bun-powered TypeScript service and CLI for publishing static HTML
drafts from agents.

The app keeps the original behavior:

- Validate static HTML locally before upload.
- Upload drafts through a CLI.
- Store draft metadata and versions in Postgres.
- Store HTML documents in S3-compatible object storage.
- Render public drafts inside a sandboxed iframe.
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
