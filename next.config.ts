import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["ssh2", "@anthropic-ai/claude-agent-sdk"],
};

export default nextConfig;
