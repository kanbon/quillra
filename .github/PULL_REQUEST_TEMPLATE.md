<!--
  Thanks for your contribution! Before you submit, please fill this in.
  For tiny fixes (typos, one-line bug fixes) you can keep it short.
-->

## Summary

<!-- One or two sentences: what does this PR change, and why? -->

## User-facing impact

<!--
  What will someone using Quillra actually notice? A new button? A bug that stops happening?
  Nothing at all (pure refactor)?
  If this touches the UI, please include a screenshot or screen recording.
-->

## Implementation notes

<!--
  Anything reviewers should know about the approach — trade-offs, alternatives you
  considered, tricky spots. Skip if it's obvious from the diff.
-->

## Testing

<!--
  How did you verify this works? "Ran yarn dev and clicked through the flow" is a
  fine answer for UI changes. For backend changes, please describe what you tested.
-->

- [ ] `yarn typecheck` passes in `packages/api`
- [ ] `yarn typecheck` passes in `packages/web`
- [ ] I tested the happy path manually
- [ ] I tested the error path(s) manually (or N/A)

## Related issues

<!-- `Fixes #123` / `Closes #456` / `Related to #789` -->

## Checklist

- [ ] My commit messages are clear and describe *why*, not just *what*.
- [ ] I scanned my diff for accidentally-committed secrets (API keys, tokens, passwords, `.env` files).
- [ ] If this adds user-facing strings, they're in `packages/web/src/i18n/dictionaries.ts` for both `en` and `de`.
- [ ] If this adds a new env var, `.env.example` and the README are updated.
- [ ] I'm submitting this work under the terms of the [FSL-1.1-MIT license](../LICENSE).
