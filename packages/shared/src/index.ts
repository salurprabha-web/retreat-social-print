import { z } from "zod";

export const ROLES = ["super_admin", "event_manager", "print_operator", "reporting_viewer"] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  "event:create", "event:view", "event:edit", "event:delete",
  "builder:edit", "print:operate", "report:view", "users:manage",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Single source of truth for who may do what. The API enforces it; the UI only hides buttons. */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  super_admin: PERMISSIONS,
  event_manager: ["event:view", "event:edit", "builder:edit", "print:operate", "report:view"],
  print_operator: ["event:view", "print:operate"],
  reporting_viewer: ["event:view", "report:view"],
};

export const roleHas = (role: Role, perm: Permission) => ROLE_PERMISSIONS[role].includes(perm);

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().min(1).max(200),
});

export * from "./page";
export * from "./templates";
export * from "./photo";
export * from "./frame";
export * from "./share";
export * from "./print";
export * from "./wall";
export * from "./sponsor";
export * from "./mosaic";
export * from "./offline";
export * from "./reports";
