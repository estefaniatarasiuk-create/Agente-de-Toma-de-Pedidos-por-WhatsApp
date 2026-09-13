import type { NextAuthConfig } from "next-auth";

// Config "edge-safe": sin el provider de Credentials (que necesita Prisma y
// bcrypt) para poder usarse también en el middleware. La validación real de
// email/contraseña vive en auth.ts, que extiende esta config.
export const authConfig: NextAuthConfig = {
  session: { strategy: "jwt" },
  pages: {
    signIn: "/login",
  },
  providers: [],
  callbacks: {
    jwt: ({ token, user }) => {
      if (user) {
        token.companyId = user.companyId;
        token.companyName = user.companyName;
        token.role = user.role;
      }
      return token;
    },
    session: ({ session, token }) => {
      if (session.user) {
        session.user.id = token.sub as string;
        session.user.companyId = token.companyId as string;
        session.user.companyName = token.companyName as string;
        session.user.role = token.role as string;
      }
      return session;
    },
  },
};
