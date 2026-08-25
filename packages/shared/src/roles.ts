export const ROLES = ["admin", "user"] as const;

export type Role = (typeof ROLES)[number];
