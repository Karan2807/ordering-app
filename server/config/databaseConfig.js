const DEFAULT_LOCAL_URIS = {
  development: 'mongodb://127.0.0.1:27017/ordermanager_dev',
  test: 'mongodb://127.0.0.1:27017/ordermanager_test',
};

export function getNodeEnv() {
  return process.env.NODE_ENV || 'development';
}

export function isProduction() {
  return getNodeEnv() === 'production';
}

export function getMongoUri() {
  if (isProduction()) {
    if (!process.env.MONGODB_URI) {
      throw new Error('MONGODB_URI is required when NODE_ENV=production.');
    }
    return process.env.MONGODB_URI;
  }

  const env = getNodeEnv();
  const fallback = DEFAULT_LOCAL_URIS[env] || DEFAULT_LOCAL_URIS.development;
  return process.env.MONGODB_URI_LOCAL || fallback;
}

