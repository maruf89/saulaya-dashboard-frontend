// Where the API lives. '/api' = the same site: nginx passes /api/ on to the API container (see deploy/).
// To use a separate address instead, e.g. https://api.saulaya.com, set it here and allow this site in the API's CORS_ORIGIN.
window.SAULAYA = { api: '/api' };
