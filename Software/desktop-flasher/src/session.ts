export const SESSION_RESTORE_TIMEOUT = "SESSION_RESTORE_TIMEOUT";

type SessionAuth = {
  getSession(): Promise<{ data: { session: { access_token: string } | null }; error: { message: string } | null }>;
};

export function createSessionRestorer<Account>(auth: SessionAuth | null, exchange: (token: string) => Promise<Account>, timeoutMs = 15000) {
  let pending: Promise<Account | null> | null = null;
  return (): Promise<Account | null> => {
    if (pending) return pending;
    pending = (async () => {
      if (!auth) return null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const { data, error } = await Promise.race([
        auth.getSession(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(SESSION_RESTORE_TIMEOUT)), timeoutMs);
        }),
      ]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
      if (error) throw new Error(error.message);
      if (!data.session) return null;
      return exchange(data.session.access_token);
    })().finally(() => { pending = null; });
    return pending;
  };
}
