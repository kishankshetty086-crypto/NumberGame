const { createApp } = require('../src/server');

let app = null;

module.exports = async (req, res) => {
  try {
    if (!app) {
      app = createApp();
    }
    return await app(req, res);
  } catch (err) {
    console.error('Vercel handler error:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    }
    res.end(JSON.stringify({ error: err?.message || 'Serverless handler error' }));
  }
};
