/**
 * CC subscription pool settings page, node half. The empty apply exists so the
 * package holds a Loader row the client module system serves the browser half
 * for; the page itself lives behind the `./client` export and edits the
 * `llm-cc-pool` settings namespace that Host plugin owns.
 */

/** Host plugin body — no host-side behavior for this surface plugin. */
export function apply(): void {}
