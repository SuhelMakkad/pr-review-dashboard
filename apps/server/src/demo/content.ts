import { FixtureRepos } from './repo.js';

/** Fictional source files for the demo scenario. Line numbers matter where threads anchor. */

const factsTypesBase = `export type FactKind = 'category' | 'brand' | 'price';

export interface Fact {
  productId: string;
  kind: FactKind;
  value: string;
}
`;

const factsTypesNew = `export type FactKind = 'category' | 'brand' | 'price' | 'stock';

export interface Fact {
  productId: string;
  kind: FactKind;
  value: string;
  confidence: number;
  sourceId: string | null;
}
`;

const migrationReviewed = `-- 0042: product metadata
CREATE TABLE product_metadata (
  id BIGSERIAL PRIMARY KEY,
  product_id UUID NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1,
  source_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Copy existing catalog data into facts.
INSERT INTO product_metadata (product_id, kind, value)
SELECT id, 'category', unnest(tags) FROM products;

INSERT INTO product_metadata (product_id, kind, value)
SELECT id, 'brand', brand FROM products WHERE brand IS NOT NULL;

-- Backfill runs in the migration transaction.
`;

const migrationCurrent = `-- 0042: product metadata
CREATE TABLE product_metadata (
  id BIGSERIAL PRIMARY KEY,
  product_id UUID NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1,
  source_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX product_metadata_by_product_kind
  ON product_metadata (product_id, kind);

-- Existing catalog data is copied by src/facts/backfill.ts in batches,
-- outside this transaction, so large tenants are never locked.
-- See backfillFacts({ batchSize: 5000, dryRun }) for the job.
-- Backfill state is tracked per tenant to make the job resumable.
CREATE TABLE product_metadata_backfill (
  tenant_id UUID PRIMARY KEY,
  last_product_id UUID,
  finished_at TIMESTAMPTZ
);
`;

function repositoryFile(version: 'reviewed' | 'current'): string {
  const lines = [
    "import type { Pool } from 'pg';",
    "import type { Fact, FactKind } from './types';",
    '',
    'export interface FactQuery {',
    '  productId: string;',
    '  kinds?: FactKind[];',
    '  minimumConfidence?: number;',
    '}',
    '',
    'const DEFAULT_CONFIDENCE = 0.5;',
    '',
    'function toFact(row: Record<string, unknown>): Fact {',
    '  return {',
    '    productId: String(row.product_id),',
    '    kind: row.kind as FactKind,',
    '    value: String(row.value),',
    '    confidence: Number(row.confidence),',
    '    sourceId: row.source_id === null ? null : String(row.source_id),',
    '  };',
    '}',
    '',
    'export class FactRepository {',
    '  constructor(private readonly pool: Pool) {}',
    '',
    '  async insert(facts: Fact[]): Promise<number> {',
    '    if (facts.length === 0) return 0;',
    '',
    '    const values = facts.flatMap((fact) => [',
    '      fact.productId,',
    '      fact.kind,',
    '      fact.value,',
    '      fact.confidence,',
    '      fact.sourceId,',
    '    ]);',
    '    const placeholders = facts',
    '      .map((_, index) => `($${index * 5 + 1}, $${index * 5 + 2}, $${index * 5 + 3}, $${index * 5 + 4}, $${index * 5 + 5})`)',
    "      .join(', ');",
    '    const result = await this.pool.query(',
    '      `INSERT INTO product_metadata (product_id, kind, value, confidence, source_id) VALUES ${placeholders}`,',
    '      values,',
    '    );',
    '',
    '    return result.rowCount ?? 0;',
    '  }',
    '',
    '  async deleteForProduct(productId: string): Promise<void> {',
    "    await this.pool.query('DELETE FROM product_metadata WHERE product_id = $1', [productId]);",
    '  }',
    '',
    '  /**',
    '   * Facts for one product, strongest first. Filtering by kind keeps the',
    '   * catalog page fast for products with thousands of extracted facts.',
    '   */',
    '  async find(query: FactQuery): Promise<Fact[]> {',
    '    const minimum = query.minimumConfidence ?? DEFAULT_CONFIDENCE;',
    '    const kinds = query.kinds ?? null;',
    '',
    '    // Uses product_metadata_by_product_kind when kinds are given.',
    '    const parameters = [query.productId, minimum, kinds];',
    '',
    '    const result = await this.pool.query(',
    version === 'current'
      ? "      'SELECT * FROM product_metadata WHERE product_id = $1 AND confidence >= $2 AND ($3::text[] IS NULL OR kind = ANY($3)) ORDER BY confidence DESC LIMIT 500',"
      : "      'SELECT * FROM product_metadata WHERE product_id = $1 AND confidence >= $2 AND ($3::text[] IS NULL OR kind = ANY($3)) ORDER BY confidence DESC',",
    '      parameters,',
    '    );',
    '',
    '    return result.rows.map(toFact);',
    '  }',
    '}',
  ];

  if (version === 'reviewed')
    lines.splice(
      lines.indexOf('    // Uses product_metadata_by_product_kind when kinds are given.'),
      1,
      '    // TODO: index',
    );

  return `${lines.join('\n')}\n`;
}

