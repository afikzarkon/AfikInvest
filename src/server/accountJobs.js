// The daily account maintenance job ('accounts.maintenance', run by the
// scheduler in .github/workflows/scheduled-jobs.yml):
//
//   1. Deletes for good every account whose 14-day grace period is over -
//      the user row, and with it (ON DELETE CASCADE) every row the user
//      had - and tells the address it is done.
//   2. Reminds accounts whose deletion is one to two days away, once each.
//   3. Clears expired sessions and one-time tokens older than 30 days.
//
// Safe to run more than once a day: each step only acts on what is due.
const { hashToken } = require('./authHelpers');

const DAY_MS = 86400 * 1000;

async function runAccountMaintenance({ accounts, mailer, now = () => new Date(), logger = console }) {
  const at = now();
  const result = { purged: 0, reminded: 0, prunedSessions: 0, prunedTokens: 0 };

  for (const user of await accounts.listUsersDueForPurge(at.toISOString())) {
    try {
      if (await accounts.purgeUser(user.id)) {
        result.purged += 1;
        // The address is all that is left, and only for this message.
        await mailer.sendAccountEmail(user.email, 'accountPurged').catch((err) => logger.error('accounts/purged-email', err && err.message));
      }
    } catch (err) {
      logger.error('accounts/purge', user.id, err && err.message);
    }
  }

  const soon = await accounts.listUsersPurgingBetween(new Date(at.getTime() + DAY_MS).toISOString(), new Date(at.getTime() + 2 * DAY_MS).toISOString());
  for (const user of soon) {
    // One reminder per deletion: a marker token, gone when the account is.
    const marker = hashToken(`deletion-reminder:${user.id}:${user.purgeAfter}`);
    if (await accounts.findToken(marker, 'deletion_reminder')) continue;
    await accounts.createToken({ tokenHash: marker, purpose: 'deletion_reminder', userId: user.id, ttlMs: 3 * DAY_MS, replace: false });
    const { getAppUrl } = require('./emailService');
    await mailer
      .sendAccountEmail(user.email, 'deletionReminder', { purgeAfter: user.purgeAfter, loginUrl: `${getAppUrl()}/` })
      .then(() => {
        result.reminded += 1;
      })
      .catch((err) => logger.error('accounts/reminder-email', err && err.message));
  }

  const monthAgo = new Date(at.getTime() - 30 * DAY_MS).toISOString();
  result.prunedSessions = await accounts.pruneSessions(monthAgo);
  result.prunedTokens = await accounts.pruneTokens(monthAgo);
  return result;
}

module.exports = { runAccountMaintenance };
