# Changelog

## 0.2.0

- Replaces 0.1.0, whose actions were ask a question, get a question and get assistants. Version 0.2.0 has the core actions of the shared Wordsmith automation catalogue: ask an agent, get an answer, upload and get files, redline, compare and convert documents, review a document, find a review, draft a document, create, update, comment on, attach files to and find tasks, and get a job.
- Wordsmith Trigger (webhook endpoints) and Wordsmith Polling Trigger.
- Two credentials: Wordsmith OAuth2 API (PKCE, recommended) and Wordsmith API (API key), picked in each node's Authentication field.
- Upgrading from 0.1.0: every Wordsmith node added with 0.1.0 stops with a message to replace it. In each workflow that has one, add the Wordsmith node again and remove the old one. A saved Wordsmith API credential keeps its key; open it and choose your region.
