/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,

  // ✅ Allows importing files from outside /apps/web (like /packages/core)
  experimental: {
    externalDir: true,
  },

  // (You can keep this, but since you’re currently using relative imports from packages/core/src,
  // it’s not required. Leaving it doesn't hurt.)
  transpilePackages: ["@docu-lea/core"],

  webpack: (cfg) => {
    cfg.experiments = { ...(cfg.experiments || {}), asyncWebAssembly: true };
    return cfg;
  },
};

export default config;

