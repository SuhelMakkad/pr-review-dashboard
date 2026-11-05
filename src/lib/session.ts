const meta = (name: string) =>
  typeof document === 'undefined'
    ? ''
    : (document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content ?? '');

/** Per-launch values the server injects into index.html. */
export const session = {
  token: () => meta('review-desk-session'),
  bootId: () => meta('review-desk-boot'),
  demo: () => meta('review-desk-demo') === '1',
};
