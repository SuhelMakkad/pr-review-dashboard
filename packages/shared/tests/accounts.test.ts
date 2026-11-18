import { describe, expect, it } from 'vitest';
import {
  accountHandle,
  forForge,
  forgeTerms,
  fullRef,
  gitlabAccountKey,
  instanceUrl,
  isSameUser,
  parseAccount,
  pullPath,
  shortRef,
} from '@/accounts.js';
import { mentionPattern } from '@/attention.js';

describe('account keys', () => {
  it('tells GitHub logins from GitLab accounts on any host', () => {
    expect(parseAccount('octocat')).toEqual({
      forge: 'github',
      handle: 'octocat',
      host: 'github.com',
    });
    expect(parseAccount(gitlabAccountKey('rev', 'git.example.com:8443'))).toEqual({
      forge: 'gitlab',
      handle: 'rev',
      host: 'git.example.com:8443',
    });
    expect(accountHandle('rev@gitlab.com')).toBe('rev');
    expect(forgeTerms('rev@gitlab.com')).toMatchObject({ name: 'GitLab', short: 'MR' });
    expect(forgeTerms(null)).toMatchObject({ name: 'GitHub', short: 'PR' });
  });

  it('matches people on a PR against the account by username, ignoring case', () => {
    expect(isSameUser('Rev', 'rev@gitlab.com')).toBe(true);
    expect(isSameUser('rev', 'octocat')).toBe(false);
    expect(mentionPattern('rev@gitlab.com').test('Thanks @rev.')).toBe(true);
    expect(mentionPattern('rev@gitlab.com').test('mail rev@gitlab.com')).toBe(false);
  });
});

describe('forge wording and references', () => {
  const mr = {
    repository: 'team/sub/web',
    number: 12,
    url: 'https://git.example.com/team/sub/web/-/merge_requests/12',
  };

  it('writes GitLab references with ! and GitHub ones with #', () => {
    expect(fullRef(mr)).toBe('team/sub/web!12');
    expect(shortRef(mr)).toBe('web!12');
    expect(
      shortRef({ repository: 'acme/api', number: 3, url: 'https://github.com/acme/api/pull/3' }),
    ).toBe('api#3');
  });

  it('rewords GitHub messages for GitLab accounts only', () => {
    const text = 'Check GitHub: the pull request may already be posted.';

    expect(forForge(text, 'rev@git.example.com')).toBe(
      'Check GitLab: the merge request may already be posted.',
    );
    expect(forForge(text, 'octocat')).toBe(text);
  });

  it('finds the instance address, relative root included, from a profile address', () => {
    expect(instanceUrl('https://example.com/gitlab/rev')).toBe('https://example.com/gitlab');
    expect(instanceUrl('http://git.example.com:8080/rev/')).toBe('http://git.example.com:8080');
    expect(instanceUrl(undefined)).toBeNull();
  });
});

describe('app paths', () => {
  it('encodes a nested GitLab namespace as one segment, as the router does', () => {
    expect(pullPath('inbox/attention', { repository: 'team/sub/web', number: 12 })).toBe(
      '/inbox/attention/team%2Fsub/web/12',
    );
    expect(pullPath('mine', { repository: 'acme/api', number: 3 })).toBe('/mine/acme/api/3');
  });
});
