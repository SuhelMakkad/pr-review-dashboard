import { describe, expect, it } from 'vitest';
import { extractTickets } from '../shared/tickets';

const ids = (
  pr: { headRefName?: string; title?: string; body?: string },
  keys: string[] | null = null,
) =>
  extractTickets({ headRefName: '', title: '', body: '', ...pr }, keys).map(
    (ticket) => `${ticket.identifier}:${ticket.source}`,
  );

describe('ticket extraction', () => {
  it('reads the team convention from branches and titles', () => {
    expect(
      ids({
        headRefName: 'fix/APP-123/save-preferences',
        title: 'fix(APP-123): Save dashboard preferences',
      }),
    ).toEqual(['APP-123:branch']);
    expect(ids({ headRefName: 'feat/demo-101-product-metadata' })).toEqual(['DEMO-101:branch']);
    expect(ids({ title: '[ENG-12] Speed up search' })).toEqual(['ENG-12:title']);
    expect(ids({ title: 'ENG-12: Speed up search' })).toEqual(['ENG-12:title']);
  });

  it('prefers explicit Linear links and de-duplicates', () => {
    expect(
      ids({
        headRefName: 'feat/DEMO-1/x',
        body: 'See https://linear.app/acme/issue/DEMO-1/title and https://linear.app/acme/issue/DEMO-2',
      }),
    ).toEqual(['DEMO-1:link', 'DEMO-2:link']);
  });

  it('ignores prose and look-alikes without team keys', () => {
    expect(
      ids({
        headRefName: 'notes/Q2-config-files',
        title: 'Notes Q2-7: config files sample_config_v1.json',
      }),
    ).toEqual([]);
    expect(
      ids({
        headRefName: 'fix/163-calendar-settings',
        title: 'Use UTF-8 and SHA-256 everywhere',
      }),
    ).toEqual([]);
    expect(ids({ headRefName: 'release-2026/notes' })).toEqual([]);
    expect(ids({ headRefName: 'hotfix/issue-45-login' })).toEqual([]);
  });

  it('accepts any mention of known teams, and nothing else', () => {
    expect(
      ids({ title: 'Notes Q2-7 follow-up for APP-124', body: 'Also touches APP-125.' }, ['APP']),
    ).toEqual(['APP-124:title', 'APP-125:body']);
    expect(ids({ headRefName: 'release-2026/notes' }, ['APP'])).toEqual([]);
  });
});
