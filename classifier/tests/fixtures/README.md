These JSON fixtures are **intentionally synthetic** and are used to exercise the
classifier across a few common conversation shapes:

- pure small talk (no task intent)
- topical discussion with no tasks
- task-oriented discussion (task intent)

Guidelines:

- Do not add real user conversations or anything that looks like private logs.
- Prefer obviously fake project names (e.g. "Project NIMBUS") and generic names.
- Keep fixtures small (3-8 turns) and focused on one behavior.

Format:

- Each file is a JSON array of objects with fields like: `id`, `type`,
  `agentId`, `content`.
