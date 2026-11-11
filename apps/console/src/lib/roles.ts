import type { Role } from "./api/types";

/** VIEWER < OPERATOR < ADMIN (D-roles). One table for what the screen offers and what a server action lets through. */
const RANK: Record<Role, number> = { VIEWER: 0, OPERATOR: 1, ADMIN: 2 };
export const roleAtLeast = (role: Role, min: Role): boolean => (RANK[role] ?? -1) >= RANK[min];
