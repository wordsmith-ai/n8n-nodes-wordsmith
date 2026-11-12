# n8n-nodes-wordsmith

n8n nodes for [Wordsmith](https://www.wordsmith.ai), the AI platform for in-house legal teams. Ask a
Wordsmith agent, review, redline, compare and draft documents, manage tasks, and start workflows when
something happens in Wordsmith. Files move as n8n binary data.

The full guide is at [docs.wordsmith.ai/n8n](https://docs.wordsmith.ai/n8n).

[Installation](#installation) · [Credentials](#credentials) · [Nodes](#nodes) · [Compatibility](#compatibility)
· [Development](#development)

## Installation

Follow n8n's [community nodes installation guide](https://docs.n8n.io/integrations/community-nodes/installation/).
On self-hosted n8n, an owner or admin opens **Settings → Community Nodes**, selects **Install**, and enters
`n8n-nodes-wordsmith`.

To let an n8n AI Agent use the Wordsmith node as a tool, set `N8N_COMMUNITY_PACKAGES_ALLOW_TOOL_USAGE=true`.

## Credentials

Each node's **Authentication** field picks one of two credentials. Either acts as the person who connects, with
their access.

- **Wordsmith OAuth2 API** (recommended): sign in to Wordsmith and approve the access. It uses PKCE and asks for
  the REST API as its resource. On n8n Cloud, keep **Register Client Automatically** on: n8n registers itself with
  Wordsmith. On self-hosted n8n, use an API key, or turn it off and enter the client of an app your Wordsmith
  admin adds under **Settings → App access → Your organisation's apps**, with n8n's **OAuth Redirect URL**.
  Wordsmith Trigger needs an API key connection for now, because an automatic registration gets no webhook scopes.
- **Wordsmith API**: an API key from Wordsmith **Settings → API keys**. It starts `sk-ws-api1-` and is shown
  once. n8n checks the key with `GET /api/v1/me`.

Both take a region: **Europe** or **United States**. **Callback URL** needs an API key, because Wordsmith signs
callbacks with the key's webhook secret.

## Nodes

**Wordsmith** (usable as an AI agent tool):

| Resource | Actions |
| --- | --- |
| Agent | Ask an agent · Get an answer |
| File | Upload a file · Get a file |
| Document | Redline a document · Compare two documents · Convert a document |
| Review | Review a document · Find a review |
| Draft | Draft a document (from instructions, or a blueprint with one field per placeholder) |
| Task | Create a task · Update a task · Add a comment to a task · Attach files to a task · Find a task |
| Job | Get a job |

Long work, such as a review or a draft, runs as a Wordsmith job. The step waits for it, up to **Maximum
Wait** (15 minutes), or returns the job at once for a workflow that waits with a Wait node and
`{{ $execution.resumeUrl }}` as **Callback URL** (API key connections only). Each start call sends an idempotency key, so n8n's
**Retry On Fail** never starts the work twice.

**Wordsmith Trigger** starts a workflow on New task, Task assigned, Task status changed, Review completed,
or any event types you choose. It registers a Wordsmith
[webhook endpoint](https://docs.wordsmith.ai/webhook-endpoints) on activation, removes it on deactivation,
and checks each request's `Wordsmith-Signature`. n8n must be reachable on a public https URL.

**Wordsmith Polling Trigger** checks Wordsmith on a schedule for New task, Task status changed and Review
completed, for organisations where instant triggers aren't on yet.

## Compatibility

Built with `@n8n/node-cli` 0.56 and `n8n-workflow` 2.16, and tested on n8n 2.47. The package has no
runtime dependencies.

## Development

```bash
pnpm install
pnpm run lint   # n8n's community-node rules
pnpm test       # builds, then runs the unit tests in test/
pnpm run dev    # starts n8n on http://localhost:5678 with these nodes loaded
```

The source lives in the Wordsmith monorepo under `n8n/wordsmith/` and is mirrored to the public repository
that npm links to. Releases are published from that repository by `.github/workflows/publish.yml`, with npm
provenance, as n8n requires for verified nodes.

## License

[MIT](LICENSE.md)
