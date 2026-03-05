const tokenCache = {
  accessToken: null,
  expiresAt: 0,
};

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export async function getMsAccessToken() {
  const now = Date.now();
  if (tokenCache.accessToken && now < tokenCache.expiresAt - 60_000) {
    return tokenCache.accessToken;
  }

  const tenantId = requiredEnv('TENANT_ID');
  const clientId = requiredEnv('CLIENT_ID');
  const clientSecret = requiredEnv('CLIENT_SECRET');
  const scope = process.env.GRAPH_SCOPE || 'https://graph.microsoft.com/.default';

  const url = `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope,
  });

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Microsoft token request failed (${resp.status}): ${errText}`);
  }

  const json = await resp.json();
  if (!json.access_token) {
    throw new Error('Microsoft token response missing access_token');
  }

  const expiresInSec = Number(json.expires_in) || 3599;
  tokenCache.accessToken = json.access_token;
  tokenCache.expiresAt = now + expiresInSec * 1000;
  return tokenCache.accessToken;
}

