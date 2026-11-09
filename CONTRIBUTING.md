# Contributing to ForgeFlow CLI

Thanks for helping make long coding workflows easier to inspect and recover.

## Start here

Read the README and inspect the roadmap. Before a large change, open an issue describing the problem, proposed behavior, and tradeoffs. Small documentation fixes can go straight to a pull request.

## Local setup

```sh
git clone https://github.com/rvnsre/forgeflow-cli.git
cd forgeflow-cli
node ./bin/forgeflow.mjs --help
npm run check
node ./bin/forgeflow.mjs doctor
```

Node.js 20+ is required. Core CLI development needs no third-party packages. Browser development additionally requires Playwright and Chromium as described in the README. Live provider calls require your own authorized API key and may incur usage charges.

## Report a bug

Open an issue with:

- The expected result and actual result.
- A small reproduction and the exact command, with secrets removed.
- OS, Node.js version, ForgeFlow version, and provider/model identifiers.
- Relevant redacted output from state.json or events.jsonl.
- Whether the failure reproduces with one worker and a small task.

Never post API keys, tokens, private source code, cookies, or unredacted credentials. Use synthetic examples when possible.

## Propose a feature

Describe the user problem, a concrete workflow, and how success could be checked. Explain how it affects file scope isolation, checkpoints, token usage, and cross-platform behavior. Keep unrelated changes separate.

## Pull requests

Use a focused branch. Explain the problem, resulting behavior, and validation in the PR description. Preserve the ESM module style and avoid adding dependencies unless they materially simplify the implementation. Keep defaults conservative and errors actionable.

Run the syntax check for JavaScript changes. For behavior changes, include a meaningful reproduction or targeted validation. State which operating systems and provider/browser workflows you actually exercised. Do not describe untested combinations as verified.

All contributions are made under the repository's MIT license. Communicate respectfully and focus feedback on the work.