const backfillReviewed = `import type { Pool } from 'pg';

/** Copies catalog tags and locations into product_metadata. */
export async function backfillFacts(pool: Pool): Promise<void> {
  await pool.query('BEGIN');
  await pool.query(\`INSERT INTO product_metadata (product_id, kind, value)
    SELECT id, 'category', unnest(tags) FROM products\`);
  await pool.query('COMMIT');
}
`;

const backfillCurrent = `import type { Pool } from 'pg';

export interface BackfillOptions {
  batchSize?: number;
  /** Report what would be copied without writing anything. */
  dryRun?: boolean;
}

/** Copies catalog tags and locations into product_metadata, one batch at a time. */
export async function backfillFacts(pool: Pool, options: BackfillOptions = {}): Promise<number> {
  const batchSize = options.batchSize ?? 5000;
  let after = '00000000-0000-0000-0000-000000000000';
  let copied = 0;

  for (;;) {
    const batch = await pool.query(
      'SELECT id, tags, brand FROM products WHERE id > $1 ORDER BY id LIMIT $2',
      [after, batchSize],
    );

    if (batch.rows.length === 0) return copied;

    copied += batch.rows.length;
    after = batch.rows.at(-1).id;

    if (options.dryRun) continue;

    await pool.query(\`INSERT INTO product_metadata (product_id, kind, value)
      SELECT id, 'category', unnest(tags) FROM products WHERE id = ANY($1)\`, [batch.rows.map((row) => row.id)]);
  }
}
`;

const repositoryTest = `import { describe, expect, it } from 'vitest';
import { FactRepository } from '../../src/facts/repository';
import { testPool } from '../helpers/db';

describe('FactRepository', () => {
  it('returns facts above the confidence threshold, strongest first', async () => {
    const repository = new FactRepository(await testPool());

    await repository.insert([
      { productId: 'c1', kind: 'category', value: 'TypeScript', confidence: 0.9, sourceId: null },
      { productId: 'c1', kind: 'category', value: 'COBOL', confidence: 0.2, sourceId: null },
    ]);

    expect((await repository.find({ productId: 'c1' })).map((fact) => fact.value)).toEqual(['TypeScript']);
  });
});
`;

const editorReviewed = `import { useState } from 'react';
import { validateRules, type RuleSet } from './rules';

export function CollectionFilterEditor({ initial, onSave }: { initial: RuleSet; onSave(rules: RuleSet): void }) {
  const [rules, setRules] = useState(initial);
  const errors = validateRules(rules);

  return (
    <form onSubmit={(event) => { event.preventDefault(); onSave(rules); }}>
      <h2>Collection filters</h2>
      <RuleList rules={rules} onChange={setRules} />
      {errors.length > 0 && <p role="alert">Fix {errors.length} problems before saving.</p>}
      <button disabled={errors.length > 0}>Save rules</button>
    </form>
  );
}
`;

const editorCurrent = editorReviewed
  .replace('<h2>Collection filters</h2>', '<h2>Filters for this collection</h2>')
  .replace(
    'Fix {errors.length} problems before saving.',
    '{errors.length === 1 ? "Fix 1 problem" : `Fix ${errors.length} problems`} to save these rules.',
  );

