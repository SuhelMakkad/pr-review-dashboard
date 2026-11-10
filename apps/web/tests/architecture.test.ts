import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { duration, ease, skeletonDelay } from '@/ui/motion/tokens';

const src = fileURLToPath(new URL('../src', import.meta.url));

const sources = readdirSync(src, { recursive: true, encoding: 'utf8' })
  .filter((file) => /\.(ts|tsx)$/.test(file))
  .map((file) => ({
    path: relative(src, join(src, file)).split(sep).join('/'),
    text: readFileSync(join(src, file), 'utf8'),
  }));

const importsMotionLibrary = (text: string) =>
  /from '(motion|motion\/react|framer-motion)'/.test(text);
const importsMotionLayer = (text: string) =>
  importsMotionLibrary(text) || text.includes("'@/ui/motion'");

describe('motion layer boundaries', () => {
  it('keeps the motion library behind src/ui', () => {
    const leaks = sources
      .filter((file) => !file.path.startsWith('ui/') && importsMotionLibrary(file.text))
      .map((file) => file.path);

    expect(leaks).toEqual([]);
  });

  it('keeps Motion components inside the primitives', () => {
    const rawComponents = sources
      .filter((file) => !file.path.startsWith('ui/') && /<m\.\w+/.test(file.text))
      .map((file) => file.path);

    expect(rawComponents).toEqual([]);
  });

  it('renders the lightweight m.* components only', () => {
    const fullComponents = sources
      .filter(
        (file) =>
          /import\s*{[^}]*\bmotion\b[^}]*}\s*from\s*'motion\/react'/.test(file.text) ||
          /<motion\.\w+/.test(file.text),
      )
      .map((file) => file.path);

    expect(fullComponents).toEqual([]);
  });

  it('takes every duration, delay, easing and spring from the tokens', () => {
    const literal = /\b(duration|delay|stiffness|damping|bounce|mass)\s*:\s*\d|\bease\s*:\s*\[/;
    const offenders = sources
      .filter((file) => file.path !== 'ui/motion/tokens.ts' && importsMotionLayer(file.text))
      .filter((file) => literal.test(file.text))
      .map((file) => file.path);

    expect(offenders).toEqual([]);
  });
});

describe('motion tokens', () => {
  const css = readFileSync(join(src, 'styles/app.css'), 'utf8');
  const cssVar = (name: string) => new RegExp(`--${name}:\\s*([^;]+);`).exec(css)?.[1]?.trim();
  const bezier = (curve: readonly number[]) => `cubic-bezier(${curve.join(', ')})`;

  it('mirrors the TypeScript tokens in CSS', () => {
    expect(cssVar('motion-fast')).toBe(`${duration.fast * 1000}ms`);
    expect(cssVar('motion-base')).toBe(`${duration.base * 1000}ms`);
    expect(cssVar('motion-slow')).toBe(`${duration.slow * 1000}ms`);
    expect(cssVar('motion-ease')).toBe(bezier(ease.standard));
    expect(cssVar('motion-ease-exit')).toBe(bezier(ease.exit));
    expect(cssVar('motion-skeleton-delay')).toBe(`${skeletonDelay * 1000}ms`);
  });
});
