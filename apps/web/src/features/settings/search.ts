import { z } from 'zod';

/** Linear's sign-in sends the browser back with `?linear=connected` or `?linear=failed`. */
export const settingsSearchSchema = z.object({
  linear: z.enum(['connected', 'failed']).optional().catch(undefined),
});

export type SettingsSearch = z.infer<typeof settingsSearchSchema>;