function generated(path: string, lines: number, variant: number): string {
  const extension = path.split('.').pop();
  const comment =
    extension === 'tf' || extension === 'yml' || path.endsWith('Dockerfile') ? '#' : '//';
  const body = Array.from({ length: lines }, (_, index) => {
    const n = index + 1;

    if (extension === 'tf')
      return `  setting_${n} = "${variant > 0 && n % 4 === 0 ? `updated-${n}` : `value-${n}`}"`;
    if (extension === 'yml')
      return `      - run: step-${n}${variant > 0 && n % 5 === 0 ? ' --ci' : ''}`;
    if (extension === 'css')
      return `.rule-${n} { margin: ${variant > 0 && n % 3 === 0 ? n + 2 : n}px; }`;

    return variant > 0 && n % 4 === 0
      ? `export const step${n} = (input: number) => input * ${n} + ${variant};`
      : `export const step${n} = (input: number) => input * ${n};`;
  });

  return `${comment} ${path}\n${body.join('\n')}\n`;
}

export interface DemoPullCommits {
  repository: string;
  baseOid: string;
  headOid: string;
  reviewedOid?: string;
}

/**
 * Builds commit graphs for the scenario's PRs. Hand-written content for the force-pushed (#2041)
 * and fast-forwarded (#877) PRs; generated content elsewhere.
 */
export function buildDemoRepos(
  sha: (seed: string) => string,
  pulls: (DemoPullCommits & {
    number: number;
    files: { path: string; added?: boolean; lines?: number }[];
  })[],
): FixtureRepos {
  const repos = new FixtureRepos();
  const repositories = [...new Set(pulls.map((pull) => pull.repository))];

  for (const repository of repositories) {
    const root = sha(`${repository}base0`);
    const tip = sha(`${repository}base`);
    const baseFiles: Record<string, string> = { 'README.md': `# ${repository}\n` };

    for (const pull of pulls.filter((candidate) => candidate.repository === repository)) {
      for (const file of pull.files) {
        if (!file.added) baseFiles[file.path] = generated(file.path, file.lines ?? 24, 0);
      }
    }

    if (repository === 'acme/api') baseFiles['src/facts/types.ts'] = factsTypesBase;
    if (repository === 'acme/web') {
      baseFiles['src/collections/CollectionFilterEditor.tsx'] = editorReviewed.replace(
        '<button disabled={errors.length > 0}>Save rules</button>',
        '<button>Save</button>',
      );
    }

    repos.commit(repository, root, [], baseFiles);
    repos.derive(repository, tip, root, {
      'README.md': `# ${repository}\n\nSee docs/ for setup.\n`,
    });
    repos.ref(repository, 'main', tip);
  }

  for (const pull of pulls) {
    const { repository, headOid } = pull;
    const tip = sha(`${repository}base`);

    if (pull.number === 2041 && pull.reviewedOid) {
      const reviewed = {
        'src/db/migrations/0042_product_metadata.sql': migrationReviewed,
        'src/facts/repository.ts': repositoryFile('reviewed'),
        'src/facts/backfill.ts': backfillReviewed,
        'src/facts/types.ts': factsTypesNew,
      };

      // Reviewed on the old base; force-pushed onto the new base with the fixes.
      repos.derive(repository, pull.reviewedOid, sha(`${repository}base0`), reviewed);
      repos.derive(repository, headOid, tip, {
        ...reviewed,
        'src/db/migrations/0042_product_metadata.sql': migrationCurrent,
        'src/facts/repository.ts': repositoryFile('current'),
        'src/facts/backfill.ts': backfillCurrent,
        'tests/facts/repository.test.ts': repositoryTest,
        'pnpm-lock.yaml': 'lockfileVersion: 9.0\n\npackages:\n  pg@8.13.0: {}\n',
      });
      continue;
    }

    if (pull.number === 877 && pull.reviewedOid) {
      const rules = generated('src/collections/rules.ts', 30, 1);

      repos.derive(repository, pull.reviewedOid, tip, {
        'src/collections/rules.ts': rules,
        'src/collections/CollectionFilterEditor.tsx': editorReviewed,
      });
      repos.derive(repository, headOid, pull.reviewedOid, {
        'src/collections/CollectionFilterEditor.tsx': editorCurrent,
      });
      continue;
    }

    const changes = Object.fromEntries(
      pull.files.map((file) => [
        file.path,
        generated(file.path, (file.lines ?? 24) + (file.added ? 0 : 6), 1),
      ]),
    );

    if (pull.reviewedOid && pull.reviewedOid !== headOid) {
      repos.derive(repository, pull.reviewedOid, tip, changes);
      repos.derive(repository, headOid, pull.reviewedOid, {});
    } else {
      repos.derive(repository, headOid, tip, changes);
    }
  }

  return repos;
}
