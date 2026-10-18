/**
 * נותן הרשאת אדמין לחשבון קיים ומאומת (נרשם ביומן הניהול).
 * שימוש מתיקיית הפרויקט: npm run admin:grant -- you@example.com
 * עובד מול ה-DB שמוגדר ב-.env (DATABASE_URL, או קובץ SQLite מקומי).
 */
require('dotenv').config();
const { initDataStore } = require('../src/server/dataStore');
const { initAdminStore } = require('../src/server/adminStore');

(async () => {
  const email = String(process.argv[2] || '').trim().toLowerCase();
  if (!email) {
    console.error('שימוש: npm run admin:grant -- you@example.com');
    process.exit(1);
  }
  let store;
  try {
    store = await initDataStore();
    const admin = await initAdminStore(store);
    const user = await store.findUserForLogin(email);
    if (!user || !user.email_verified_at || user.deleted_at) {
      console.error(`אין חשבון פעיל ומאומת לכתובת ${email}. צריך להירשם ולאמת את הכתובת קודם.`);
      process.exitCode = 1;
    } else {
      const granted = await admin.grantAdmin(user.id, 'script', { id: null, email: 'script' });
      console.log(granted ? `${email} הוא עכשיו אדמין.` : `${email} כבר אדמין.`);
    }
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    if (store && store.pool) await store.pool.end();
  }
})();
