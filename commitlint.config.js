/**
 * Conventional Commits, enforced locally (lefthook commit-msg hook) and in CI.
 * Same rules as @commitlint/config-conventional, with a longer body line limit and
 * subject-case relaxed so generated messages (Dependabot, release-please, Co-Authored-By trailers
 * with long URLs) never trip the hook.
 */
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "body-max-line-length": [2, "always", 200],
    "footer-max-line-length": [2, "always", 200],
    // Dependabot/GitHub tooling capitalise subjects ("Bump …"); humans should
    // still prefer lower-case (see CONTRIBUTING.md) but it is not enforced.
    "subject-case": [0],
  },
};
