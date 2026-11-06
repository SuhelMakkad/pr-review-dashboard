import { z } from 'zod';

/** Review workspace state in the URL: which diff, which file, which layout. */
export const filesSearchSchema = z.object({
  mode: z.enum(['all', 'since']).optional().catch(undefined),
  file: z.string().max(1000).optional().catch(undefined),
  view: z.enum(['unified', 'split']).optional().catch(undefined),
  thread: z.string().max(200).optional().catch(undefined),
});

export type FilesSearch = z.infer<typeof filesSearchSchema>;
