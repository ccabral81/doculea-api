/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,

  // ✅ Allows importing files from outside /apps/web (like /packages/core)
  experimental: {
    externalDir: true,
  },

  // ✅ Tells Next/SWC to transpile this workspace package (TS -> JS)
  transpilePackages: ["@docu-lea/core"],
};

export default config;
