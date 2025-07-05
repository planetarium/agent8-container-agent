export function parseCookies(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  const items = cookieHeader.split(";").map((cookie) => cookie.trim());

  for (const item of items) {
    const [name, ...rest] = item.split("=");
    if (name && rest) {
      const decodedName = decodeURIComponent(name.trim());
      const decodedValue = decodeURIComponent(rest.join("=").trim());
      cookies[decodedName] = decodedValue;
    }
  }

  return cookies;
}
