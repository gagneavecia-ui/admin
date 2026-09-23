module.exports = async function handler(request, response) {
  return response.status(200).json({
    file: 'api/version.js',
    deployedAt: new Date().toISOString(),
    node: process.version,
    env: {
      hasCredentials: Boolean(process.env.FIREBASE_ADMIN_CREDENTIALS),
      credentialsLength: (process.env.FIREBASE_ADMIN_CREDENTIALS || '').length,
      credentialsStart: (process.env.FIREBASE_ADMIN_CREDENTIALS || '').slice(0, 80),
      credentialsEnd: (process.env.FIREBASE_ADMIN_CREDENTIALS || '').slice(-80)
    }
  });
};
