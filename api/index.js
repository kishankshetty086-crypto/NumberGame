let app = null;

module.exports = async (req, res) => {
  try {
    if (!app) {
      const { createApp } = require('../src/gameServer');
      app = createApp();
    }
    return await app(req, res);
  } catch (err) {
    console.error('Vercel handler error:', err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
    }
    res.end(
      JSON.stringify({
        error: err && err.message ? err.message : 'Serverless handler error',
        stack: err && err.stack ? err.stack : undefined,
      })
    );
  }
};
