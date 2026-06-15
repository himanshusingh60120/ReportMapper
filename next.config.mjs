/** @type {import('next').NextConfig} */
const nextConfig = {
  // catalog.json is read at runtime via fs; ensure it ships with the build.
  outputFileTracingIncludes: {
    '/api/**': ['./data/**'],
  },
};

export default nextConfig;
