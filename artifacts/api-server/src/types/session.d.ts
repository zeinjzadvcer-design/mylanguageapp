import "express-session";
import type { UserRole } from "@workspace/db";

declare module "express-session" {
  interface SessionData {
    userId: number;
    role: UserRole;
    name: string;
    email: string;
  }
}
