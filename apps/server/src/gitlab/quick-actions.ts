/**
 * GitLab runs a quick action (`/merge`, `/close`, `/assign @someone`) written at the start of a
 * line outside a code block, with the permissions of whoever posts the note. Text Review Desk posts
 * on its own, such as an automatic AI review, must never act: each such slash becomes `&#47;`,
 * which GitLab's Markdown shows as `/` but its quick-action parser does not read. Code blocks are
 * left as they are; GitLab ignores commands there, and entities would show literally.
 */
export function withoutQuickActions(text: string): string {
  let fenced = false;

  return text
    .split('\n')
    .map((line) => {
      if (/^\s{0,3}(```|~~~)/.test(line)) {
        fenced = !fenced;

        return line;
      }

      return fenced ? line : line.replace(/^(\s*)\//, '$1&#47;');
    })
    .join('\n');
}
