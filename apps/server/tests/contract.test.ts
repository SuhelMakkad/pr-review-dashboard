import { readFileSync } from 'node:fs';
import { buildSchema, parse, validate } from 'graphql';
import { describe, expect, it } from 'vitest';
import { allDocuments } from '@/github/queries.js';

// GitHub's published schema (https://docs.github.com/public/fpt/schema.docs.graphql).
const schema = buildSchema(
  readFileSync(new URL('../../../tests/schema/github.graphql', import.meta.url), 'utf8'),
);

describe('GitHub GraphQL contract', () => {
  it.each(Object.entries(allDocuments()))(
    '%s is valid against the GitHub schema',
    (_name, document) => {
      const errors = validate(schema, parse(document)).map((error) => error.message);

      expect(errors).toEqual([]);
    },
  );
});
