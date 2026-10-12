// Shared auth guard for the routes added with the transactions ledger and
// the features built on it. Same behaviour as the per-file copies in the
// older route modules (portfolioRoutes.js etc.): 401 without a valid token,
// otherwise req.user = { id, email }.
const { readAuthUserFromRequest, getJwtSecret } = require('./authRoutes');

function requireAuth(req, res, next) {
  try {
    const authUser = readAuthUserFromRequest(req, getJwtSecret());
    if (!authUser) return res.status(401).json({ error: 'נדרשת התחברות' });
    req.user = { id: authUser.id, email: authUser.email };
    return next();
  } catch {
    return res.status(401).json({ error: 'פג תוקף או טוקן לא תקין' });
  }
}

module.exports = { requireAuth };
