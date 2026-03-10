import jwt from "jsonwebtoken";
import type { JwtPayload, SignOptions } from "jsonwebtoken";
import type { AgentTokenClaims } from "./types";

export interface AccessTokenOptions {
  expiresIn?: SignOptions["expiresIn"];
}

export function signAccessToken(
  claims: AgentTokenClaims,
  secret: string,
  options: AccessTokenOptions = {}
): string {
  const signOptions: SignOptions = {
    expiresIn: options.expiresIn ?? "10m"
  };

  return jwt.sign(claims, secret, {
    ...signOptions
  });
}

export function verifyAccessToken(token: string, secret: string): AgentTokenClaims {
  const decoded = jwt.verify(token, secret);
  if (!decoded || typeof decoded !== "object") {
    throw new Error("Invalid token payload");
  }

  const payload = decoded as JwtPayload;
  const sub = payload["sub"];
  const botRole = payload["bot_role"];

  if (typeof sub !== "string" || typeof botRole !== "string") {
    throw new Error("Token missing required claims");
  }

  const scopes = Array.isArray(payload["scopes"])
    ? payload["scopes"].filter((scope): scope is string => typeof scope === "string")
    : undefined;
  if (scopes) {
    return {
      sub,
      bot_role: botRole,
      scopes
    };
  }
  return {
    sub,
    bot_role: botRole
  };
}
