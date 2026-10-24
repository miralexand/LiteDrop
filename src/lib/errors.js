'use strict';

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code || 'HTTP_ERROR';
  }
}

function asyncRoute(handler) {
  return function wrapped(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

module.exports = { HttpError, asyncRoute };
