# Security

The app has no login: it holds your AWS and Claude credentials and drives Claude on your instances, so it only answers requests addressed to `localhost` (see `src/middleware.ts`). Don't expose it to a network without putting your own authentication in front of it.

Secrets live in the macOS Keychain or in `.env.local`, both outside git. The SSH key the app uses is generated into `.data/ssh/`, also git-ignored.

Report vulnerabilities privately through GitHub's "Report a vulnerability" on this repo, not in public issues.
