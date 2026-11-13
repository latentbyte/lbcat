# Security Policy

LBcat is a Manifest V3 browser extension with a local CLI and daemon (`bctl`). It runs userscripts and lets coding
agents drive a signed-in browser, so it holds broad privileges. We take security reports seriously.

## Supported versions

Security fixes ship in new releases only. Only the latest release is supported. The Firefox and Zen add-on updates
itself; update the CLI with `brew upgrade lbcat`.

## Reporting a vulnerability

Do not report vulnerabilities in public GitHub issues or any other public channel.

Email hello@latentbyte.com with "LBcat security" in the subject. Include, as far as you can:

- affected version, browser, and OS
- what an attacker can do
- steps to reproduce, with a proof-of-concept userscript, page, or `bctl` command if relevant
- any suggested fix

We will acknowledge the report, keep you updated, and agree on a disclosure date with you before publishing anything.
We credit reporters unless they ask to stay anonymous.

Bugs in code inherited from ScriptCat can also affect upstream. If yours does, tell us and we will coordinate with the
ScriptCat maintainers.
