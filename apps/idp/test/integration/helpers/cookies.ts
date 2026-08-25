/** Minimal cookie jar: absorbs Set-Cookie headers, emits a Cookie header. */
export class CookieJar {
  private readonly jar = new Map<string, string>();

  absorb(headers: Headers): this {
    for (const raw of headers.getSetCookie()) {
      const [pair] = raw.split(";");
      if (!pair) continue;
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === "" || /max-age=0/i.test(raw)) this.jar.delete(name);
      else this.jar.set(name, value);
    }
    return this;
  }

  get(name: string): string | undefined {
    return this.jar.get(name);
  }

  names(): string[] {
    return [...this.jar.keys()];
  }

  header(): string {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  headers(extra: Record<string, string> = {}): Headers {
    return new Headers({
      cookie: this.header(),
      origin: "http://localhost:8787",
      ...extra,
    });
  }
}
