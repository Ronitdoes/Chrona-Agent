import pino, { type Logger } from "pino";

export const logger = pino({
  level: "info",
  base: { service: "web-agent-core" },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "*.apiKey",
      "*.api_key",
      "*.token",
    ],
    censor: "[redacted]",
  },
});

export function createTurnTrace(userId: string, sessionId?: string): Logger {
  return logger.child({ userId, sessionId });
}