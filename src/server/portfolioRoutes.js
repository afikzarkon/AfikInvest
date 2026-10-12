const { readAuthUserFromRequest, getJwtSecret } = require('./authRoutes');

const emptyPortfolio = () => ({
  israeliStocks: [],
  americanStocks: [],
  pensionFunds: [],
  bankBalances: [],
  cashFunds: [],
  bankSavingsFunds: []
});

function requireAuth(req, res, next) {
  try {
    const authUser = readAuthUserFromRequest(req, getJwtSecret());
    if (!authUser) return res.status(401).json({ error: 'נדרשת התחברות' });
    req.user = { id: authUser.id, email: authUser.email };
    next();
  } catch {
    return res.status(401).json({ error: 'פג תוקף או טוקן לא תקין' });
  }
}

function mountPortfolioRoutes(app, store) {
  app.get('/api/portfolio', requireAuth, async (req, res) => {
    try {
      const raw = await store.getPortfolioPayload(req.user.id);
      if (!raw) {
        return res.json(emptyPortfolio());
      }
      const data = JSON.parse(raw);
      return res.json({
        israeliStocks: Array.isArray(data.israeliStocks) ? data.israeliStocks : [],
        americanStocks: Array.isArray(data.americanStocks) ? data.americanStocks : [],
        pensionFunds: Array.isArray(data.pensionFunds) ? data.pensionFunds : [],
        bankBalances: Array.isArray(data.bankBalances) ? data.bankBalances : [],
        cashFunds: Array.isArray(data.cashFunds) ? data.cashFunds : [],
        bankSavingsFunds: Array.isArray(data.bankSavingsFunds) ? data.bankSavingsFunds : []
      });
    } catch {
      return res.status(500).json({ error: 'שגיאת שרת' });
    }
  });

  app.put('/api/portfolio', requireAuth, async (req, res) => {
    try {
      const body = req.body || {};
      const snapshot = {
        israeliStocks: Array.isArray(body.israeliStocks) ? body.israeliStocks : [],
        americanStocks: Array.isArray(body.americanStocks) ? body.americanStocks : [],
        pensionFunds: Array.isArray(body.pensionFunds) ? body.pensionFunds : [],
        bankBalances: Array.isArray(body.bankBalances) ? body.bankBalances : [],
        cashFunds: Array.isArray(body.cashFunds) ? body.cashFunds : [],
        bankSavingsFunds: Array.isArray(body.bankSavingsFunds) ? body.bankSavingsFunds : []
      };
      const payload = JSON.stringify(snapshot);
      await store.upsertPortfolio(req.user.id, payload);
      return res.json({ ok: true });
    } catch {
      return res.status(500).json({ error: 'שגיאת שרת' });
    }
  });
}

module.exports = { mountPortfolioRoutes };
