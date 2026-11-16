import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  /* config options here */
  experimental: {
    agentFeedback: true,
  },
  // Explicit Node/force-dynamic API segments require the previous caching model.
  cacheComponents: false,
  partialPrefetching: false,
  // Use the existing Tailwind loader when selecting the webpack fallback.
  webpack(config) {
    const rules = config.module.rules.flatMap(
      (rule: { oneOf?: { use?: { loader?: string }[] }[] }) => rule.oneOf ?? [],
    );
    for (const rule of rules) {
      if (
        Array.isArray(rule.use) &&
        rule.use.some((entry: { loader?: string }) =>
          entry.loader?.includes("postcss-loader"),
        )
      ) {
        rule.use.push({ loader: "@tailwindcss/turbopack" });
      }
    }
    return config;
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
