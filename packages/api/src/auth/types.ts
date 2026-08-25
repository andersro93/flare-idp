/**
 * The slice of the (Task 5) `auth` singleton that `loadSession` needs. Kept
 * as a local structural interface so Task 4's middleware doesn't depend on
 * `../auth/auth` (created in Task 5) — `auth.ts` will satisfy this shape
 * without either module referencing the other directly.
 */
export type SessionFetcher = {
  api: {
    getSession: (ctx: { headers: Headers }) => Promise<null | {
      user: Record<string, unknown> & {
        id: string;
        email: string;
        name: string;
        emailVerified: boolean;
      };
      session: Record<string, unknown> & { id: string };
    }>;
  };
};
