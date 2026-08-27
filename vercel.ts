import { CONTENT_SECURITY_POLICY } from './platform/vercel/security-headers.js';

type Surface = 'public' | 'portal';

function resolveSurface(): Surface {
  if (process.env.HHH_SURFACE === 'public' || process.env.HHH_SURFACE === 'portal') {
    return process.env.HHH_SURFACE;
  }
  const projectName = process.env.VERCEL_PROJECT_NAME ?? '';
  if (projectName.includes('api') || projectName.includes('public')) {
    return 'public';
  }
  return 'portal';
}

const surface: Surface = resolveSurface();



const apiOrigin = (process.env.HHH_FIREBASE_API_ORIGIN ?? 'https://europe-west2-hhh26-4ebd2.cloudfunctions.net/apiLondon').replace(/\/$/, '');

const portalSurface = surface === 'portal';
const CANONICAL_PUBLIC_ORIGIN = 'https://holistichealthhub.live';
// Pharmacy QR host. Cloudflare owns the live 301. These Vercel host redirects are only a backstop if hhh is re-attached to a public project. Do not add staging.thinktimeless.co.uk, and never add holistichealthhub.cc here: that host must stay attachable to a preview deployment for flicker testing.
const THINKTIMELESS_PUBLIC_HOSTS = ['hhh.thinktimeless.co.uk', 'www.hhh.thinktimeless.co.uk'] as const;

const thinktimelessPublicRedirects = THINKTIMELESS_PUBLIC_HOSTS.flatMap(host => [
  {
    source: '/',
    has: [
      { type: 'host' as const, value: host },
      { type: 'query' as const, key: 'token' },
    ],
    destination: `${CANONICAL_PUBLIC_ORIGIN}/eligibility`,
    permanent: true,
  },
  {
    source: '/eligibility',
    has: [{ type: 'host' as const, value: host }],
    destination: `${CANONICAL_PUBLIC_ORIGIN}/eligibility`,
    permanent: true,
  },
  {
    source: '/(.*)',
    has: [{ type: 'host' as const, value: host }],
    destination: `${CANONICAL_PUBLIC_ORIGIN}/$1`,
    permanent: true,
  },
]);

const securityHeaders = [
  { key: 'Content-Security-Policy', value: CONTENT_SECURITY_POLICY },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
];

export const config = {
  framework: 'vite',
  buildCommand: 'npm run build:vercel',
  outputDirectory: 'dist',
  regions: ['lhr1'],
  functions: portalSurface ? {
    'api/page-gate.ts': {
      maxDuration: 10,
      regions: ['lhr1'],
      includeFiles: '.vercel-private/**',
    },
  } : undefined,
  redirects: portalSurface ? [
    { source: '/', destination: '/login', permanent: false },
    { source: '/payment/(.*)', destination: `${CANONICAL_PUBLIC_ORIGIN}/payment/$1`, permanent: false },
    { source: '/payments/(.*)', destination: `${CANONICAL_PUBLIC_ORIGIN}/payments/$1`, permanent: false },
    { source: '/pharmacy/login', destination: '/login', permanent: true },
    { source: '/admin/login', destination: '/login', permanent: true },
    { source: '/pharmacy/reset-password', destination: '/reset-password', permanent: true },
    { source: '/admin/reset-password', destination: '/reset-password', permanent: true },
    { source: '/pharmacy/home', destination: '/pharmacy', permanent: true },
    { source: '/admin/overview', destination: '/admin', permanent: true },
  ] : [
    ...thinktimelessPublicRedirects,
    { source: '/contact', destination: '/eligibility', permanent: true },
    { source: '/general-5', destination: '/faq', permanent: true },
    { source: '/general-5-1', destination: '/privacy', permanent: true },
  ],
  rewrites: portalSurface ? [
    { source: '/login', destination: '/api/page-gate?__hhh_path=/login' },
    { source: '/reset-password', destination: '/api/page-gate?__hhh_path=/reset-password' },
    { source: '/v1/auth/(.*)', destination: `${apiOrigin}/v1/auth/$1?__hhh_surface=auto` },
    { source: '/pharmacy/v1/(.*)', destination: `${apiOrigin}/v1/$1?__hhh_surface=pharmacy` },
    { source: '/admin/v1/(.*)', destination: `${apiOrigin}/v1/$1?__hhh_surface=admin` },
    { source: '/pharmacy/v2/(.*)', destination: `${apiOrigin}/v2/$1?__hhh_surface=pharmacy` },
    { source: '/admin/v2/(.*)', destination: `${apiOrigin}/v2/$1?__hhh_surface=admin` },
    { source: '/pharmacy', destination: '/api/page-gate?__hhh_path=/pharmacy' },
    { source: '/admin', destination: '/api/page-gate?__hhh_path=/admin' },
    { source: '/pharmacy/(.*)', destination: '/api/page-gate?__hhh_path=/pharmacy/$1' },
    { source: '/admin/(.*)', destination: '/api/page-gate?__hhh_path=/admin/$1' },
    { source: '/v1/(.*)', destination: `${apiOrigin}/v1/$1` },
    { source: '/v2/(.*)', destination: `${apiOrigin}/v2/$1` },
  ] : [
    { source: '/sitemap.xml', destination: '/sitemap.xml' },
    { source: '/sitemaps.xml', destination: '/sitemaps.xml' },
    { source: '/robots.txt', destination: '/robots.txt' },
    { source: '/v1/(.*)', destination: `${apiOrigin}/v1/$1` },
    { source: '/v2/(.*)', destination: `${apiOrigin}/v2/$1` },
    { source: '/((?!sitemap\\.xml|sitemaps\\.xml|robots\\.txt).*)', destination: '/index.html' },
  ],
  headers: [
    {
      source: '/(sitemap|sitemaps).xml',
      headers: [
        ...securityHeaders,
        { key: 'Content-Type', value: 'application/xml; charset=utf-8' },
        { key: 'Cache-Control', value: 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400' },
      ],
    },
    {
      source: '/robots.txt',
      headers: [
        ...securityHeaders,
        { key: 'Content-Type', value: 'text/plain; charset=utf-8' },
        { key: 'Cache-Control', value: 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400' },
      ],
    },
    { source: '/assets/(.*)', headers: [...securityHeaders, { key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }] },
    { source: '/(.*)', headers: [...securityHeaders, { key: 'Cache-Control', value: 'private, no-store' }] },
  ],
};

