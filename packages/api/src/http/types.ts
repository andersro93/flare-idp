/**
 * `AppEnv`/`AppVariables`/`SessionUser` for the whole facade. Deliberately a
 * structural type here rather than importing Better-Auth's `User`/`Session`
 * types: Task 4 (this module) has no dependency on the production `auth`
 * singleton (that lands in Task 5), and coupling these to Better-Auth's
 * inferred types would make http/* depend on a module that doesn't exist
 * yet. Task 5's `app-shared.ts` re-exports these unchanged.
 */
export type SessionUser = {
  id: string;
  email: string;
  name: string;
  image?: string | null;
  emailVerified: boolean;
  role: string;
  createdAt: Date;
};

export type SessionRecord = { id: string } & Record<string, unknown>;

export type AppVariables = {
  user: SessionUser | null;
  session: SessionRecord | null;
};

export type AppEnv = {
  Bindings: Env;
  Variables: AppVariables;
};
