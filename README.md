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
  The connection includes the webhook scopes Wordsmith Trigger needs, unless your role doesn't allow webhook
  endpoints. A connection made before Wordsmith offered them needs **Connect my account** once more.
- **Wordsmith API**: an API key from Wordsmith **Settings → API keys**. It starts `sk-ws-api1-` and is shown
  once. n8n checks the key with `GET /api/v1/me`.

Neither asks for a region: `https://api.wordsmith.ai` reaches every Wordsmith organisation and forwards a request
to the organisation's region. Turn on **Use a Custom Host** only to call the US region directly
(set **API Host** to `https://api.us.wordsmith.ai`) or a test environment. **Callback URL** needs an API key, because Wordsmith signs
callbacks with the key's webhook secret.

## Nodes

**Wordsmith** (usable as an AI agent tool):

| Resource | Actions |
| --- | --- |
| Agent | Ask an agent · Get an answer · Find an agent |
| File | Upload a file · Import a file from a link · Create a document from text · Get a file · Get the text of a file |
| Document | Redline · Compare · Convert · Translate · Redact · Accept all tracked changes · Merge into one PDF |
| Review | Review a document · Find a review · Create a redline from a review |
| Draft | Draft a document (from instructions, or a blueprint with one field per placeholder) |
| Task | Create · Update · Add a comment · Attach files · Find · Get the files of a task · Reply to the person who sent a task |
| Report | Create · Add documents · Run · Export · Find · Get the answers in a report |
| Repository | Add documents · Find a repository |
| Search | Search your documents · Search legal sources · Get a legal source document |
| Conversation | Find a conversation · Get the messages in a conversation |
| User | Find a user |
| Job | Get a job · Cancel a job |

Long work, such as a review, a draft, a translation, a report run or adding documents to a repository, runs as a Wordsmith job. The step waits for it, up to **Maximum
Wait** (15 minutes), or returns the job at once for a workflow that waits with a Wait node and
`{{ $execution.resumeUrl }}` as **Callback URL** (API key connections only). Each start call sends an idempotency key, so n8n's
**Retry On Fail** never starts the work twice.

**Wordsmith Trigger** starts a workflow on New task, Task assigned, Task status changed, New task comment,
Review completed, Agent waiting for input, Agent input answered, Documents added to a repository, Repository
indexing finished, Report run finished, Background job finished, or any event types you choose. It registers a
Wordsmith [webhook endpoint](https://docs.wordsmith.ai/webhook-endpoints) on activation, named after the
workflow, removes it on deactivation, and checks each request's `Wordsmith-Signature`. Each active workflow holds
one endpoint, up to 100 per user. n8n must be reachable on a public https URL.

**Wordsmith Polling Trigger** checks Wordsmith on a schedule for New task, Task status changed and Review
completed, for an n8n that Wordsmith can't reach on a public URL.

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
