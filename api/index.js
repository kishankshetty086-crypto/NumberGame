const { createApp } = require('../src/server');

const app = createApp();

module.exports = (req, res) => app(req, res);
