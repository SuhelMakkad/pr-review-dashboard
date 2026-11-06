import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { startLive } from '@/lib/live';
import { startNotifications } from '@/lib/notifications';
import { initTheme } from '@/lib/theme';
import { createAppRouter } from '@/router';
import '@/styles/app.css';

const client = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true } },
});
const router = createAppRouter();

initTheme();
startLive(client);
startNotifications((path) => void router.history.push(path));

// The service worker shows notifications and an offline page; it is not used during development.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
