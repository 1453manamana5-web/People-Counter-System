import type {Plugin} from 'vite';

/** Build-only: development keeps Vite's local refresh/WebSocket behavior. */
export function productionBrowserPolicy(): Plugin {
  const authDomain = 'people-counter-system-aed75.firebaseapp.com';
  return {
    name: 'production-browser-security',
    apply: 'build',
    transformIndexHtml: {
      order: 'pre',
      handler(_html,context) {
        const luxnora=context.path.endsWith("/counter-management/index.html");
        const policy = [
          "default-src 'none'", luxnora ? "script-src 'self' 'wasm-unsafe-eval'" : "script-src 'self'", "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: blob:", "font-src 'self' data:", "media-src 'self' blob:",
          "worker-src 'self' blob:", "manifest-src 'self'",
          `frame-src 'self'${authDomain ? ' https://' + authDomain : ''}`,
          "connect-src 'self' https://firestore.googleapis.com https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://firebaseinstallations.googleapis.com",
          "object-src 'none'", "base-uri 'none'", "form-action 'none'",
        ].join('; ');
        return [
          {tag: 'meta', attrs: {'http-equiv': 'Content-Security-Policy', content: policy}, injectTo: 'head-prepend'},
          {tag: 'meta', attrs: {name: 'referrer', content: 'no-referrer'}, injectTo: 'head-prepend'},
        ];
      },
    },
  };
}
