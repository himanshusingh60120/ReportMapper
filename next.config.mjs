/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // catalog.json is read at runtime via fs; force it into the serverless function bundle.
    outputFileTracingIncludes: {
      '/api/**': ['./data/**'],
    },
  },
};

export default nextConfig;
