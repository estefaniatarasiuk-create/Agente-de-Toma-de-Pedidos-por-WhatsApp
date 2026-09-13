import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface User {
    companyId: string;
    companyName: string;
    role: string;
  }

  interface Session {
    user: {
      id: string;
      companyId: string;
      companyName: string;
      role: string;
    } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    companyId: string;
    companyName: string;
    role: string;
  }
}
