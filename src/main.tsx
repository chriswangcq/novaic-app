import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/index.css';
import { ClerkProvider } from '@clerk/react';

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
const GATEWAY_URL = import.meta.env.VITE_GATEWAY_URL || 'https://api.gradievo.com';

if (!PUBLISHABLE_KEY) {
  throw new Error('VITE_CLERK_PUBLISHABLE_KEY is not set in .env');
}

// Route all Clerk API requests through our Nginx proxy so Clerk sees a request
// from *.gradievo.com (allowed origin) instead of localhost (blocked in Production).
const CLERK_PROXY_URL = `${GATEWAY_URL}/clerk-proxy`;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ClerkProvider
      publishableKey={PUBLISHABLE_KEY}
      proxyUrl={CLERK_PROXY_URL}
      afterSignInUrl="/"
      afterSignUpUrl="/"
      afterSignOutUrl="/"
    >
      <App />
    </ClerkProvider>
  </React.StrictMode>
);
