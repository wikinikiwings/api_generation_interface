/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "standalone",
  // Линт не блокирует production-сборку. Для контейнера критична только
  // рабочая сборка; линт следует гонять отдельно в dev/CI (`npm run lint`).
  eslint: {
    ignoreDuringBuilds: true,
  },
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "cdn.wavespeed.ai" },
      { protocol: "https", hostname: "static.wavespeed.ai" },
    ],
  },
  // Allow large base64 payloads in server actions / route handlers
  experimental: {
    serverActions: {
      bodySizeLimit: "50mb",
    },
  },
};

export default nextConfig;
