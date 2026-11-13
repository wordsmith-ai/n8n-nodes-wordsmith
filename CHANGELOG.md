# Changelog

## 0.3.0

- The Wordsmith node adds the rest of the shared automation catalogue: find an agent; import a file from a link, create a document from text and get a file's text; translate, redact, accept all tracked changes in and merge documents; create a redline from a review; get a task's files and reply to the person who sent it; create, add documents to, run, export, find and get the answers in reports; add documents to and find repositories; search your documents and legal sources and get a legal source document; find conversations and get their messages; find users; and cancel a job.
- Wordsmith Trigger adds New task comment, Agent waiting for input, Agent input answered, Documents added to a repository, Repository indexing finished, Report run finished and Background job finished.
- Wordsmith Trigger version 3 defaults to OAuth2. Triggers saved with 0.2.0 keep their API key. A Wordsmith OAuth2 API credential connected before Wordsmith offered the webhook scopes needs **Connect my account** once more.
- Neither credential asks for a region. `https://api.wordsmith.ai` reaches every Wordsmith organisation and forwards a request to its region. **Use a Custom Host**, off by default, shows an **API Host** for calling the US region directly or a test environment, and on the OAuth2 credential an **App Host** for a test environment's sign-in page. A credential saved with 0.2.0 for the United States or a custom host keeps calling the host it called then.
- Wordsmith Trigger names its workflow when it registers a webhook endpoint, so the endpoint shows in Wordsmith Settings and counts against the limit for integrations (100 per user). An endpoint registered by 0.2.0 is replaced the next time the workflow is activated.

## 0.2.0

- Replaces 0.1.0, whose actions were ask a question, get a question and get assistants. Version 0.2.0 has the core actions of the shared Wordsmith automation catalogue: ask an agent, get an answer, upload and get files, redline, compare and convert documents, review a document, find a review, draft a document, create, update, comment on, attach files to and find tasks, and get a job.
- Wordsmith Trigger (webhook endpoints) and Wordsmith Polling Trigger.
- Two credentials: Wordsmith OAuth2 API (PKCE, recommended) and Wordsmith API (API key), picked in each node's Authentication field.
- Upgrading from 0.1.0: every Wordsmith node added with 0.1.0 stops with a message to replace it. In each workflow that has one, add the Wordsmith node again and remove the old one. A saved Wordsmith API credential keeps its key; open it and choose your region.
