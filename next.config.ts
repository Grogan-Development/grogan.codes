import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@daytona/sdk", "@anthropic-ai/claude-agent-sdk"],
};

export default nextConfig;
