import type React from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/ui/cn';

const safeHref = (href?: string) => (href && /^(https?:|mailto:|#)/i.test(href) ? href : undefined);

/** Headings inside user content sit below the page's own h1/h2 so the outline stays meaningful. */
const demoted = {
  h1: ({ children }: { children?: React.ReactNode }) => <h4 className="md-h1">{children}</h4>,
  h2: ({ children }: { children?: React.ReactNode }) => <h4 className="md-h2">{children}</h4>,
  h3: ({ children }: { children?: React.ReactNode }) => <h5 className="md-h3">{children}</h5>,
  h4: ({ children }: { children?: React.ReactNode }) => <h6 className="md-h4">{children}</h6>,
  h5: ({ children }: { children?: React.ReactNode }) => <h6 className="md-h4">{children}</h6>,
  h6: ({ children }: { children?: React.ReactNode }) => <h6 className="md-h4">{children}</h6>,
};

/**
 * Renders untrusted GitHub Markdown: raw HTML is skipped, remote images are never loaded, and only
 * http(s), mailto and in-page links are kept.
 */
export function MarkdownView({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn('markdown', className)}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          ...demoted,
          a: ({ children: content, href }) => {
            const target = safeHref(href);

            return target ? (
              <a href={target} target="_blank" rel="noopener noreferrer">
                {content}
              </a>
            ) : (
              <span>{content}</span>
            );
          },
          img: ({ alt }) => (
            <span className="image-placeholder">[Image: {alt || 'view on GitHub'}]</span>
          ),
        }}
      >
        {children}
      </Markdown>
    </div>
  );
}
